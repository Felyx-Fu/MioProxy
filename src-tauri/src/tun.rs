use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use std::os::windows::{ffi::OsStrExt, fs::MetadataExt};

#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime, State};
use tokio::sync::Mutex as AsyncMutex;

use crate::{config, mihomo, system_proxy};

const STATE_FILE: &str = "tun-state.json";
static TRANSITION_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());

pub(crate) async fn lock_transitions() -> tokio::sync::MutexGuard<'static, ()> {
    TRANSITION_LOCK.lock().await
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TunStatus {
    #[default]
    Disabled,
    Starting,
    Running,
    Stopping,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSnapshot {
    pub default_route: Value,
    pub dns_servers: Value,
    pub adapters: Value,
    pub mihomo_running: bool,
    pub captured_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunStatusSnapshot {
    pub status: TunStatus,
    pub message: Option<String>,
    pub admin: bool,
    pub profile_id: Option<String>,
    pub snapshot: Option<NetworkSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedTunState {
    previous_override: String,
    profile_id: String,
    snapshot: NetworkSnapshot,
}

#[derive(Debug, Clone, Default)]
struct TunRuntime {
    status: TunStatus,
    message: Option<String>,
    profile_id: Option<String>,
    previous_override: Option<String>,
    snapshot: Option<NetworkSnapshot>,
    recovery_blocked: bool,
}

#[derive(Default)]
pub struct TunState {
    runtime: Mutex<TunRuntime>,
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(STATE_FILE))
}

#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

#[cfg(windows)]
fn ensure_not_reparse(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(format!("拒绝写入 Reparse Point 路径：{}", path.display()));
    }
    Ok(())
}

#[cfg(not(windows))]
fn ensure_not_reparse(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn replace_file(temp: &Path, path: &Path) -> Result<(), String> {
    let source = temp
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(temp: &Path, path: &Path) -> Result<(), String> {
    fs::rename(temp, path).map_err(|e| e.to_string())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        ensure_not_reparse(parent)?;
    }
    ensure_not_reparse(path)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("无法生成临时文件名：{}", path.display()))?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("无法确定临时文件目录：{}", path.display()))?;
    let mut temp = None;
    for _ in 0..8 {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|e| format!("生成临时文件名失败：{e}"))?;
        let suffix = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let candidate = parent.join(format!(".{file_name}.{suffix}.tmp"));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut file) => {
                let result = file
                    .write_all(bytes)
                    .and_then(|_| file.flush())
                    .and_then(|_| file.sync_all());
                if let Err(error) = result {
                    drop(file);
                    let _ = fs::remove_file(&candidate);
                    return Err(error.to_string());
                }
                if let Err(error) = ensure_not_reparse(&candidate) {
                    drop(file);
                    let _ = fs::remove_file(&candidate);
                    return Err(error);
                }
                temp = Some(candidate);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    let temp = temp.ok_or_else(|| "无法创建唯一临时文件".to_string())?;
    if let Err(error) = replace_file(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    Ok(())
}

fn write_persisted(app: &AppHandle, state: &PersistedTunState) -> Result<(), String> {
    let path = state_path(app)?;
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    write_atomic(&path, &bytes)
}

fn read_persisted(app: &AppHandle) -> Result<Option<PersistedTunState>, String> {
    let path = state_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path).map_err(|e| format!("读取 TUN 恢复状态失败：{e}"))?;
    serde_json::from_str(&content)
        .map(Some)
        .map_err(|e| format!("TUN 恢复状态损坏：{e}"))
}

fn clear_persisted(app: &AppHandle) -> Result<(), String> {
    let path = state_path(app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(windows)]
fn is_admin() -> bool {
    unsafe { windows_sys::Win32::UI::Shell::IsUserAnAdmin() != 0 }
}

#[cfg(not(windows))]
fn is_admin() -> bool {
    false
}

fn powershell_json(script: &str) -> Result<Value, String> {
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output()
        .map_err(|e| format!("读取 Windows 网络状态失败：{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "读取 Windows 网络状态失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    serde_json::from_str(if value.is_empty() { "[]" } else { &value })
        .map_err(|e| format!("解析 Windows 网络状态失败：{e}"))
}

const TUN_INTERFACE_READY_SCRIPT: &str = r#"
$adapter = Get-NetAdapter -Name 'MioProxy' -ErrorAction SilentlyContinue
[bool]($adapter -and $adapter.Status -eq 'Up') | ConvertTo-Json -Compress
"#;

pub(crate) async fn wait_for_tun_ready() -> Result<(), String> {
    for _ in 0..30 {
        if powershell_json(TUN_INTERFACE_READY_SCRIPT)?
            .as_bool()
            .unwrap_or(false)
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err("Mihomo 未创建状态为 Up 的 MioProxy TUN 网卡".to_string())
}

pub(crate) async fn capture_snapshot() -> Result<NetworkSnapshot, String> {
    let mihomo_running = mihomo::is_running().await;
    if !mihomo_running {
        return Err("Mihomo 未运行，无法创建 TUN 运行前快照".to_string());
    }
    let default_route = powershell_json(
        "$routes = @(Get-NetRoute -PolicyStore ActiveStore | Where-Object { $_.DestinationPrefix -in @('0.0.0.0/0', '::/0') } | ForEach-Object { $route = $_; $interface = Get-NetIPInterface -InterfaceIndex $route.InterfaceIndex -AddressFamily $route.AddressFamily -ErrorAction SilentlyContinue | Select-Object -First 1; $interfaceMetric = if ($null -eq $interface) { 0 } else { [int]$interface.InterfaceMetric }; [pscustomobject]@{ DestinationPrefix = $route.DestinationPrefix; InterfaceAlias = $route.InterfaceAlias; InterfaceIndex = $route.InterfaceIndex; NextHop = $route.NextHop; RouteMetric = [int]$route.RouteMetric; InterfaceMetric = $interfaceMetric; EffectiveMetric = [int]$route.RouteMetric + $interfaceMetric; AddressFamily = $route.AddressFamily } } | Group-Object DestinationPrefix | ForEach-Object { $_.Group | Sort-Object EffectiveMetric,RouteMetric,InterfaceIndex | Select-Object -First 1 }); $routes | ConvertTo-Json -Compress",
    )?;
    let dns_servers = powershell_json(
        "Get-DnsClientServerAddress | Where-Object { $_.AddressFamily -in @(2, 23) -and $_.ServerAddresses } | Select-Object InterfaceAlias,AddressFamily,ServerAddresses | ConvertTo-Json -Compress",
    )?;
    let adapters = powershell_json(
        "Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | Select-Object Name,InterfaceDescription,ifIndex,MacAddress,Status | ConvertTo-Json -Compress",
    )?;
    Ok(NetworkSnapshot {
        default_route,
        dns_servers,
        adapters,
        mihomo_running,
        captured_at: timestamp(),
    })
}

fn runtime_snapshot(state: &TunState) -> Result<TunRuntime, String> {
    state
        .runtime
        .lock()
        .map(|runtime| runtime.clone())
        .map_err(|_| "TUN 状态锁异常".to_string())
}

fn response(state: &TunState) -> Result<TunStatusSnapshot, String> {
    let runtime = runtime_snapshot(state)?;
    Ok(TunStatusSnapshot {
        status: runtime.status,
        message: runtime.message,
        admin: is_admin(),
        profile_id: runtime.profile_id,
        snapshot: runtime.snapshot,
    })
}

fn set_runtime(state: &TunState, update: impl FnOnce(&mut TunRuntime)) -> Result<(), String> {
    let mut runtime = state
        .runtime
        .lock()
        .map_err(|_| "TUN 状态锁异常".to_string())?;
    update(&mut runtime);
    Ok(())
}

fn requires_recovery(runtime: &TunRuntime) -> bool {
    runtime.recovery_blocked
        || matches!(
            runtime.status,
            TunStatus::Starting | TunStatus::Running | TunStatus::Stopping
        )
        || (runtime.status == TunStatus::Error
            && runtime.previous_override.is_some()
            && runtime.profile_id.is_some()
            && runtime.snapshot.is_some())
}

fn active_runtime(state: &TunState) -> Result<Option<TunRuntime>, String> {
    let runtime = runtime_snapshot(state)?;
    Ok(requires_recovery(&runtime).then_some(runtime))
}

pub(crate) fn is_active<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<TunState>()
        .and_then(|state| active_runtime(&state).ok().flatten())
        .is_some()
}

pub(crate) fn active_profile_id<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    app.try_state::<TunState>()
        .and_then(|state| runtime_snapshot(&state).ok())
        .filter(requires_recovery)
        .and_then(|runtime| runtime.profile_id)
}

fn persisted_for(runtime: &TunRuntime) -> Result<PersistedTunState, String> {
    Ok(PersistedTunState {
        previous_override: runtime
            .previous_override
            .clone()
            .ok_or_else(|| "TUN 缺少恢复用 Override 快照".to_string())?,
        profile_id: runtime
            .profile_id
            .clone()
            .ok_or_else(|| "TUN 缺少恢复用 Profile".to_string())?,
        snapshot: runtime
            .snapshot
            .clone()
            .ok_or_else(|| "TUN 缺少网络快照".to_string())?,
    })
}

fn set_error(state: &TunState, message: String) -> Result<(), String> {
    set_runtime(state, |runtime| {
        runtime.status = TunStatus::Error;
        runtime.message = Some(message);
    })
}

async fn runtime_tun_enabled() -> Option<bool> {
    let value = mihomo::api_get("/configs").await.ok()?;
    value
        .get("tun")
        .and_then(Value::as_object)
        .and_then(|tun| tun.get("enable"))
        .and_then(Value::as_bool)
}

async fn rollback_enable(
    app: &AppHandle,
    state: &TunState,
    profile_id: &str,
    previous_override: &str,
    reason: String,
) -> Result<TunStatusSnapshot, String> {
    let mut recovery_error = None;
    if let Err(error) = config::restore_override_content(app, previous_override) {
        recovery_error = Some(error);
    } else if mihomo::owns_core(app) && mihomo::is_running().await {
        if let Err(error) = config::apply_config(app.clone(), profile_id.to_string()).await {
            recovery_error = Some(error);
        }
    } else if let Err(error) = config::restore_profile_config(app, profile_id) {
        recovery_error = Some(error);
    }
    if recovery_error.is_none() {
        if let Err(error) = clear_persisted(app) {
            recovery_error = Some(error);
        }
    }
    match recovery_error {
        Some(error) => {
            let message = format!("{reason}；TUN 回滚也失败：{error}");
            set_error(state, message.clone())?;
            Err(message)
        }
        None => {
            let message = format!("{reason}；已恢复原始配置");
            set_runtime(state, |current| {
                *current = TunRuntime {
                    status: TunStatus::Disabled,
                    message: Some(message.clone()),
                    ..TunRuntime::default()
                };
            })?;
            Err(message)
        }
    }
}

async fn enable_tun(
    app: &AppHandle,
    state: &TunState,
    profile_id: String,
) -> Result<TunStatusSnapshot, String> {
    let current = runtime_snapshot(state)?;
    if matches!(current.status, TunStatus::Running) {
        if mihomo::owns_core(app) && mihomo::is_running().await {
            return response(state);
        }
        return disable_tun(app, state).await;
    }
    if matches!(current.status, TunStatus::Starting | TunStatus::Stopping) {
        return Err("TUN 正在切换，请稍候".to_string());
    }
    if current.status == TunStatus::Error && active_runtime(state)?.is_some() {
        return Err("TUN 仍有待恢复状态，请先执行停止/恢复".to_string());
    }
    if profile_id.trim().is_empty() {
        return Err("请先选择已下载的 Profile".to_string());
    }
    if !is_admin() {
        set_error(state, "需要管理员权限才能启用 Windows TUN".to_string())?;
        return Err("需要管理员权限才能启用 Windows TUN".to_string());
    }
    if !mihomo::is_running().await || !mihomo::owns_core(app) {
        set_error(state, "请先启动 Mihomo，再启用 TUN".to_string())?;
        return Err("请先启动 Mihomo，再启用 TUN".to_string());
    }
    if system_proxy::status(app).await?.enabled {
        set_error(
            state,
            "TUN 与系统代理不能同时开启，请先关闭系统代理".to_string(),
        )?;
        return Err("TUN 与系统代理不能同时开启，请先关闭系统代理".to_string());
    }
    if config::configured_tun_enabled_at(
        &app.path().app_data_dir().map_err(|e| e.to_string())?,
        &profile_id,
    )? || runtime_tun_enabled().await == Some(true)
    {
        set_error(
            state,
            "当前配置或 Mihomo 已经启用了 TUN，请先恢复后再开始托管会话".to_string(),
        )?;
        return Err("当前配置或 Mihomo 已经启用了 TUN，请先恢复后再开始托管会话".to_string());
    }

    let previous_override = config::override_content(app)?;
    let snapshot = capture_snapshot().await?;
    let runtime = TunRuntime {
        status: TunStatus::Starting,
        message: None,
        profile_id: Some(profile_id.clone()),
        previous_override: Some(previous_override.clone()),
        snapshot: Some(snapshot.clone()),
        ..TunRuntime::default()
    };
    set_runtime(state, |current| *current = runtime.clone())?;
    if let Err(error) = write_persisted(app, &persisted_for(&runtime)?) {
        let _ = set_runtime(state, |current| *current = TunRuntime::default());
        return Err(format!("保存 TUN 恢复状态失败：{error}"));
    }

    if let Err(error) = config::set_tun_enabled(app, true) {
        return rollback_enable(
            app,
            state,
            &profile_id,
            &previous_override,
            format!("写入 TUN 配置失败：{error}"),
        )
        .await;
    }
    if let Err(error) = config::apply_config(app.clone(), profile_id.clone()).await {
        return rollback_enable(
            app,
            state,
            &profile_id,
            &previous_override,
            format!("Mihomo 校验或加载 TUN 配置失败：{error}"),
        )
        .await;
    }
    if !mihomo::is_running().await
        || !mihomo::owns_core(app)
        || runtime_tun_enabled().await != Some(true)
    {
        return rollback_enable(
            app,
            state,
            &profile_id,
            &previous_override,
            "TUN 配置加载后未确认运行".to_string(),
        )
        .await;
    }
    if let Err(error) = wait_for_tun_ready().await {
        return rollback_enable(
            app,
            state,
            &profile_id,
            &previous_override,
            format!("TUN 网卡启动失败：{error}"),
        )
        .await;
    }

    let baseline = match capture_snapshot().await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            return rollback_enable(
                app,
                state,
                &profile_id,
                &previous_override,
                format!("TUN 网卡就绪后无法建立网络基线：{error}"),
            )
            .await;
        }
    };

    set_runtime(state, |current| {
        current.status = TunStatus::Running;
        current.message = None;
        current.snapshot = Some(baseline);
    })?;
    let running = runtime_snapshot(state)?;
    if let Err(error) = write_persisted(app, &persisted_for(&running)?) {
        return rollback_enable(
            app,
            state,
            &profile_id,
            &previous_override,
            format!("保存 TUN 运行状态失败：{error}"),
        )
        .await;
    }
    response(state)
}

async fn disable_tun(app: &AppHandle, state: &TunState) -> Result<TunStatusSnapshot, String> {
    let Some(active) = active_runtime(state)? else {
        set_runtime(state, |runtime| {
            runtime.status = TunStatus::Disabled;
            runtime.message = None;
        })?;
        return response(state);
    };
    if active.recovery_blocked {
        return Err(active.message.unwrap_or_else(|| {
            "TUN 恢复状态无法读取；请修复或移除 tun-state.json 后重启应用".to_string()
        }));
    }
    let profile_id = active
        .profile_id
        .clone()
        .ok_or_else(|| "TUN 缺少恢复用 Profile".to_string())?;
    let previous_override = active
        .previous_override
        .clone()
        .ok_or_else(|| "TUN 缺少恢复用 Override 快照".to_string())?;
    set_runtime(state, |runtime| {
        runtime.status = TunStatus::Stopping;
        runtime.message = None;
    })?;
    if let Err(error) = config::restore_override_content(app, &previous_override) {
        set_error(state, format!("写入 TUN 停止配置失败：{error}"))?;
        return Err(error);
    }
    if mihomo::owns_core(app) && mihomo::is_running().await {
        if profile_id.trim().is_empty() {
            let message = "停止 TUN 缺少当前 Profile，已保留禁用配置；请重启 Mihomo 完成清理";
            set_error(state, message.to_string())?;
            return Err(message.to_string());
        }
        if let Err(error) = config::apply_config(app.clone(), profile_id).await {
            set_error(state, format!("Mihomo 停止 TUN 失败：{error}"))?;
            return Err(error);
        }
    } else if let Err(error) = config::restore_profile_config(app, &profile_id) {
        set_error(state, format!("停止 TUN 后恢复稳定配置失败：{error}"))?;
        return Err(error);
    }
    if let Err(error) = clear_persisted(app) {
        set_error(state, format!("清理 TUN 恢复状态失败：{error}"))?;
        return Err(error);
    }
    set_runtime(state, |runtime| *runtime = TunRuntime::default())?;
    response(state)
}

#[tauri::command]
pub async fn tun_status(
    app: AppHandle,
    state: State<'_, TunState>,
) -> Result<TunStatusSnapshot, String> {
    if active_runtime(&state)?.is_some() {
        return response(&state);
    }
    if let Some(snapshot) = crate::service::service_tun_status(&app).await? {
        return Ok(snapshot);
    }
    response(&state)
}

#[tauri::command]
pub async fn tun_set_enabled(
    app: AppHandle,
    state: State<'_, TunState>,
    enabled: bool,
    profile_id: Option<String>,
) -> Result<TunStatusSnapshot, String> {
    crate::ensure_mutations_allowed(&app)?;
    let _transition = lock_transitions().await;
    let system_proxy_enabled = system_proxy::status(&app).await?.enabled;
    if active_runtime(&state)?.is_some() {
        if enabled {
            return Err("GUI TUN 会话仍在运行，请先关闭本地 TUN".to_string());
        }
        return disable_tun(&app, &state).await;
    }
    if let Some(snapshot) =
        crate::service::request_tun(&app, enabled, profile_id.clone(), system_proxy_enabled).await?
    {
        return Ok(snapshot);
    }
    if enabled {
        enable_tun(&app, &state, profile_id.unwrap_or_default()).await
    } else {
        disable_tun(&app, &state).await
    }
}

pub(crate) async fn set_enabled_for_lifecycle(
    app: &AppHandle,
    profile_id: String,
) -> Result<TunStatusSnapshot, String> {
    let state = app.state::<TunState>();
    let _transition = lock_transitions().await;
    let system_proxy_enabled = system_proxy::status(app).await?.enabled;
    if active_runtime(&state)?.is_some() {
        return response(&state);
    }
    if system_proxy_enabled {
        return Err("更新后检测到 System Proxy 仍开启，拒绝恢复 GUI TUN".to_string());
    }
    enable_tun(app, &state, profile_id).await
}

pub async fn restore_for_lifecycle(app: &AppHandle, state: &TunState) -> Result<(), String> {
    let _transition = lock_transitions().await;
    let runtime = runtime_snapshot(state)?;
    let persisted = read_persisted(app)?.or_else(|| persisted_for(&runtime).ok());
    let Some(persisted) = persisted else {
        return Ok(());
    };
    config::restore_override_content(app, &persisted.previous_override)?;
    if mihomo::owns_core(app) && mihomo::is_running().await {
        config::apply_config(app.clone(), persisted.profile_id.clone()).await?;
    } else {
        config::restore_profile_config(app, &persisted.profile_id)?;
    }
    clear_persisted(app)?;
    set_runtime(state, |current| {
        *current = TunRuntime {
            status: TunStatus::Disabled,
            message: Some("TUN 原始配置已恢复".to_string()),
            ..TunRuntime::default()
        };
    })?;
    Ok(())
}

pub async fn on_mihomo_exit(app: &AppHandle) {
    let _transition = lock_transitions().await;
    let Some(state) = app.try_state::<TunState>() else {
        return;
    };
    let runtime = runtime_snapshot(&state).ok();
    let persisted = match read_persisted(app) {
        Ok(persisted) => persisted.or_else(|| {
            runtime
                .as_ref()
                .and_then(|runtime| persisted_for(runtime).ok())
        }),
        Err(error) => {
            let _ = set_error(
                &state,
                format!("Mihomo 异常退出，TUN 恢复状态损坏：{error}"),
            );
            return;
        }
    };
    let Some(persisted) = persisted else {
        return;
    };
    let result = config::restore_override_content(app, &persisted.previous_override)
        .and_then(|_| config::restore_profile_config(app, &persisted.profile_id));
    if result.is_ok() {
        let _ = clear_persisted(app);
    }
    match result {
        Ok(()) => {
            let _ = set_runtime(&state, |current| {
                *current = TunRuntime {
                    status: TunStatus::Disabled,
                    message: Some("Mihomo 异常退出，TUN 配置已回滚".to_string()),
                    ..TunRuntime::default()
                };
            });
        }
        Err(error) => {
            let _ = set_runtime(&state, |current| {
                current.status = TunStatus::Error;
                current.message = Some(format!("Mihomo 异常退出，TUN 配置回滚失败：{error}"));
                current.profile_id = Some(persisted.profile_id);
                current.previous_override = Some(persisted.previous_override);
                current.snapshot = Some(persisted.snapshot);
            });
        }
    }
}

pub async fn recover_after_startup(app: AppHandle) {
    let _transition = lock_transitions().await;
    let Some(state) = app.try_state::<TunState>() else {
        return;
    };
    let persisted = match read_persisted(&app) {
        Ok(Some(persisted)) => persisted,
        Ok(None) => return,
        Err(error) => {
            let _ = set_runtime(&state, |current| {
                *current = TunRuntime {
                    status: TunStatus::Error,
                    message: Some(format!(
                        "{error}；无法确认 TUN 是否已恢复，请修复或移除 tun-state.json 后重启应用"
                    )),
                    recovery_blocked: true,
                    ..TunRuntime::default()
                };
            });
            return;
        }
    };
    let restore = config::restore_override_content(&app, &persisted.previous_override);
    let apply = if restore.is_ok() && mihomo::owns_core(&app) && mihomo::is_running().await {
        config::apply_config(app.clone(), persisted.profile_id.clone())
            .await
            .map(|_| ())
    } else if restore.is_ok() {
        config::restore_profile_config(&app, &persisted.profile_id)
    } else {
        restore.map(|_| ())
    };
    match apply {
        Ok(()) => {
            let _ = clear_persisted(&app);
            let _ = set_runtime(&state, |current| {
                *current = TunRuntime {
                    status: TunStatus::Disabled,
                    message: Some("上次 TUN 会话异常结束，已恢复原始配置".to_string()),
                    ..TunRuntime::default()
                };
            });
        }
        Err(error) => {
            let _ = set_runtime(&state, |current| {
                current.status = TunStatus::Error;
                current.message = Some(format!("TUN 启动恢复失败：{error}"));
                current.profile_id = Some(persisted.profile_id);
                current.previous_override = Some(persisted.previous_override);
                current.snapshot = Some(persisted.snapshot);
            });
        }
    }
}

pub fn start_monitor(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_tick = Instant::now();
        let mut was_active = false;
        loop {
            tokio::time::sleep(Duration::from_secs(12)).await;
            let Some(state) = app.try_state::<TunState>() else {
                return;
            };
            let transition = lock_transitions().await;
            let Ok(Some(runtime)) = active_runtime(&state) else {
                was_active = false;
                continue;
            };
            if !mihomo::is_running().await || !mihomo::owns_core(&app) {
                drop(transition);
                on_mihomo_exit(&app).await;
                was_active = false;
                continue;
            }
            if !was_active {
                last_tick = Instant::now();
                was_active = true;
            }
            let wake_gap = last_tick.elapsed() > Duration::from_secs(30);
            last_tick = Instant::now();
            let Ok(current) = capture_snapshot().await else {
                continue;
            };
            let changed = wake_gap
                || runtime
                    .snapshot
                    .as_ref()
                    .map(|previous| {
                        previous.default_route != current.default_route
                            || previous.dns_servers != current.dns_servers
                            || previous.adapters != current.adapters
                    })
                    .unwrap_or(false);
            if !changed {
                continue;
            }
            let Some(profile_id) = runtime.profile_id.clone() else {
                continue;
            };
            let refreshed_snapshot = current;
            let _ = set_runtime(&state, |current| {
                current.status = TunStatus::Starting;
                current.message = Some("检测到网络变化，正在重新绑定 TUN 路由".to_string());
            });
            match config::apply_config(app.clone(), profile_id).await {
                Ok(_) => {
                    let baseline = capture_snapshot().await.unwrap_or(refreshed_snapshot);
                    let _ = set_runtime(&state, |current| {
                        current.status = TunStatus::Running;
                        current.message = None;
                        current.snapshot = Some(baseline);
                    });
                    if let Ok(current) = runtime_snapshot(&state) {
                        if let Ok(persisted) = persisted_for(&current) {
                            let _ = write_persisted(&app, &persisted);
                        }
                    }
                }
                Err(error) => {
                    let _ = set_error(&state, format!("网络变化后重载 TUN 失败：{error}"));
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{requires_recovery, NetworkSnapshot, TunRuntime, TunStatus};

    #[test]
    fn corrupted_persisted_state_blocks_normal_tun_operations() {
        let runtime = TunRuntime {
            status: TunStatus::Error,
            recovery_blocked: true,
            ..TunRuntime::default()
        };

        assert!(requires_recovery(&runtime));
    }

    #[test]
    fn network_snapshot_preserves_structured_network_state() {
        let snapshot = serde_json::from_str::<NetworkSnapshot>(
            r#"{
                "defaultRoute": {"interfaceIndex": 7, "nextHop": "192.168.1.1"},
                "dnsServers": [{"interfaceAlias": "Wi-Fi", "serverAddresses": ["1.1.1.1"]}],
                "adapters": [],
                "mihomoRunning": true,
                "capturedAt": 123
            }"#,
        )
        .unwrap();
        assert_eq!(snapshot.default_route["interfaceIndex"], 7);
        assert_eq!(snapshot.dns_servers[0]["interfaceAlias"], "Wi-Fi");
        assert!(snapshot.adapters.is_array());
    }

    #[test]
    fn network_snapshot_reads_legacy_string_fields() {
        let snapshot = serde_json::from_str::<NetworkSnapshot>(
            r#"{
                "defaultRoute": "{}",
                "dnsServers": "[]",
                "adapters": "[]",
                "mihomoRunning": true,
                "capturedAt": 123
            }"#,
        )
        .unwrap();
        assert!(snapshot.default_route.is_string());
        assert!(snapshot.dns_servers.is_string());
        assert!(snapshot.adapters.is_string());
    }
}
