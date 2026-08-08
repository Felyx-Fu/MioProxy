use serde::Serialize;
use tauri::{AppHandle, Manager};
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

const RUN_PATH: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE: &str = "MioProxy";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupSettings {
    pub enabled: bool,
    pub start_minimized: bool,
}

fn run_key() -> Result<RegKey, String> {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(RUN_PATH, winreg::enums::KEY_READ | winreg::enums::KEY_WRITE)
        .map_err(|e| format!("读取 Windows 启动项失败：{e}"))
}

fn command_line(start_minimized: bool) -> Result<String, String> {
    let executable = std::env::current_exe().map_err(|e| format!("读取 MioProxy 路径失败：{e}"))?;
    let suffix = if start_minimized { " --minimized" } else { "" };
    Ok(format!("\"{}\"{suffix}", executable.display()))
}

pub fn should_start_minimized() -> bool {
    std::env::args().any(|argument| argument == "--minimized")
}

pub fn apply_start_minimized(app: &AppHandle) {
    if should_start_minimized() {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
    }
}

pub fn status() -> Result<StartupSettings, String> {
    let key = run_key()?;
    let command: Option<String> = key.get_value(RUN_VALUE).ok();
    let command = command.unwrap_or_default();
    Ok(StartupSettings {
        enabled: !command.is_empty(),
        start_minimized: command.contains("--minimized"),
    })
}

pub fn set_enabled(enabled: bool, start_minimized: bool) -> Result<StartupSettings, String> {
    let key = run_key()?;
    if enabled {
        key.set_value(RUN_VALUE, &command_line(start_minimized)?)
            .map_err(|e| format!("写入 Windows 启动项失败：{e}"))?;
    } else {
        let _ = key.delete_value(RUN_VALUE);
    }
    status()
}

#[tauri::command]
pub fn startup_status() -> Result<StartupSettings, String> {
    status()
}

#[tauri::command]
pub fn startup_set(enabled: bool, start_minimized: bool) -> Result<StartupSettings, String> {
    set_enabled(enabled, start_minimized)
}
