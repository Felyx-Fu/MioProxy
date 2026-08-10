use std::{path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use windows_sys::Win32::Networking::WinInet::{
    InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
};
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

use crate::mihomo;

const INTERNET_SETTINGS_PATH: &str =
    "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const UPDATE_SNAPSHOT_FILE: &str = "update-system-proxy-state.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxySnapshot {
    proxy_enable: Option<u32>,
    proxy_server: Option<String>,
    proxy_override: Option<String>,
    auto_config_url: Option<String>,
    auto_detect: Option<u32>,
}

#[derive(Default)]
pub struct SystemProxyState {
    snapshot: Mutex<Option<ProxySnapshot>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemProxyStatus {
    /// True only while the Windows resource is currently owned by MioProxy.
    pub enabled: bool,
    pub core_running: bool,
    pub mixed_port: u16,
    pub proxy_server: Option<String>,
    pub managed: bool,
    pub desired_enabled: bool,
    pub actual_state: ProxyActualState,
    pub owner: ProxyOwner,
    pub external_detected: bool,
    pub windows_state: ProxyWindowsState,
    pub state_consistent: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProxyActualState {
    Disabled,
    MioProxyEndpoint,
    ExternalEndpoint,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProxyOwner {
    MioProxy,
    External,
    None,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum ProxyWindowsState {
    #[serde(rename = "disabled")]
    Disabled,
    #[serde(rename = "mioproxy")]
    MioProxy,
    #[serde(rename = "external")]
    External,
}

fn settings_key() -> Result<RegKey, String> {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(
            INTERNET_SETTINGS_PATH,
            winreg::enums::KEY_READ | winreg::enums::KEY_WRITE,
        )
        .map_err(|e| format!("读取 Windows 代理设置失败：{e}"))
}

fn read_snapshot() -> Result<ProxySnapshot, String> {
    let key = settings_key()?;
    Ok(ProxySnapshot {
        proxy_enable: key.get_value("ProxyEnable").ok(),
        proxy_server: key.get_value("ProxyServer").ok(),
        proxy_override: key.get_value("ProxyOverride").ok(),
        auto_config_url: key.get_value("AutoConfigURL").ok(),
        auto_detect: key.get_value("AutoDetect").ok(),
    })
}

fn delete_value(key: &RegKey, name: &str) {
    let _ = key.delete_value(name);
}

fn write_optional_string(key: &RegKey, name: &str, value: &Option<String>) -> Result<(), String> {
    if let Some(value) = value {
        key.set_value(name, value).map_err(|e| e.to_string())
    } else {
        delete_value(key, name);
        Ok(())
    }
}

fn write_snapshot(snapshot: &ProxySnapshot) -> Result<(), String> {
    let key = settings_key()?;
    if let Some(value) = snapshot.proxy_enable {
        key.set_value("ProxyEnable", &value)
            .map_err(|e| e.to_string())?;
    } else {
        delete_value(&key, "ProxyEnable");
    }
    write_optional_string(&key, "ProxyServer", &snapshot.proxy_server)?;
    write_optional_string(&key, "ProxyOverride", &snapshot.proxy_override)?;
    write_optional_string(&key, "AutoConfigURL", &snapshot.auto_config_url)?;
    if let Some(value) = snapshot.auto_detect {
        key.set_value("AutoDetect", &value)
            .map_err(|e| e.to_string())?;
    } else {
        delete_value(&key, "AutoDetect");
    }
    notify_settings_changed();
    Ok(())
}

fn write_mioproxy_settings(mixed_port: u16, original: &ProxySnapshot) -> Result<(), String> {
    let key = settings_key()?;
    key.set_value("ProxyEnable", &1u32)
        .map_err(|e| e.to_string())?;
    key.set_value("ProxyServer", &format!("127.0.0.1:{mixed_port}"))
        .map_err(|e| e.to_string())?;
    let override_value = original
        .proxy_override
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("<local>");
    key.set_value("ProxyOverride", &override_value)
        .map_err(|e| e.to_string())?;
    delete_value(&key, "AutoConfigURL");
    delete_value(&key, "AutoDetect");
    notify_settings_changed();
    Ok(())
}

fn notify_settings_changed() {
    unsafe {
        let _ = InternetSetOptionW(
            std::ptr::null_mut(),
            INTERNET_OPTION_SETTINGS_CHANGED,
            std::ptr::null_mut(),
            0,
        );
        let _ = InternetSetOptionW(
            std::ptr::null_mut(),
            INTERNET_OPTION_REFRESH,
            std::ptr::null_mut(),
            0,
        );
    }
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("system-proxy-state.json"))
}

fn update_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(UPDATE_SNAPSHOT_FILE))
}

fn persist_snapshot(app: &AppHandle, snapshot: &ProxySnapshot) -> Result<(), String> {
    let path = state_path(app)?;
    let bytes = serde_json::to_vec_pretty(snapshot).map_err(|e| e.to_string())?;
    crate::config::write_atomic(&path, &bytes)
}

fn read_persisted_snapshot(app: &AppHandle) -> Result<Option<ProxySnapshot>, String> {
    let path = state_path(app)?;
    let Some(content) = crate::config::read_text_file_at(&path, "读取代理状态恢复文件")?
    else {
        return Ok(None);
    };
    serde_json::from_str(&content)
        .map(Some)
        .map_err(|e| format!("代理状态恢复文件损坏：{e}"))
}

fn read_update_snapshot(app: &AppHandle) -> Result<Option<ProxySnapshot>, String> {
    let path = update_state_path(app)?;
    let Some(content) = crate::config::read_text_file_at(&path, "读取更新代理恢复文件")?
    else {
        return Ok(None);
    };
    serde_json::from_str(&content)
        .map(Some)
        .map_err(|e| format!("更新代理恢复文件损坏：{e}"))
}

fn clear_update_snapshot(app: &AppHandle) -> Result<(), String> {
    let path = update_state_path(app)?;
    crate::config::remove_file(&path, "删除更新代理恢复文件")
}

fn clear_persisted_snapshot(app: &AppHandle) -> Result<(), String> {
    let path = state_path(app)?;
    crate::config::remove_file(&path, "删除代理状态恢复文件")
}

fn is_mioproxy_proxy(snapshot: &ProxySnapshot, mixed_port: u16) -> bool {
    let endpoint = format!("127.0.0.1:{mixed_port}");
    snapshot.proxy_enable == Some(1) && snapshot.proxy_server.as_deref() == Some(endpoint.as_str())
}

fn should_restore_lifecycle_snapshot(current: &ProxySnapshot, mixed_port: u16) -> bool {
    is_mioproxy_proxy(current, mixed_port)
}

fn windows_state(snapshot: &ProxySnapshot, mixed_port: u16) -> ProxyWindowsState {
    if snapshot.proxy_enable != Some(1) {
        ProxyWindowsState::Disabled
    } else if is_mioproxy_proxy(snapshot, mixed_port) {
        ProxyWindowsState::MioProxy
    } else {
        ProxyWindowsState::External
    }
}

fn actual_state(snapshot: &ProxySnapshot, mixed_port: u16) -> ProxyActualState {
    if snapshot.proxy_enable != Some(1) {
        return ProxyActualState::Disabled;
    }
    if is_mioproxy_proxy(snapshot, mixed_port) {
        return ProxyActualState::MioProxyEndpoint;
    }
    if snapshot
        .proxy_server
        .as_deref()
        .is_some_and(|endpoint| !endpoint.trim().is_empty())
    {
        ProxyActualState::ExternalEndpoint
    } else {
        ProxyActualState::Unknown
    }
}

fn owner(actual: ProxyActualState, has_mioproxy_snapshot: bool) -> ProxyOwner {
    match actual {
        ProxyActualState::Disabled => ProxyOwner::None,
        ProxyActualState::ExternalEndpoint => ProxyOwner::External,
        ProxyActualState::MioProxyEndpoint if has_mioproxy_snapshot => ProxyOwner::MioProxy,
        ProxyActualState::MioProxyEndpoint | ProxyActualState::Unknown => ProxyOwner::Unknown,
    }
}

fn is_mioproxy_owned(owner: ProxyOwner) -> bool {
    owner == ProxyOwner::MioProxy
}

fn managed_snapshot_present(app: &AppHandle) -> Result<bool, String> {
    let in_memory = if let Some(state) = app.try_state::<SystemProxyState>() {
        state
            .snapshot
            .lock()
            .map_err(|_| "System Proxy 状态锁异常")?
            .is_some()
    } else {
        false
    };
    Ok(in_memory || read_persisted_snapshot(app)?.is_some())
}

pub async fn recover_stale_state(app: &AppHandle) -> Result<(), String> {
    let Some(snapshot) = read_persisted_snapshot(app)? else {
        return Ok(());
    };
    let current = read_snapshot()?;
    let mixed_port = match mihomo::mixed_port(app) {
        Ok(mixed_port) => mixed_port,
        Err(error) => {
            eprintln!("无法确认 MioProxy System Proxy 端口，保留恢复快照：{error}");
            crate::diagnostics::record_event(app, "warn", "system-proxy", error);
            return Ok(());
        }
    };

    if !is_mioproxy_proxy(&current, mixed_port) {
        eprintln!("检测到非 MioProxy 当前代理状态，保留 System Proxy 期望状态但不恢复");
        crate::diagnostics::record_event(
            app,
            "info",
            "system-proxy",
            "Retained desired System Proxy state because Windows state is externally owned",
        );
        return Ok(());
    }

    if mihomo::is_running().await {
        let state = app.state::<SystemProxyState>();
        *state
            .snapshot
            .lock()
            .map_err(|_| "System Proxy 状态锁异常")? = Some(snapshot);
        eprintln!("Mihomo 仍在运行，保留当前 System Proxy 并延后恢复快照");
        crate::diagnostics::record_event(
            app,
            "info",
            "system-proxy",
            "Retained MioProxy System Proxy while Mihomo is running",
        );
        return Ok(());
    }

    write_snapshot(&snapshot)?;
    clear_persisted_snapshot(app)?;
    Ok(())
}

pub(crate) fn is_enabled_for_update(app: &AppHandle) -> Result<bool, String> {
    let current = read_snapshot()?;
    let mixed_port = mihomo::mixed_port(app)?;
    Ok(can_disable_for_update(
        &current,
        mixed_port,
        managed_snapshot_present(app)?,
    ))
}

fn can_disable_for_update(current: &ProxySnapshot, mixed_port: u16, managed: bool) -> bool {
    managed && is_mioproxy_proxy(current, mixed_port)
}

fn can_restore_after_update(current: &ProxySnapshot) -> bool {
    current.proxy_enable != Some(1)
}

pub(crate) fn is_managed_for_update(app: &AppHandle) -> Result<bool, String> {
    let state = app.state::<SystemProxyState>();
    Ok(state
        .snapshot
        .lock()
        .map_err(|_| "System Proxy 状态锁异常")?
        .is_some()
        || read_persisted_snapshot(app)?.is_some()
        || read_update_snapshot(app)?.is_some())
}

pub(crate) fn disable_for_update(app: &AppHandle) -> Result<bool, String> {
    let current = read_snapshot()?;
    let mixed_port = mihomo::mixed_port(app)?;
    if !can_disable_for_update(&current, mixed_port, managed_snapshot_present(app)?) {
        return Ok(false);
    }
    let key = settings_key()?;
    key.set_value("ProxyEnable", &0u32)
        .map_err(|e| format!("关闭更新前系统代理失败：{e}"))?;
    notify_settings_changed();
    Ok(true)
}

pub(crate) fn restore_after_update_failure(app: &AppHandle) -> Result<(), String> {
    if let Some(snapshot) = read_update_snapshot(app)? {
        let current = read_snapshot()?;
        if can_restore_after_update(&current) {
            write_snapshot(&snapshot)?;
        } else {
            crate::diagnostics::record_event(
                app,
                "info",
                "system-proxy",
                "Skipped update System Proxy restore because another client owns the current endpoint",
            );
        }
        clear_update_snapshot(app)?;
        return Ok(());
    }
    if let Some(snapshot) = read_persisted_snapshot(app)? {
        write_snapshot(&snapshot)?;
        clear_persisted_snapshot(app)?;
        if let Some(state) = app.try_state::<SystemProxyState>() {
            *state
                .snapshot
                .lock()
                .map_err(|_| "System Proxy 状态锁异常")? = None;
        }
    }
    Ok(())
}

pub(crate) fn restore_after_update_success(app: &AppHandle) -> Result<(), String> {
    restore_after_update_failure(app)
}

async fn restore_for_lifecycle_inner(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<SystemProxyState>();
    let snapshot = state
        .snapshot
        .lock()
        .map_err(|_| "System Proxy 状态锁异常")?
        .clone()
        .or(read_persisted_snapshot(app)?);
    if let Some(snapshot) = snapshot {
        let current = read_snapshot()?;
        let mixed_port = mihomo::mixed_port(app)?;
        if should_restore_lifecycle_snapshot(&current, mixed_port) {
            write_snapshot(&snapshot)?;
            crate::diagnostics::record_event(
                app,
                "info",
                "system-proxy",
                "Restored System Proxy snapshot still owned by MioProxy",
            );
        } else {
            crate::diagnostics::record_event(
                app,
                "info",
                "system-proxy",
                "Skipped System Proxy restore because ownership moved to another client",
            );
        }
        clear_persisted_snapshot(app)?;
        *state
            .snapshot
            .lock()
            .map_err(|_| "System Proxy 状态锁异常")? = None;
    }
    if let Ok(next) = status(app).await {
        crate::tray::update_proxy_label(app, next.enabled, next.core_running);
    }
    Ok(())
}

pub async fn restore_for_lifecycle(app: &AppHandle) -> Result<(), String> {
    let _transition = crate::tun::lock_transitions().await;
    restore_for_lifecycle_inner(app).await
}

pub async fn restore_after_core_exit(app: &AppHandle) {
    let _ = restore_for_lifecycle(app).await;
}

pub async fn set_enabled(app: AppHandle, enabled: bool) -> Result<SystemProxyStatus, String> {
    crate::ensure_mutations_allowed(&app)?;
    let _transition = crate::tun::lock_transitions().await;
    if enabled {
        if let Some(service_status) = crate::service::request_service_status(&app).await? {
            if service_status.tun_status != "disabled" {
                return Err("MioProxy Service 正在管理 TUN，不能同时开启系统代理".to_string());
            }
            if !service_status.owns_core || !service_status.core.running {
                return Err("当前 Mihomo 未由 MioProxy Service 管理，拒绝开启系统代理".to_string());
            }
        } else {
            if crate::tun::is_active(&app) {
                return Err("TUN 已开启，不能同时开启系统代理".to_string());
            }
            if !mihomo::owns_core(&app) || !mihomo::is_running().await {
                return Err("当前 Mihomo 未由 MioProxy 管理，拒绝开启系统代理".to_string());
            }
        }

        let state = app.state::<SystemProxyState>();
        let current = read_snapshot()?;
        let mixed_port = mihomo::mixed_port(&app)?;
        let endpoint = format!("127.0.0.1:{mixed_port}");
        let owned_by_mioproxy = current.proxy_enable == Some(1)
            && current.proxy_server.as_deref() == Some(endpoint.as_str())
            && (state
                .snapshot
                .lock()
                .map_err(|_| "System Proxy 状态锁异常")?
                .is_some()
                || read_persisted_snapshot(&app)?.is_some());
        if owned_by_mioproxy {
            return status(&app).await;
        }

        let snapshot = current;
        persist_snapshot(&app, &snapshot)?;
        if let Err(error) = write_mioproxy_settings(mixed_port, &snapshot) {
            let restore_error = write_snapshot(&snapshot).err();
            let clear_error = clear_persisted_snapshot(&app).err();
            let mut details = format!("开启系统代理失败：{error}");
            if let Some(restore_error) = restore_error {
                details.push_str(&format!("；恢复 Windows 原始代理也失败：{restore_error}"));
            }
            if let Some(clear_error) = clear_error {
                details.push_str(&format!("；清理代理恢复快照失败：{clear_error}"));
            }
            return Err(details);
        }
        let verified = read_snapshot()?;
        if !is_mioproxy_proxy(&verified, mixed_port) {
            let restore_error = write_snapshot(&snapshot).err();
            let clear_error = clear_persisted_snapshot(&app).err();
            let mut details = "开启系统代理失败：Windows 未确认 MioProxy endpoint".to_string();
            if let Some(error) = restore_error {
                details.push_str(&format!("；恢复 Windows 原始代理也失败：{error}"));
            }
            if let Some(error) = clear_error {
                details.push_str(&format!("；清理代理恢复快照失败：{error}"));
            }
            return Err(details);
        }
        *state
            .snapshot
            .lock()
            .map_err(|_| "System Proxy 状态锁异常")? = Some(snapshot);
        crate::diagnostics::record_event(&app, "info", "system-proxy", "System Proxy enabled");
    } else {
        restore_for_lifecycle_inner(&app).await?;
        crate::diagnostics::record_event(&app, "info", "system-proxy", "System Proxy restored");
    }
    let result = status(&app).await;
    if let Ok(next) = &result {
        crate::tray::update_proxy_label(&app, next.enabled, next.core_running);
    }
    result
}

pub async fn status(app: &AppHandle) -> Result<SystemProxyStatus, String> {
    let snapshot = read_snapshot()?;
    let mixed_port = mihomo::mixed_port(app)?;
    let (managed, core_running) =
        if let Some(service_status) = crate::service::request_service_status(app).await? {
            (
                service_status.owns_core,
                service_status.owns_core && service_status.core.running,
            )
        } else {
            let managed = mihomo::owns_core(app);
            (managed, managed && mihomo::is_running().await)
        };
    let desired_enabled = managed_snapshot_present(app)?;
    let actual_state = actual_state(&snapshot, mixed_port);
    let owner = owner(actual_state, desired_enabled);
    let windows_state = windows_state(&snapshot, mixed_port);
    let enabled = is_mioproxy_owned(owner);
    Ok(SystemProxyStatus {
        enabled,
        core_running,
        mixed_port,
        proxy_server: snapshot.proxy_server,
        managed,
        desired_enabled,
        actual_state,
        owner,
        external_detected: owner == ProxyOwner::External,
        windows_state,
        state_consistent: desired_enabled == enabled,
    })
}

#[tauri::command]
pub async fn system_proxy_status(app: AppHandle) -> Result<SystemProxyStatus, String> {
    status(&app).await
}

#[tauri::command]
pub async fn system_proxy_set_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<SystemProxyStatus, String> {
    set_enabled(app, enabled).await
}

#[cfg(test)]
mod tests {
    use super::{
        actual_state, can_disable_for_update, can_restore_after_update, is_mioproxy_owned,
        is_mioproxy_proxy, owner, should_restore_lifecycle_snapshot, windows_state,
        ProxyActualState, ProxyOwner, ProxySnapshot, ProxyWindowsState,
    };

    fn snapshot(proxy_enable: Option<u32>, proxy_server: Option<&str>) -> ProxySnapshot {
        ProxySnapshot {
            proxy_enable,
            proxy_server: proxy_server.map(str::to_string),
            proxy_override: None,
            auto_config_url: None,
            auto_detect: None,
        }
    }

    #[test]
    fn recognizes_only_the_expected_mioproxy_endpoint() {
        assert!(is_mioproxy_proxy(
            &snapshot(Some(1), Some("127.0.0.1:7890")),
            7890
        ));
        assert!(!is_mioproxy_proxy(
            &snapshot(Some(0), Some("127.0.0.1:7890")),
            7890
        ));
        assert!(!is_mioproxy_proxy(
            &snapshot(Some(1), Some("127.0.0.1:7891")),
            7890
        ));
    }

    #[test]
    fn lifecycle_restore_preserves_an_external_takeover() {
        assert!(should_restore_lifecycle_snapshot(
            &snapshot(Some(1), Some("127.0.0.1:7891")),
            7891
        ));
        assert!(!should_restore_lifecycle_snapshot(
            &snapshot(Some(1), Some("127.0.0.1:7890")),
            7891
        ));
    }

    #[test]
    fn distinguishes_mioproxy_and_external_windows_proxy_state() {
        assert_eq!(
            windows_state(&snapshot(Some(0), Some("127.0.0.1:7890")), 7890),
            ProxyWindowsState::Disabled
        );
        assert_eq!(
            windows_state(&snapshot(Some(1), Some("127.0.0.1:7890")), 7890),
            ProxyWindowsState::MioProxy
        );
        assert_eq!(
            windows_state(&snapshot(Some(1), Some("127.0.0.1:8080")), 7890),
            ProxyWindowsState::External
        );
    }

    #[test]
    fn distinguishes_desired_actual_and_owner() {
        assert_eq!(
            actual_state(&snapshot(Some(1), Some("127.0.0.1:7890")), 7890),
            ProxyActualState::MioProxyEndpoint
        );
        assert_eq!(
            owner(ProxyActualState::MioProxyEndpoint, true),
            ProxyOwner::MioProxy
        );
        assert_eq!(
            owner(ProxyActualState::ExternalEndpoint, false),
            ProxyOwner::External
        );
        assert_eq!(owner(ProxyActualState::Disabled, false), ProxyOwner::None);
    }

    #[test]
    fn external_proxy_never_presents_as_mioproxy_enabled() {
        let actual = actual_state(&snapshot(Some(1), Some("127.0.0.1:7890")), 7893);
        let owner = owner(actual, true);
        assert_eq!(actual, ProxyActualState::ExternalEndpoint);
        assert_eq!(owner, ProxyOwner::External);
        assert!(!is_mioproxy_owned(owner));
    }

    #[test]
    fn update_never_disables_an_external_proxy() {
        let external = snapshot(Some(1), Some("127.0.0.1:7890"));
        assert!(!can_disable_for_update(&external, 7893, false));
        assert!(!can_disable_for_update(&external, 7893, true));
        let owned = snapshot(Some(1), Some("127.0.0.1:7893"));
        assert!(can_disable_for_update(&owned, 7893, true));
    }

    #[test]
    fn update_restore_preserves_an_external_takeover() {
        assert!(can_restore_after_update(&snapshot(Some(0), None)));
        assert!(!can_restore_after_update(&snapshot(
            Some(1),
            Some("127.0.0.1:7890")
        )));
    }
}
