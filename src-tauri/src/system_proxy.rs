use std::{io, path::PathBuf, sync::Mutex};

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    managed_listener_pid: Option<u32>,
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
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProxyOwner {
    MioProxy,
    External,
    None,
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
        managed_listener_pid: None,
    })
}

fn delete_value(key: &RegKey, name: &str) -> Result<(), String> {
    match key.delete_value(name) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除 Windows 代理设置 {name} 失败：{error}")),
    }
}

fn write_optional_string(key: &RegKey, name: &str, value: &Option<String>) -> Result<(), String> {
    if let Some(value) = value {
        key.set_value(name, value).map_err(|e| e.to_string())
    } else {
        delete_value(key, name)
    }
}

fn write_snapshot(snapshot: &ProxySnapshot) -> Result<(), String> {
    let key = settings_key()?;
    if let Some(value) = snapshot.proxy_enable {
        key.set_value("ProxyEnable", &value)
            .map_err(|e| e.to_string())?;
    } else {
        delete_value(&key, "ProxyEnable")?;
    }
    write_optional_string(&key, "ProxyServer", &snapshot.proxy_server)?;
    write_optional_string(&key, "ProxyOverride", &snapshot.proxy_override)?;
    write_optional_string(&key, "AutoConfigURL", &snapshot.auto_config_url)?;
    if let Some(value) = snapshot.auto_detect {
        key.set_value("AutoDetect", &value)
            .map_err(|e| e.to_string())?;
    } else {
        delete_value(&key, "AutoDetect")?;
    }
    notify_settings_changed()?;
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
    delete_value(&key, "AutoConfigURL")?;
    delete_value(&key, "AutoDetect")?;
    notify_settings_changed()?;
    Ok(())
}

fn notify_settings_changed() -> Result<(), String> {
    unsafe {
        if InternetSetOptionW(
            std::ptr::null_mut(),
            INTERNET_OPTION_SETTINGS_CHANGED,
            std::ptr::null_mut(),
            0,
        ) == 0
        {
            return Err(format!(
                "通知 Windows 代理设置变更失败：{}",
                io::Error::last_os_error()
            ));
        }
        if InternetSetOptionW(
            std::ptr::null_mut(),
            INTERNET_OPTION_REFRESH,
            std::ptr::null_mut(),
            0,
        ) == 0
        {
            return Err(format!(
                "刷新 Windows 代理设置失败：{}",
                io::Error::last_os_error()
            ));
        }
    }
    Ok(())
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

fn persist_update_snapshot(app: &AppHandle, snapshot: &ProxySnapshot) -> Result<(), String> {
    let path = update_state_path(app)?;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProxyExpectation {
    Enabled,
    UpdateDisabled,
}

fn has_external_auto_config(snapshot: &ProxySnapshot) -> bool {
    snapshot
        .auto_config_url
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
        || snapshot.auto_detect.is_some_and(|value| value != 0)
}

fn endpoint_matches(snapshot: &ProxySnapshot, mixed_port: u16) -> bool {
    let endpoint = format!("127.0.0.1:{mixed_port}");
    snapshot.proxy_server.as_deref() == Some(endpoint.as_str())
}

fn is_mioproxy_proxy(snapshot: &ProxySnapshot, mixed_port: u16) -> bool {
    snapshot.proxy_enable == Some(1)
        && endpoint_matches(snapshot, mixed_port)
        && !has_external_auto_config(snapshot)
}

fn listener_pids(mixed_port: u16) -> Result<Vec<Option<u32>>, String> {
    Ok(
        crate::config::windows_tcp_listener_diagnostics(mixed_port, None)?
            .into_iter()
            .filter(|listener| listener.state == "listen")
            .map(|listener| listener.owning_pid)
            .collect(),
    )
}

fn listeners_belong_to(listener_pids: &[Option<u32>], managed_pid: u32) -> bool {
    !listener_pids.is_empty()
        && listener_pids
            .iter()
            .all(|listener_pid| *listener_pid == Some(managed_pid))
}

fn current_still_mioproxy_owned(
    current: &ProxySnapshot,
    mixed_port: u16,
    managed_listener_pid: Option<u32>,
    listener_pids: &[Option<u32>],
    expectation: ProxyExpectation,
) -> bool {
    if !matches_mioproxy_registry_shape(current, mixed_port, expectation) {
        return false;
    }
    if listener_pids.is_empty() {
        // The managed Core can exit before lifecycle cleanup runs. An unbound,
        // unchanged MioProxy endpoint is still safe to restore.
        return true;
    }
    managed_listener_pid.is_some_and(|expected| listeners_belong_to(listener_pids, expected))
}

fn matches_mioproxy_registry_shape(
    current: &ProxySnapshot,
    mixed_port: u16,
    expectation: ProxyExpectation,
) -> bool {
    if has_external_auto_config(current) || !endpoint_matches(current, mixed_port) {
        return false;
    }
    let expected_enable = match expectation {
        ProxyExpectation::Enabled => Some(1),
        ProxyExpectation::UpdateDisabled => Some(0),
    };
    current.proxy_enable == expected_enable
}

fn should_restore_lifecycle_snapshot(
    current: &ProxySnapshot,
    mixed_port: u16,
    managed_listener_pid: Option<u32>,
    listener_pids: &[Option<u32>],
) -> bool {
    current_still_mioproxy_owned(
        current,
        mixed_port,
        managed_listener_pid,
        listener_pids,
        ProxyExpectation::Enabled,
    )
}

fn windows_state(snapshot: &ProxySnapshot, mixed_port: u16) -> ProxyWindowsState {
    if is_mioproxy_proxy(snapshot, mixed_port) {
        ProxyWindowsState::MioProxy
    } else if snapshot.proxy_enable == Some(1) || has_external_auto_config(snapshot) {
        ProxyWindowsState::External
    } else {
        ProxyWindowsState::Disabled
    }
}

fn actual_state(snapshot: &ProxySnapshot, mixed_port: u16) -> ProxyActualState {
    if is_mioproxy_proxy(snapshot, mixed_port) {
        return ProxyActualState::MioProxyEndpoint;
    }
    if snapshot.proxy_enable == Some(1) || has_external_auto_config(snapshot) {
        ProxyActualState::ExternalEndpoint
    } else {
        ProxyActualState::Disabled
    }
}

fn owner(
    actual: ProxyActualState,
    has_mioproxy_snapshot: bool,
    current_still_owned: bool,
) -> ProxyOwner {
    match actual {
        ProxyActualState::Disabled => ProxyOwner::None,
        ProxyActualState::ExternalEndpoint => ProxyOwner::External,
        ProxyActualState::MioProxyEndpoint if has_mioproxy_snapshot && current_still_owned => {
            ProxyOwner::MioProxy
        }
        ProxyActualState::MioProxyEndpoint if has_mioproxy_snapshot => ProxyOwner::External,
        ProxyActualState::MioProxyEndpoint => ProxyOwner::External,
    }
}

fn is_mioproxy_owned(owner: ProxyOwner) -> bool {
    owner == ProxyOwner::MioProxy
}

fn managed_core_ready(managed: bool, running: bool) -> bool {
    managed && running
}

async fn managed_core_and_listener(
    app: &AppHandle,
    mixed_port: u16,
    listener_pids: &[Option<u32>],
) -> Result<(bool, bool, Option<u32>), String> {
    let gui_pid = if let Some(state) = app.try_state::<mihomo::CoreState>() {
        state
            .child
            .lock()
            .map_err(|_| "CoreState 锁异常")?
            .as_ref()
            .map(|child| child.pid())
    } else {
        None
    };
    let service_status = crate::service::request_service_status(app).await?;
    let service_pid = service_status
        .as_ref()
        .is_some_and(|status| status.owns_core)
        .then(|| crate::service::persisted_managed_core_pid(app))
        .flatten();
    let ready_candidate = gui_pid
        .or(service_pid)
        .or_else(|| crate::service::persisted_managed_core_pid(app));
    let listener_pid = if let Some(candidate) = ready_candidate {
        let ready = listeners_belong_to(listener_pids, candidate)
            && mihomo::core_ready_for_pid(mixed_port, candidate).await?;
        ready.then_some(candidate)
    } else {
        None
    };
    Ok((listener_pid.is_some(), listener_pid.is_some(), listener_pid))
}

async fn restore_listener_pid(
    app: &AppHandle,
    snapshot: &ProxySnapshot,
    mixed_port: u16,
    listener_pids: &[Option<u32>],
) -> Result<Option<u32>, String> {
    if listener_pids.is_empty()
        || snapshot.managed_listener_pid.is_some_and(|expected| {
            listener_pids
                .iter()
                .all(|listener_pid| *listener_pid == Some(expected))
        })
    {
        return Ok(snapshot.managed_listener_pid);
    }
    Ok(managed_core_and_listener(app, mixed_port, listener_pids)
        .await?
        .2)
}

fn managed_snapshot(app: &AppHandle) -> Result<Option<ProxySnapshot>, String> {
    let in_memory = if let Some(state) = app.try_state::<SystemProxyState>() {
        state
            .snapshot
            .lock()
            .map_err(|_| "System Proxy 状态锁异常")?
            .clone()
    } else {
        None
    };
    if in_memory.is_some() {
        Ok(in_memory)
    } else {
        read_persisted_snapshot(app)
    }
}

fn managed_snapshot_present(app: &AppHandle) -> Result<bool, String> {
    Ok(managed_snapshot(app)?.is_some())
}

fn store_managed_snapshot(app: &AppHandle, snapshot: ProxySnapshot) -> Result<(), String> {
    persist_snapshot(app, &snapshot)?;
    if let Some(state) = app.try_state::<SystemProxyState>() {
        *state
            .snapshot
            .lock()
            .map_err(|_| "System Proxy 状态锁异常")? = Some(snapshot);
    }
    Ok(())
}

fn forget_managed_snapshot(app: &AppHandle) -> Result<(), String> {
    clear_persisted_snapshot(app)?;
    if let Some(state) = app.try_state::<SystemProxyState>() {
        *state
            .snapshot
            .lock()
            .map_err(|_| "System Proxy 状态锁异常")? = None;
    }
    Ok(())
}

pub async fn recover_stale_state(app: &AppHandle) -> Result<(), String> {
    let Some(mut snapshot) = read_persisted_snapshot(app)? else {
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

    let listeners = listener_pids(mixed_port)?;
    let expected_pid = restore_listener_pid(app, &snapshot, mixed_port, &listeners).await?;
    if !should_restore_lifecycle_snapshot(&current, mixed_port, expected_pid, &listeners) {
        eprintln!("检测到外部 System Proxy 接管，丢弃过期 MioProxy 恢复快照");
        crate::diagnostics::record_event(
            app,
            "info",
            "system-proxy",
            "Discarded stale System Proxy snapshot because Windows state is externally owned",
        );
        forget_managed_snapshot(app)?;
        return Ok(());
    }

    if mihomo::is_running().await {
        snapshot.managed_listener_pid = expected_pid;
        store_managed_snapshot(app, snapshot)?;
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
    forget_managed_snapshot(app)?;
    Ok(())
}

pub(crate) fn is_enabled_for_update(app: &AppHandle) -> Result<bool, String> {
    let current = read_snapshot()?;
    let mixed_port = mihomo::mixed_port(app)?;
    let snapshot = managed_snapshot(app)?;
    let listeners = listener_pids(mixed_port)?;
    Ok(can_disable_for_update(
        &current,
        mixed_port,
        snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.managed_listener_pid),
        &listeners,
    ))
}

fn can_disable_for_update(
    current: &ProxySnapshot,
    mixed_port: u16,
    managed_listener_pid: Option<u32>,
    listener_pids: &[Option<u32>],
) -> bool {
    current_still_mioproxy_owned(
        current,
        mixed_port,
        managed_listener_pid,
        listener_pids,
        ProxyExpectation::Enabled,
    )
}

fn can_restore_after_update(
    current: &ProxySnapshot,
    mixed_port: u16,
    managed_listener_pid: Option<u32>,
    listener_pids: &[Option<u32>],
) -> bool {
    current_still_mioproxy_owned(
        current,
        mixed_port,
        managed_listener_pid,
        listener_pids,
        ProxyExpectation::UpdateDisabled,
    )
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
    let managed = managed_snapshot(app)?;
    let managed_listener_pid = managed
        .as_ref()
        .and_then(|snapshot| snapshot.managed_listener_pid);
    let listeners = listener_pids(mixed_port)?;
    if !can_disable_for_update(&current, mixed_port, managed_listener_pid, &listeners) {
        return Ok(false);
    }
    let mut update_snapshot = current.clone();
    update_snapshot.managed_listener_pid = managed_listener_pid;
    persist_update_snapshot(app, &update_snapshot)?;
    let key = settings_key()?;
    let disabled = key
        .set_value("ProxyEnable", &0u32)
        .map_err(|e| format!("关闭更新前系统代理失败：{e}"))
        .and_then(|()| notify_settings_changed())
        .and_then(|()| {
            let verified = read_snapshot()?;
            if can_restore_after_update(&verified, mixed_port, managed_listener_pid, &listeners) {
                Ok(())
            } else {
                Err(
                    "关闭更新前系统代理失败：Windows read-back 与 MioProxy 所有权不一致"
                        .to_string(),
                )
            }
        });
    if let Err(error) = disabled {
        let restore_error = write_snapshot(&current).err();
        let clear_error = clear_update_snapshot(app).err();
        let mut details = error;
        if let Some(restore_error) = restore_error {
            details.push_str(&format!("；恢复更新前代理失败：{restore_error}"));
        }
        if let Some(clear_error) = clear_error {
            details.push_str(&format!("；清理更新代理快照失败：{clear_error}"));
        }
        return Err(details);
    }
    Ok(true)
}

pub(crate) fn restore_after_update_failure(app: &AppHandle) -> Result<(), String> {
    if let Some(snapshot) = read_update_snapshot(app)? {
        let current = read_snapshot()?;
        let mixed_port = mihomo::mixed_port(app)?;
        let listeners = listener_pids(mixed_port)?;
        if can_restore_after_update(
            &current,
            mixed_port,
            snapshot.managed_listener_pid,
            &listeners,
        ) {
            write_snapshot(&snapshot)?;
            clear_update_snapshot(app)?;
            return Ok(());
        }
        if matches_mioproxy_registry_shape(&current, mixed_port, ProxyExpectation::UpdateDisabled) {
            crate::diagnostics::record_event(
                app,
                "info",
                "system-proxy",
                "Deferred update System Proxy restore until the restarted managed Core is authenticated",
            );
            return Ok(());
        } else {
            crate::diagnostics::record_event(
                app,
                "info",
                "system-proxy",
                "Skipped update System Proxy restore because another client owns the current endpoint",
            );
            clear_update_snapshot(app)?;
            forget_managed_snapshot(app)?;
            return Err(
                "检测到外部 System Proxy 接管，已跳过更新后的 MioProxy 代理恢复".to_string(),
            );
        }
    }
    if let Some(snapshot) = read_persisted_snapshot(app)? {
        let current = read_snapshot()?;
        let mixed_port = mihomo::mixed_port(app)?;
        let listeners = listener_pids(mixed_port)?;
        if can_restore_after_update(
            &current,
            mixed_port,
            snapshot.managed_listener_pid,
            &listeners,
        ) {
            write_snapshot(&snapshot)?;
            forget_managed_snapshot(app)?;
        } else if matches_mioproxy_registry_shape(
            &current,
            mixed_port,
            ProxyExpectation::UpdateDisabled,
        ) {
            crate::diagnostics::record_event(
                app,
                "info",
                "system-proxy",
                "Deferred legacy update System Proxy restore until the restarted managed Core is authenticated",
            );
        } else {
            crate::diagnostics::record_event(
                app,
                "info",
                "system-proxy",
                "Skipped legacy update System Proxy restore because another client owns the current endpoint",
            );
            forget_managed_snapshot(app)?;
            return Err("检测到外部 System Proxy 接管，已跳过更新后的旧版代理恢复".to_string());
        }
    }
    Ok(())
}

pub(crate) fn restore_after_update_success(app: &AppHandle) -> Result<(), String> {
    restore_after_update_failure(app)
}

async fn restore_for_lifecycle_inner(app: &AppHandle) -> Result<(), String> {
    let snapshot = managed_snapshot(app)?;
    if let Some(snapshot) = snapshot {
        let current = read_snapshot()?;
        let mixed_port = mihomo::mixed_port(app)?;
        let listeners = listener_pids(mixed_port)?;
        let expected_pid = restore_listener_pid(app, &snapshot, mixed_port, &listeners).await?;
        if should_restore_lifecycle_snapshot(&current, mixed_port, expected_pid, &listeners) {
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
        forget_managed_snapshot(app)?;
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
        let current = read_snapshot()?;
        let mixed_port = mihomo::mixed_port(&app)?;
        let listeners = listener_pids(mixed_port)?;
        let (managed, core_running, managed_listener_pid) =
            managed_core_and_listener(&app, mixed_port, &listeners).await?;
        if !managed_core_ready(managed, core_running) {
            return Err(
                "当前 Mihomo 未达到 MioProxy managed Core Ready，拒绝开启系统代理".to_string(),
            );
        }
        let managed_listener_pid = managed_listener_pid
            .ok_or_else(|| "无法确认 MioProxy mixed-port 监听 PID，拒绝开启系统代理".to_string())?;
        let existing = managed_snapshot(&app)?;
        if let Some(mut snapshot) = existing.clone() {
            if current_still_mioproxy_owned(
                &current,
                mixed_port,
                Some(managed_listener_pid),
                &listeners,
                ProxyExpectation::Enabled,
            ) {
                if snapshot.managed_listener_pid != Some(managed_listener_pid) {
                    snapshot.managed_listener_pid = Some(managed_listener_pid);
                    store_managed_snapshot(&app, snapshot)?;
                }
                clear_update_snapshot(&app)?;
                return status(&app).await;
            }
        }

        let recovering_disabled = existing.is_some()
            && current_still_mioproxy_owned(
                &current,
                mixed_port,
                Some(managed_listener_pid),
                &listeners,
                ProxyExpectation::UpdateDisabled,
            );
        let mut snapshot = if recovering_disabled {
            existing.ok_or_else(|| "System Proxy 恢复快照意外缺失".to_string())?
        } else {
            current.clone()
        };
        snapshot.managed_listener_pid = Some(managed_listener_pid);
        persist_snapshot(&app, &snapshot)?;
        if let Err(error) = write_mioproxy_settings(mixed_port, &snapshot) {
            let restore_error = write_snapshot(&current).err();
            let clear_error = if recovering_disabled {
                None
            } else {
                forget_managed_snapshot(&app).err()
            };
            let mut details = format!("开启系统代理失败：{error}");
            if let Some(restore_error) = restore_error {
                details.push_str(&format!("；恢复 Windows 原始代理也失败：{restore_error}"));
            }
            if let Some(clear_error) = clear_error {
                details.push_str(&format!("；清理代理恢复快照失败：{clear_error}"));
            }
            return Err(details);
        }
        let verification = (|| {
            let verified = read_snapshot()?;
            let verified_listeners = listener_pids(mixed_port)?;
            current_still_mioproxy_owned(
                &verified,
                mixed_port,
                Some(managed_listener_pid),
                &verified_listeners,
                ProxyExpectation::Enabled,
            )
            .then_some(())
            .ok_or_else(|| {
                "Windows read-back、PAC/WPAD 或监听 PID 与 MioProxy 所有权不一致".to_string()
            })
        })();
        if let Err(verification_error) = verification {
            let restore_error = write_snapshot(&current).err();
            let clear_error = if recovering_disabled {
                None
            } else {
                forget_managed_snapshot(&app).err()
            };
            let mut details = format!("开启系统代理失败：{verification_error}");
            if let Some(error) = restore_error {
                details.push_str(&format!("；恢复 Windows 原始代理也失败：{error}"));
            }
            if let Some(error) = clear_error {
                details.push_str(&format!("；清理代理恢复快照失败：{error}"));
            }
            return Err(details);
        }
        store_managed_snapshot(&app, snapshot)?;
        clear_update_snapshot(&app)?;
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
    let listeners = listener_pids(mixed_port)?;
    let (managed, core_running, managed_listener_pid) =
        managed_core_and_listener(app, mixed_port, &listeners).await?;
    let desired_enabled = managed_snapshot_present(app)?;
    let actual_state = actual_state(&snapshot, mixed_port);
    let current_still_owned = current_still_mioproxy_owned(
        &snapshot,
        mixed_port,
        managed_listener_pid,
        &listeners,
        ProxyExpectation::Enabled,
    );
    let owner = owner(actual_state, desired_enabled, current_still_owned);
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
        is_mioproxy_proxy, managed_core_ready, owner, should_restore_lifecycle_snapshot,
        windows_state, ProxyActualState, ProxyOwner, ProxySnapshot, ProxyWindowsState,
    };

    fn snapshot(proxy_enable: Option<u32>, proxy_server: Option<&str>) -> ProxySnapshot {
        ProxySnapshot {
            proxy_enable,
            proxy_server: proxy_server.map(str::to_string),
            proxy_override: None,
            auto_config_url: None,
            auto_detect: None,
            managed_listener_pid: None,
        }
    }

    fn snapshot_with_auto_config(
        proxy_enable: Option<u32>,
        proxy_server: Option<&str>,
        auto_config_url: Option<&str>,
        auto_detect: Option<u32>,
    ) -> ProxySnapshot {
        ProxySnapshot {
            proxy_enable,
            proxy_server: proxy_server.map(str::to_string),
            proxy_override: None,
            auto_config_url: auto_config_url.map(str::to_string),
            auto_detect,
            managed_listener_pid: None,
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
            7891,
            Some(42),
            &[Some(42)],
        ));
        assert!(!should_restore_lifecycle_snapshot(
            &snapshot(Some(1), Some("127.0.0.1:7890")),
            7891,
            Some(42),
            &[Some(42)],
        ));
        assert!(!should_restore_lifecycle_snapshot(
            &snapshot(Some(1), Some("127.0.0.1:7891")),
            7891,
            Some(42),
            &[Some(43)],
        ));
        assert!(should_restore_lifecycle_snapshot(
            &snapshot(Some(1), Some("127.0.0.1:7891")),
            7891,
            Some(42),
            &[],
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
            owner(ProxyActualState::MioProxyEndpoint, true, true),
            ProxyOwner::MioProxy
        );
        assert_eq!(
            owner(ProxyActualState::ExternalEndpoint, false, false),
            ProxyOwner::External
        );
        assert_eq!(
            owner(ProxyActualState::MioProxyEndpoint, true, false),
            ProxyOwner::External
        );
        assert_eq!(
            owner(ProxyActualState::Disabled, false, false),
            ProxyOwner::None
        );
    }

    #[test]
    fn external_proxy_never_presents_as_mioproxy_enabled() {
        let actual = actual_state(&snapshot(Some(1), Some("127.0.0.1:7890")), 7893);
        let owner = owner(actual, true, false);
        assert_eq!(actual, ProxyActualState::ExternalEndpoint);
        assert_eq!(owner, ProxyOwner::External);
        assert!(!is_mioproxy_owned(owner));
    }

    #[test]
    fn system_proxy_requires_only_a_ready_managed_core() {
        assert!(managed_core_ready(true, true));
        assert!(!managed_core_ready(false, true));
        assert!(!managed_core_ready(true, false));
    }

    #[test]
    fn update_never_disables_an_external_proxy() {
        let external = snapshot(Some(1), Some("127.0.0.1:7890"));
        assert!(!can_disable_for_update(&external, 7893, None, &[]));
        assert!(!can_disable_for_update(
            &external,
            7893,
            Some(42),
            &[Some(42)]
        ));
        let owned = snapshot(Some(1), Some("127.0.0.1:7893"));
        assert!(can_disable_for_update(&owned, 7893, Some(42), &[Some(42)]));
        assert!(!can_disable_for_update(&owned, 7893, Some(42), &[Some(43)]));
    }

    #[test]
    fn update_restore_preserves_an_external_takeover() {
        assert!(can_restore_after_update(
            &snapshot(Some(0), Some("127.0.0.1:7890")),
            7890,
            Some(42),
            &[Some(42)]
        ));
        assert!(!can_restore_after_update(
            &snapshot(Some(1), Some("127.0.0.1:7890")),
            7890,
            Some(42),
            &[Some(42)]
        ));
    }

    #[test]
    fn pac_and_wpad_are_external_occupants() {
        for external in [
            snapshot_with_auto_config(Some(0), None, Some("https://example.test/proxy.pac"), None),
            snapshot_with_auto_config(Some(0), None, None, Some(1)),
            snapshot_with_auto_config(
                Some(1),
                Some("127.0.0.1:7890"),
                Some("https://example.test/proxy.pac"),
                None,
            ),
        ] {
            assert_eq!(
                actual_state(&external, 7890),
                ProxyActualState::ExternalEndpoint
            );
            assert_eq!(windows_state(&external, 7890), ProxyWindowsState::External);
            assert!(!should_restore_lifecycle_snapshot(
                &external,
                7890,
                Some(42),
                &[Some(42)]
            ));
        }
    }
}
