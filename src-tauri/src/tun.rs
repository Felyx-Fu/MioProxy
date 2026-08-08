use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::{config, mihomo, system_proxy};

const STATE_FILE: &str = "tun-state.json";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TunStatus {
    Disabled,
    Starting,
    Running,
    Stopping,
    Error,
}

impl Default for TunStatus {
    fn default() -> Self {
        Self::Disabled
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSnapshot {
    pub default_route: String,
    pub dns_servers: String,
    pub adapters: String,
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

fn write_persisted(app: &AppHandle, state: &PersistedTunState) -> Result<(), String> {
    let path = state_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp = path.with_extension("tmp");
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    fs::rename(temp, path).map_err(|e| e.to_string())
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

fn powershell(script: &str) -> Result<String, String> {
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
    Ok(if value.is_empty() {
        "[]".to_string()
    } else {
        value
    })
}

pub(crate) async fn capture_snapshot() -> Result<NetworkSnapshot, String> {
    let mihomo_running = mihomo::is_running().await;
    if !mihomo_running {
        return Err("Mihomo 未运行，无法创建 TUN 运行前快照".to_string());
    }
    let default_route = powershell(
        "Get-NetRoute -DestinationPrefix '0.0.0.0/0' -PolicyStore ActiveStore | Sort-Object RouteMetric | Select-Object -First 1 | Select-Object InterfaceAlias,InterfaceIndex,NextHop,RouteMetric | ConvertTo-Json -Compress",
    )?;
    let dns_servers = powershell(
        "Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object { $_.ServerAddresses } | Select-Object InterfaceAlias,ServerAddresses | ConvertTo-Json -Compress",
    )?;
    let adapters = powershell(
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

fn active_runtime(state: &TunState) -> Result<Option<TunRuntime>, String> {
    let runtime = runtime_snapshot(state)?;
    Ok(matches!(
        runtime.status,
        TunStatus::Starting | TunStatus::Running | TunStatus::Stopping
    )
    .then_some(runtime))
}

pub(crate) fn is_active(app: &AppHandle) -> bool {
    app.try_state::<TunState>()
        .and_then(|state| active_runtime(&state).ok().flatten())
        .is_some()
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
    } else if mihomo::is_running().await {
        if let Err(error) = config::apply_config(app.clone(), profile_id.to_string()).await {
            recovery_error = Some(error);
        }
    }
    if recovery_error.is_none() {
        let _ = clear_persisted(app);
    }
    let message = match recovery_error {
        Some(error) => format!("{reason}；TUN 回滚也失败：{error}"),
        None => format!("{reason}；已恢复原始配置"),
    };
    set_error(state, message.clone())?;
    Err(message)
}

async fn enable_tun(
    app: &AppHandle,
    state: &TunState,
    profile_id: String,
) -> Result<TunStatusSnapshot, String> {
    let current = runtime_snapshot(state)?;
    if matches!(current.status, TunStatus::Running) {
        return response(state);
    }
    if matches!(current.status, TunStatus::Starting | TunStatus::Stopping) {
        return Err("TUN 正在切换，请稍候".to_string());
    }
    if profile_id.trim().is_empty() {
        return Err("请先选择已下载的 Profile".to_string());
    }
    if !is_admin() {
        set_error(state, "需要管理员权限才能启用 Windows TUN".to_string())?;
        return Err("需要管理员权限才能启用 Windows TUN".to_string());
    }
    if !mihomo::is_running().await {
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

    let previous_override = config::override_content(app)?;
    let snapshot = capture_snapshot().await?;
    let runtime = TunRuntime {
        status: TunStatus::Starting,
        message: None,
        profile_id: Some(profile_id.clone()),
        previous_override: Some(previous_override.clone()),
        snapshot: Some(snapshot.clone()),
    };
    set_runtime(state, |current| *current = runtime.clone())?;
    write_persisted(app, &persisted_for(&runtime)?)?;

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
    if !mihomo::is_running().await || runtime_tun_enabled().await == Some(false) {
        return rollback_enable(
            app,
            state,
            &profile_id,
            &previous_override,
            "TUN 配置加载后未确认运行".to_string(),
        )
        .await;
    }

    set_runtime(state, |current| {
        current.status = TunStatus::Running;
        current.message = None;
    })?;
    response(state)
}

async fn disable_tun(
    app: &AppHandle,
    state: &TunState,
    profile_id: Option<String>,
) -> Result<TunStatusSnapshot, String> {
    let Some(active) = active_runtime(state)? else {
        set_runtime(state, |runtime| {
            runtime.status = TunStatus::Disabled;
            runtime.message = None;
        })?;
        return response(state);
    };
    let profile_id = profile_id.or(active.profile_id.clone()).unwrap_or_default();
    set_runtime(state, |runtime| {
        runtime.status = TunStatus::Stopping;
        runtime.message = None;
    })?;
    if let Err(error) = config::set_tun_enabled(app, false) {
        set_error(state, format!("写入 TUN 停止配置失败：{error}"))?;
        return Err(error);
    }
    if mihomo::is_running().await {
        if profile_id.trim().is_empty() {
            let message = "停止 TUN 缺少当前 Profile，已保留禁用配置；请重启 Mihomo 完成清理";
            set_error(state, message.to_string())?;
            return Err(message.to_string());
        }
        if let Err(error) = config::apply_config(app.clone(), profile_id).await {
            set_error(state, format!("Mihomo 停止 TUN 失败：{error}"))?;
            return Err(error);
        }
    }
    let _ = clear_persisted(app);
    set_runtime(state, |runtime| *runtime = TunRuntime::default())?;
    response(state)
}

#[tauri::command]
pub async fn tun_status(
    app: AppHandle,
    state: State<'_, TunState>,
) -> Result<TunStatusSnapshot, String> {
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
    let system_proxy_enabled = system_proxy::status(&app).await?.enabled;
    if let Some(snapshot) =
        crate::service::request_tun(&app, enabled, profile_id.clone(), system_proxy_enabled).await?
    {
        return Ok(snapshot);
    }
    if enabled {
        enable_tun(&app, &state, profile_id.unwrap_or_default()).await
    } else {
        disable_tun(&app, &state, profile_id).await
    }
}

pub async fn restore_for_lifecycle(app: &AppHandle, state: &TunState) -> Result<(), String> {
    let runtime = runtime_snapshot(state)?;
    let persisted = read_persisted(app)?.or_else(|| persisted_for(&runtime).ok());
    let Some(persisted) = persisted else {
        return Ok(());
    };
    config::restore_override_content(app, &persisted.previous_override)?;
    if mihomo::is_running().await {
        config::apply_config(app.clone(), persisted.profile_id).await?;
    }
    clear_persisted(app)?;
    set_runtime(state, |current| *current = TunRuntime::default())?;
    Ok(())
}

pub async fn on_mihomo_exit(app: &AppHandle) {
    let Some(state) = app.try_state::<TunState>() else {
        return;
    };
    let runtime = runtime_snapshot(&state).ok();
    let persisted = read_persisted(app).ok().flatten().or_else(|| {
        runtime
            .as_ref()
            .and_then(|runtime| persisted_for(runtime).ok())
    });
    let Some(persisted) = persisted else {
        return;
    };
    let result = config::restore_override_content(app, &persisted.previous_override);
    if result.is_ok() {
        let _ = clear_persisted(app);
    }
    let message = match result {
        Ok(()) => "Mihomo 异常退出，TUN 配置已回滚".to_string(),
        Err(error) => format!("Mihomo 异常退出，TUN 配置回滚失败：{error}"),
    };
    let _ = set_runtime(&state, |current| {
        current.status = TunStatus::Error;
        current.message = Some(message);
        current.profile_id = Some(persisted.profile_id);
        current.previous_override = Some(persisted.previous_override);
        current.snapshot = Some(persisted.snapshot);
    });
}

pub async fn recover_after_startup(app: AppHandle) {
    let Some(state) = app.try_state::<TunState>() else {
        return;
    };
    let Ok(Some(persisted)) = read_persisted(&app) else {
        return;
    };
    let restore = config::restore_override_content(&app, &persisted.previous_override);
    let apply = if restore.is_ok() && mihomo::is_running().await {
        config::apply_config(app.clone(), persisted.profile_id.clone())
            .await
            .map(|_| ())
    } else {
        restore.map(|_| ())
    };
    let message = match apply {
        Ok(()) => {
            let _ = clear_persisted(&app);
            "上次 TUN 会话异常结束，已恢复原始配置".to_string()
        }
        Err(error) => format!("TUN 启动恢复失败：{error}"),
    };
    let _ = set_runtime(&state, |current| {
        current.status = TunStatus::Error;
        current.message = Some(message);
        current.profile_id = Some(persisted.profile_id);
        current.previous_override = Some(persisted.previous_override);
        current.snapshot = Some(persisted.snapshot);
    });
}

pub fn start_monitor(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(12)).await;
            let Some(state) = app.try_state::<TunState>() else {
                return;
            };
            let Ok(Some(runtime)) = active_runtime(&state) else {
                continue;
            };
            if !mihomo::is_running().await {
                on_mihomo_exit(&app).await;
                continue;
            }
            let Ok(current) = capture_snapshot().await else {
                continue;
            };
            let changed = runtime
                .snapshot
                .as_ref()
                .map(|previous| {
                    previous.default_route != current.default_route
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
                    let _ = set_runtime(&state, |current| {
                        current.status = TunStatus::Running;
                        current.message = None;
                        current.snapshot = Some(refreshed_snapshot.clone());
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
