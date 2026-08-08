use std::{
    fs,
    path::PathBuf,
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use windows_sys::Win32::Networking::WinInet::{
    InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
};
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

use crate::mihomo;

const INTERNET_SETTINGS_PATH: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

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
    pub enabled: bool,
    pub core_running: bool,
    pub mixed_port: u16,
    pub proxy_server: Option<String>,
}

fn settings_key() -> Result<RegKey, String> {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(INTERNET_SETTINGS_PATH, winreg::enums::KEY_READ | winreg::enums::KEY_WRITE)
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
        key.set_value("ProxyEnable", &value).map_err(|e| e.to_string())?;
    } else {
        delete_value(&key, "ProxyEnable");
    }
    write_optional_string(&key, "ProxyServer", &snapshot.proxy_server)?;
    write_optional_string(&key, "ProxyOverride", &snapshot.proxy_override)?;
    write_optional_string(&key, "AutoConfigURL", &snapshot.auto_config_url)?;
    if let Some(value) = snapshot.auto_detect {
        key.set_value("AutoDetect", &value).map_err(|e| e.to_string())?;
    } else {
        delete_value(&key, "AutoDetect");
    }
    notify_settings_changed();
    Ok(())
}

fn write_mioproxy_settings(mixed_port: u16, original: &ProxySnapshot) -> Result<(), String> {
    let key = settings_key()?;
    key.set_value("ProxyEnable", &1u32).map_err(|e| e.to_string())?;
    key.set_value("ProxyServer", &format!("127.0.0.1:{mixed_port}")).map_err(|e| e.to_string())?;
    let override_value = original
        .proxy_override
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("<local>");
    key.set_value("ProxyOverride", &override_value).map_err(|e| e.to_string())?;
    delete_value(&key, "AutoConfigURL");
    delete_value(&key, "AutoDetect");
    notify_settings_changed();
    Ok(())
}

fn notify_settings_changed() {
    unsafe {
        let _ = InternetSetOptionW(std::ptr::null_mut(), INTERNET_OPTION_SETTINGS_CHANGED, std::ptr::null_mut(), 0);
        let _ = InternetSetOptionW(std::ptr::null_mut(), INTERNET_OPTION_REFRESH, std::ptr::null_mut(), 0);
    }
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("system-proxy-state.json"))
}

fn persist_snapshot(app: &AppHandle, snapshot: &ProxySnapshot) -> Result<(), String> {
    let path = state_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, serde_json::to_vec_pretty(snapshot).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn read_persisted_snapshot(app: &AppHandle) -> Result<Option<ProxySnapshot>, String> {
    let path = state_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map(Some).map_err(|e| format!("代理状态恢复文件损坏：{e}"))
}

fn clear_persisted_snapshot(app: &AppHandle) -> Result<(), String> {
    let path = state_path(app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn recover_stale_state(app: &AppHandle) -> Result<(), String> {
    if let Some(snapshot) = read_persisted_snapshot(app)? {
        write_snapshot(&snapshot)?;
        clear_persisted_snapshot(app)?;
    }
    Ok(())
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
        write_snapshot(&snapshot)?;
        clear_persisted_snapshot(app)?;
        *state.snapshot.lock().map_err(|_| "System Proxy 状态锁异常")? = None;
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
    let _transition = crate::tun::lock_transitions().await;
    if enabled {
        if let Some(service_tun) = crate::service::service_tun_status(&app).await? {
            if service_tun.status != crate::tun::TunStatus::Disabled {
                return Err("MioProxy Service 正在管理 TUN，不能同时开启系统代理".to_string());
            }
        }
        if crate::tun::is_active(&app) {
            return Err("TUN 已开启，不能同时开启系统代理".to_string());
        }
        if !mihomo::is_running().await {
            return Err("Mihomo 尚未启动，不能开启系统代理".to_string());
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
            let _ = write_snapshot(&snapshot);
            let _ = clear_persisted_snapshot(&app);
            return Err(format!("开启系统代理失败：{error}"));
        }
        *state.snapshot.lock().map_err(|_| "System Proxy 状态锁异常")? = Some(snapshot);
    } else {
        restore_for_lifecycle_inner(&app).await?;
    }
    let result = status(&app).await;
    if let Ok(next) = &result {
        crate::tray::update_proxy_label(&app, next.enabled, next.core_running);
    }
    result
}

pub async fn status(app: &AppHandle) -> Result<SystemProxyStatus, String> {
    let snapshot = read_snapshot()?;
    Ok(SystemProxyStatus {
        enabled: snapshot.proxy_enable == Some(1),
        core_running: mihomo::is_running().await,
        mixed_port: mihomo::mixed_port(app)?,
        proxy_server: snapshot.proxy_server,
    })
}

#[tauri::command]
pub async fn system_proxy_status(app: AppHandle) -> Result<SystemProxyStatus, String> {
    status(&app).await
}

#[tauri::command]
pub async fn system_proxy_set_enabled(app: AppHandle, enabled: bool) -> Result<SystemProxyStatus, String> {
    set_enabled(app, enabled).await
}
