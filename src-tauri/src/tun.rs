use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use std::os::windows::{ffi::OsStrExt, fs::MetadataExt, process::CommandExt};

#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};

#[cfg(windows)]
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime, State};
use tokio::sync::Mutex as AsyncMutex;

use crate::{config, mihomo};

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

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TunActualState {
    Disabled,
    MioProxyTun,
    ExternalTun,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TunOwner {
    MioProxy,
    External,
    None,
    Unknown,
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
    pub desired_enabled: bool,
    pub actual_state: TunActualState,
    pub owner: TunOwner,
    pub external_detected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedTunState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous_override: Option<String>,
    profile_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    snapshot: Option<NetworkSnapshot>,
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
    let Some(content) = config::read_text_file_at(&path, "读取 TUN 恢复状态")? else {
        return Ok(None);
    };
    serde_json::from_str(&content)
        .map(Some)
        .map_err(|e| format!("TUN 恢复状态损坏：{e}"))
}

fn clear_persisted(app: &AppHandle) -> Result<(), String> {
    let path = state_path(app)?;
    config::remove_file(&path, "删除 TUN 恢复状态")
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
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
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

const FOREIGN_TUN_CONFLICT_SCRIPT: &str = r#"
$candidates = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object {
  $_.Status -eq 'Up' -and $_.Name -ne 'MioProxy' -and
  ($_.Name -match '(?i)(clash|mihomo|mimo|meta.*tunnel|wintun|\btun\b)' -or $_.InterfaceDescription -match '(?i)(clash|mihomo|mimo|meta.*tunnel|wintun|\btun\b)')
})
$conflicts = @($candidates | Where-Object {
  $adapter = $_
  $defaultRoute = Get-NetRoute -PolicyStore ActiveStore -InterfaceIndex $adapter.ifIndex -ErrorAction SilentlyContinue |
    Where-Object { $_.DestinationPrefix -in @('0.0.0.0/0', '::/0') } | Select-Object -First 1
  $dns = Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ErrorAction SilentlyContinue |
    Where-Object { $_.ServerAddresses } | Select-Object -First 1
  $null -ne $defaultRoute -or $null -ne $dns
} | Select-Object -ExpandProperty Name)
$conflicts | ConvertTo-Json -Compress
"#;

pub(crate) fn foreign_tun_conflict() -> Result<Option<String>, String> {
    let names = powershell_json(FOREIGN_TUN_CONFLICT_SCRIPT)?;
    let names = match names {
        Value::String(name) => vec![name],
        Value::Array(items) => items
            .into_iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        Value::Null => Vec::new(),
        _ => return Err("解析外部 TUN 检测结果失败".to_string()),
    };
    Ok((!names.is_empty()).then(|| {
        format!(
            "检测到另一虚拟代理网卡正在接管系统路由或 DNS（{}）。请先关闭其他客户端的 TUN 模式。",
            names.join("、")
        )
    }))
}

async fn capture_network_snapshot(mihomo_running: bool) -> Result<NetworkSnapshot, String> {
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

pub(crate) async fn capture_snapshot() -> Result<NetworkSnapshot, String> {
    let mihomo_running = mihomo::is_running().await;
    if !mihomo_running {
        return Err("Mihomo 未运行，无法创建 TUN 运行前快照".to_string());
    }
    capture_network_snapshot(mihomo_running).await
}

pub(crate) async fn diagnostic_network_snapshot() -> Result<NetworkSnapshot, String> {
    capture_network_snapshot(mihomo::is_running().await).await
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
    let (actual_state, owner) = tun_state_for_status(runtime.status);
    let desired_enabled = requires_recovery(&runtime);
    Ok(TunStatusSnapshot {
        status: runtime.status,
        message: runtime.message,
        admin: is_admin(),
        profile_id: runtime.profile_id,
        snapshot: runtime.snapshot,
        desired_enabled,
        actual_state,
        owner,
        external_detected: false,
    })
}

pub(crate) fn tun_state_for_status(status: TunStatus) -> (TunActualState, TunOwner) {
    match status {
        TunStatus::Starting | TunStatus::Running | TunStatus::Stopping => {
            (TunActualState::MioProxyTun, TunOwner::MioProxy)
        }
        TunStatus::Disabled => (TunActualState::Disabled, TunOwner::None),
        TunStatus::Error => (TunActualState::Unknown, TunOwner::Unknown),
    }
}

async fn with_external_tun_state(snapshot: TunStatusSnapshot) -> Result<TunStatusSnapshot, String> {
    let foreign_tun_detected = foreign_tun_conflict()?.is_some();
    Ok(with_foreign_tun_detection(snapshot, foreign_tun_detected))
}

fn with_foreign_tun_detection(
    mut snapshot: TunStatusSnapshot,
    foreign_tun_detected: bool,
) -> TunStatusSnapshot {
    if snapshot.status == TunStatus::Disabled && !snapshot.desired_enabled && foreign_tun_detected {
        snapshot.actual_state = TunActualState::ExternalTun;
        snapshot.owner = TunOwner::External;
        snapshot.external_detected = true;
    }
    snapshot
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
        || (runtime.status == TunStatus::Error && runtime.profile_id.is_some())
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

pub(crate) fn ensure_profile_apply_allowed(app: &AppHandle) -> Result<(), String> {
    let Some(state) = app.try_state::<TunState>() else {
        return Ok(());
    };
    let runtime = runtime_snapshot(&state)?;
    if matches!(runtime.status, TunStatus::Starting | TunStatus::Stopping)
        || (runtime.status == TunStatus::Error && requires_recovery(&runtime))
    {
        return Err("MioProxy TUN 正在切换或等待恢复，暂时不能应用 Profile".to_string());
    }
    Ok(())
}

pub(crate) fn rebind_active_profile(app: &AppHandle, profile_id: &str) -> Result<(), String> {
    let Some(state) = app.try_state::<TunState>() else {
        return Ok(());
    };
    let mut runtime = runtime_snapshot(&state)?;
    if !requires_recovery(&runtime) {
        return Ok(());
    }
    if runtime.status != TunStatus::Running {
        return Err("MioProxy TUN 正在切换或等待恢复，暂时不能应用 Profile".to_string());
    }
    runtime.profile_id = Some(profile_id.to_string());
    set_runtime(&state, |current| *current = runtime.clone())?;
    if let Ok(persisted) = persisted_for(&runtime) {
        if write_persisted(app, &persisted).is_err() {
            crate::diagnostics::record_event(
                app,
                "warn",
                "tun",
                "TUN display profile changed but diagnostic state update failed",
            );
        }
    }
    Ok(())
}

fn persisted_for(runtime: &TunRuntime) -> Result<PersistedTunState, String> {
    Ok(PersistedTunState {
        previous_override: runtime.previous_override.clone(),
        profile_id: runtime
            .profile_id
            .clone()
            .ok_or_else(|| "TUN 缺少恢复用 Profile".to_string())?,
        snapshot: runtime.snapshot.clone(),
    })
}

fn set_error(state: &TunState, message: String) -> Result<(), String> {
    set_runtime(state, |runtime| {
        runtime.status = TunStatus::Error;
        runtime.message = Some(message);
    })
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|error| error.to_string())
}

fn restore_legacy_override(app: &AppHandle, content: Option<&str>) -> Result<(), String> {
    if let Some(content) = content {
        config::restore_override_content(app, content)?;
    }
    Ok(())
}

fn rebuild_runtime_on_disk(
    app: &AppHandle,
    legacy_override: Option<&str>,
) -> Result<PathBuf, String> {
    restore_legacy_override(app, legacy_override)?;
    config::set_tun_enabled(app, false)?;
    let data_dir = app_data_dir(app)?;
    if !config::restore_active_runtime_config_at(&data_dir)? {
        return Err("没有已应用的 Runtime 配置可用于恢复 TUN".to_string());
    }
    Ok(config::config_path_at(&data_dir))
}

async fn load_tun_runtime(app: &AppHandle) -> Result<(), String> {
    let data_dir = app_data_dir(app)?;
    if !config::restore_active_runtime_config_at(&data_dir)? {
        return Err("没有已应用的 Runtime 配置可用于切换 TUN".to_string());
    }
    let path = config::config_path_at(&data_dir);
    mihomo::api_put(
        "/configs?force=true",
        json!({ "path": path.display().to_string() }),
    )
    .await
    .map_err(|error| format!("Mihomo 加载 TUN Runtime 失败：{error}"))?;
    config::verify_controller_runtime(Some(true)).await?;
    mihomo::ensure_managed_core(app).await
}

async fn restore_non_tun_runtime(
    app: &AppHandle,
    legacy_override: Option<&str>,
) -> Result<(), String> {
    let path = rebuild_runtime_on_disk(app, legacy_override)?;
    if mihomo::owns_core(app) {
        mihomo::api_put(
            "/configs?force=true",
            json!({ "path": path.display().to_string() }),
        )
        .await
        .map_err(|error| format!("Mihomo 恢复非 TUN Runtime 失败：{error}"))?;
        config::verify_controller_runtime(Some(false)).await?;
        mihomo::ensure_managed_core(app).await?;
    }
    Ok(())
}

async fn rollback_enable(
    app: &AppHandle,
    state: &TunState,
    reason: String,
) -> Result<TunStatusSnapshot, String> {
    match restore_non_tun_runtime(app, None).await {
        Err(error) => {
            let message = format!("{reason}；TUN 回滚也失败：{error}");
            set_error(state, message.clone())?;
            Err(message)
        }
        Ok(()) => {
            if let Err(error) = clear_persisted(app) {
                let message = format!("{reason}；TUN 已禁用，但清理恢复状态失败：{error}");
                set_error(state, message.clone())?;
                return Err(message);
            }
            let message = format!("{reason}；已恢复非 TUN Runtime");
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
        if mihomo::owns_core(app) && mihomo::ensure_managed_core(app).await.is_ok() {
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
    if let Some(message) = foreign_tun_conflict()? {
        set_error(state, message.clone())?;
        return Err(message);
    }
    if !mihomo::owns_core(app) {
        let message = "当前 Core 不由 GUI 管理，不能通过 GUI 特权路径启用 TUN".to_string();
        set_error(state, message.clone())?;
        return Err(message);
    }
    if let Err(error) = mihomo::ensure_managed_core(app).await {
        let message = format!("Core 尚未 Ready，无法启用 TUN：{error}");
        set_error(state, message.clone())?;
        return Err(message);
    }
    if let Err(error) = config::verify_controller_runtime(Some(false)).await {
        let message = format!("Core 的 TUN 基线不一致，请先恢复：{error}");
        set_error(state, message.clone())?;
        return Err(message);
    }

    let snapshot = capture_snapshot().await.ok();
    let runtime = TunRuntime {
        status: TunStatus::Starting,
        message: None,
        profile_id: Some(profile_id),
        previous_override: None,
        snapshot,
        ..TunRuntime::default()
    };
    set_runtime(state, |current| *current = runtime.clone())?;
    if let Err(error) = write_persisted(app, &persisted_for(&runtime)?) {
        let _ = set_runtime(state, |current| *current = TunRuntime::default());
        return Err(format!("保存 TUN 恢复状态失败：{error}"));
    }

    if let Err(error) = config::set_tun_enabled(app, true) {
        return rollback_enable(app, state, format!("写入 TUN 配置失败：{error}")).await;
    }
    if let Err(error) = load_tun_runtime(app).await {
        return rollback_enable(
            app,
            state,
            format!("Mihomo 校验或加载 TUN 配置失败：{error}"),
        )
        .await;
    }
    if let Err(error) = wait_for_tun_ready().await {
        return rollback_enable(app, state, format!("TUN 网卡启动失败：{error}")).await;
    }
    if let Err(error) = mihomo::ensure_managed_core(app).await {
        return rollback_enable(
            app,
            state,
            format!("TUN 网卡就绪后 Core 未保持 Ready：{error}"),
        )
        .await;
    }

    set_runtime(state, |current| {
        current.status = TunStatus::Running;
        current.message = None;
    })?;
    crate::diagnostics::record_event(app, "info", "tun", "TUN enabled");
    let running = runtime_snapshot(state)?;
    if let Err(error) = write_persisted(app, &persisted_for(&running)?) {
        return rollback_enable(app, state, format!("保存 TUN 运行状态失败：{error}")).await;
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
    if mihomo::owns_core(app) {
        if let Err(error) = mihomo::ensure_managed_core(app).await {
            let message = format!("Core 未保持 Ready，无法确认 TUN 停止事务：{error}");
            set_error(state, message.clone())?;
            return Err(message);
        }
    }
    set_runtime(state, |runtime| {
        runtime.status = TunStatus::Stopping;
        runtime.message = None;
    })?;
    if let Err(error) = restore_non_tun_runtime(app, active.previous_override.as_deref()).await {
        let message = format!("停止 TUN 失败，已保留恢复状态：{error}");
        set_error(state, message.clone())?;
        return Err(message);
    }
    if let Err(error) = clear_persisted(app) {
        set_error(state, format!("清理 TUN 恢复状态失败：{error}"))?;
        return Err(error);
    }
    set_runtime(state, |runtime| *runtime = TunRuntime::default())?;
    crate::diagnostics::record_event(
        app,
        "info",
        "tun",
        "TUN disabled; Core remains managed and Ready",
    );
    response(state)
}

#[tauri::command]
pub async fn tun_status(
    app: AppHandle,
    state: State<'_, TunState>,
) -> Result<TunStatusSnapshot, String> {
    if active_runtime(&state)?.is_some() {
        return with_external_tun_state(response(&state)?).await;
    }
    if let Some(snapshot) = crate::service::service_tun_status(&app).await? {
        return with_external_tun_state(snapshot).await;
    }
    with_external_tun_state(response(&state)?).await
}

pub(crate) async fn diagnostic_status(app: &AppHandle) -> Result<TunStatusSnapshot, String> {
    let state = app.state::<TunState>();
    if active_runtime(&state)?.is_some() {
        return with_external_tun_state(response(&state)?).await;
    }
    if let Some(snapshot) = crate::service::service_tun_status(app).await? {
        return with_external_tun_state(snapshot).await;
    }
    with_external_tun_state(response(&state)?).await
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
    if active_runtime(&state)?.is_some() {
        if enabled {
            return Err("GUI TUN 会话仍在运行，请先关闭本地 TUN".to_string());
        }
        return disable_tun(&app, &state).await;
    }
    if let Some(snapshot) =
        crate::service::request_tun(&app, enabled, profile_id.clone(), false).await?
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
    if active_runtime(&state)?.is_some() {
        return response(&state);
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
    restore_non_tun_runtime(app, persisted.previous_override.as_deref()).await?;
    clear_persisted(app)?;
    set_runtime(state, |current| {
        *current = TunRuntime {
            status: TunStatus::Disabled,
            message: Some("TUN 已禁用并恢复非 TUN Runtime".to_string()),
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
    let result = rebuild_runtime_on_disk(app, persisted.previous_override.as_deref())
        .map(|_| ())
        .and_then(|_| clear_persisted(app));
    match result {
        Ok(()) => {
            let _ = set_runtime(&state, |current| {
                *current = TunRuntime {
                    status: TunStatus::Disabled,
                    message: Some("Mihomo 异常退出，TUN 配置已回滚".to_string()),
                    ..TunRuntime::default()
                };
            });
            crate::diagnostics::record_event(
                app,
                "warn",
                "tun",
                "Recovered TUN state after Mihomo exit",
            );
        }
        Err(error) => {
            let _ = set_runtime(&state, |current| {
                current.status = TunStatus::Error;
                current.message = Some(format!("Mihomo 异常退出，TUN 配置回滚失败：{error}"));
                current.profile_id = Some(persisted.profile_id);
                current.previous_override = persisted.previous_override;
                current.snapshot = persisted.snapshot;
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
    let apply = if mihomo::owns_core(&app) {
        restore_non_tun_runtime(&app, persisted.previous_override.as_deref()).await
    } else {
        rebuild_runtime_on_disk(&app, persisted.previous_override.as_deref()).map(|_| ())
    };
    let apply = apply.and_then(|_| clear_persisted(&app));
    match apply {
        Ok(()) => {
            let _ = set_runtime(&state, |current| {
                *current = TunRuntime {
                    status: TunStatus::Disabled,
                    message: Some("上次 TUN 会话异常结束，已恢复原始配置".to_string()),
                    ..TunRuntime::default()
                };
            });
            crate::diagnostics::record_event(
                &app,
                "warn",
                "tun",
                "Recovered stale TUN state during startup",
            );
        }
        Err(error) => {
            let _ = set_runtime(&state, |current| {
                current.status = TunStatus::Error;
                current.message = Some(format!("TUN 启动恢复失败：{error}"));
                current.profile_id = Some(persisted.profile_id);
                current.previous_override = persisted.previous_override;
                current.snapshot = persisted.snapshot;
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        persisted_for, requires_recovery, with_foreign_tun_detection, NetworkSnapshot,
        PersistedTunState, TunActualState, TunOwner, TunRuntime, TunStatus, TunStatusSnapshot,
    };

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
    fn error_recovery_does_not_require_override_or_network_snapshot() {
        let runtime = TunRuntime {
            status: TunStatus::Error,
            profile_id: Some("profile-a".to_string()),
            ..TunRuntime::default()
        };

        assert!(requires_recovery(&runtime));
        let persisted = persisted_for(&runtime).unwrap();
        assert!(persisted.previous_override.is_none());
        assert!(persisted.snapshot.is_none());
    }

    #[test]
    fn persisted_state_accepts_legacy_override_and_snapshot() {
        let persisted = serde_json::from_str::<PersistedTunState>(
            r#"{
                "previousOverride": "dns: {}",
                "profileId": "legacy-profile",
                "snapshot": {
                    "defaultRoute": {},
                    "dnsServers": [],
                    "adapters": [],
                    "mihomoRunning": true,
                    "capturedAt": 123
                }
            }"#,
        )
        .unwrap();

        assert_eq!(persisted.previous_override.as_deref(), Some("dns: {}"));
        assert!(persisted.snapshot.is_some());
    }

    #[test]
    fn persisted_state_allows_runtime_only_recovery_data() {
        let persisted =
            serde_json::from_str::<PersistedTunState>(r#"{"profileId":"profile-a"}"#).unwrap();

        assert!(persisted.previous_override.is_none());
        assert!(persisted.snapshot.is_none());
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

    #[test]
    fn foreign_tun_is_external_state_not_mioproxy_tun() {
        let snapshot = TunStatusSnapshot {
            status: TunStatus::Disabled,
            message: None,
            admin: true,
            profile_id: None,
            snapshot: None,
            desired_enabled: false,
            actual_state: TunActualState::Disabled,
            owner: TunOwner::None,
            external_detected: false,
        };

        let classified = with_foreign_tun_detection(snapshot, true);
        assert_eq!(classified.status, TunStatus::Disabled);
        assert!(!classified.desired_enabled);
        assert_eq!(classified.actual_state, TunActualState::ExternalTun);
        assert_eq!(classified.owner, TunOwner::External);
        assert!(classified.external_detected);
    }

    #[test]
    fn foreign_tun_does_not_hide_local_recovery_error() {
        let snapshot = TunStatusSnapshot {
            status: TunStatus::Error,
            message: Some("local recovery required".to_string()),
            admin: true,
            profile_id: Some("profile-a".to_string()),
            snapshot: None,
            desired_enabled: true,
            actual_state: TunActualState::Unknown,
            owner: TunOwner::Unknown,
            external_detected: false,
        };

        let classified = with_foreign_tun_detection(snapshot, true);
        assert_eq!(classified.status, TunStatus::Error);
        assert_eq!(classified.actual_state, TunActualState::Unknown);
        assert_eq!(classified.owner, TunOwner::Unknown);
        assert!(!classified.external_detected);
    }
}
