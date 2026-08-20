use std::sync::Mutex;

use serde::Deserialize;
use tauri::{
    menu::{MenuBuilder, MenuItem},
    AppHandle, Emitter, Manager, Wry,
};

use crate::{mihomo, startup, system_proxy};

const SHOW_WINDOW_ID: &str = "show-window";
const SYSTEM_PROXY_ENABLE_ID: &str = "system-proxy-enable";
const SYSTEM_PROXY_DISABLE_ID: &str = "system-proxy-disable";
const CURRENT_NODE_ID: &str = "current-node";
const EXIT_ID: &str = "exit";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UiLocale {
    EnUs,
    ZhCn,
}

impl UiLocale {
    fn from_system_name(locale: &str) -> Self {
        if locale.trim().to_ascii_lowercase().starts_with("zh") {
            Self::ZhCn
        } else {
            Self::EnUs
        }
    }

    fn labels(self) -> TrayLabels {
        match self {
            Self::EnUs => TrayLabels {
                show_window: "Show / hide main window",
                enable_proxy: "Enable System Proxy",
                disable_proxy: "Disable System Proxy",
                current_node: "Current node",
                not_running: "Not running",
                exit: "Exit MioProxy",
            },
            Self::ZhCn => TrayLabels {
                show_window: "显示 / 隐藏主窗口",
                enable_proxy: "开启系统代理",
                disable_proxy: "关闭系统代理",
                current_node: "当前节点",
                not_running: "未运行",
                exit: "退出 MioProxy",
            },
        }
    }

    fn current_node_text(self, node: &str) -> String {
        let labels = self.labels();
        match self {
            Self::EnUs => format!("{}: {node}", labels.current_node),
            Self::ZhCn => format!("{}：{node}", labels.current_node),
        }
    }
}

#[derive(Deserialize)]
pub(crate) enum UiLocaleRequest {
    #[serde(rename = "en-US")]
    EnUs,
    #[serde(rename = "zh-CN")]
    ZhCn,
}

impl From<UiLocaleRequest> for UiLocale {
    fn from(value: UiLocaleRequest) -> Self {
        match value {
            UiLocaleRequest::EnUs => Self::EnUs,
            UiLocaleRequest::ZhCn => Self::ZhCn,
        }
    }
}

struct TrayLabels {
    show_window: &'static str,
    enable_proxy: &'static str,
    disable_proxy: &'static str,
    current_node: &'static str,
    not_running: &'static str,
    exit: &'static str,
}

#[cfg(windows)]
fn system_locale() -> UiLocale {
    use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;

    let mut locale = [0u16; 85];
    let length = unsafe { GetUserDefaultLocaleName(locale.as_mut_ptr(), locale.len() as i32) };
    if length > 1 {
        UiLocale::from_system_name(&String::from_utf16_lossy(&locale[..length as usize - 1]))
    } else {
        UiLocale::EnUs
    }
}

#[cfg(not(windows))]
fn system_locale() -> UiLocale {
    UiLocale::EnUs
}

pub struct TrayState {
    show_window_item: Mutex<Option<MenuItem<Wry>>>,
    system_proxy_enable_item: Mutex<Option<MenuItem<Wry>>>,
    system_proxy_disable_item: Mutex<Option<MenuItem<Wry>>>,
    current_node_item: Mutex<Option<MenuItem<Wry>>>,
    exit_item: Mutex<Option<MenuItem<Wry>>>,
    locale: Mutex<UiLocale>,
    current_node: Mutex<Option<String>>,
}

impl Default for TrayState {
    fn default() -> Self {
        Self {
            show_window_item: Mutex::new(None),
            system_proxy_enable_item: Mutex::new(None),
            system_proxy_disable_item: Mutex::new(None),
            current_node_item: Mutex::new(None),
            exit_item: Mutex::new(None),
            locale: Mutex::new(system_locale()),
            current_node: Mutex::new(None),
        }
    }
}

pub fn setup(app: &AppHandle) -> Result<(), String> {
    let locale = *app
        .state::<TrayState>()
        .locale
        .lock()
        .map_err(|_| "托盘状态锁异常")?;
    let labels = locale.labels();
    let show_item = MenuItem::with_id(app, SHOW_WINDOW_ID, labels.show_window, true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let proxy_enable_item = MenuItem::with_id(
        app,
        SYSTEM_PROXY_ENABLE_ID,
        labels.enable_proxy,
        false,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let proxy_disable_item = MenuItem::with_id(
        app,
        SYSTEM_PROXY_DISABLE_ID,
        labels.disable_proxy,
        false,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let node_item = MenuItem::with_id(
        app,
        CURRENT_NODE_ID,
        locale.current_node_text(labels.not_running),
        false,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let exit_item = MenuItem::with_id(app, EXIT_ID, labels.exit, true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let menu = MenuBuilder::new(app)
        .items(&[
            &show_item,
            &proxy_enable_item,
            &proxy_disable_item,
            &node_item,
            &exit_item,
        ])
        .build()
        .map_err(|e| e.to_string())?;

    {
        let state = app.state::<TrayState>();
        *state
            .show_window_item
            .lock()
            .map_err(|_| "托盘状态锁异常")? = Some(show_item.clone());
        *state
            .system_proxy_enable_item
            .lock()
            .map_err(|_| "托盘状态锁异常")? = Some(proxy_enable_item.clone());
        *state
            .system_proxy_disable_item
            .lock()
            .map_err(|_| "托盘状态锁异常")? = Some(proxy_disable_item.clone());
        *state
            .current_node_item
            .lock()
            .map_err(|_| "托盘状态锁异常")? = Some(node_item.clone());
        *state.exit_item.lock().map_err(|_| "托盘状态锁异常")? = Some(exit_item.clone());
    }

    let mut builder = tauri::tray::TrayIconBuilder::with_id("mioproxy-tray")
        .menu(&menu)
        .tooltip("MioProxy")
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            SHOW_WINDOW_ID => toggle_window(app),
            SYSTEM_PROXY_ENABLE_ID => set_system_proxy_enabled(app, true),
            SYSTEM_PROXY_DISABLE_ID => set_system_proxy_enabled(app, false),
            EXIT_ID => exit_app(app),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app).map_err(|e| e.to_string())?;

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Ok(status) = system_proxy::status(&handle).await {
            update_proxy_label(&handle, status.enabled, status.core_running);
        }
        update_current_node(&handle).await;
        if startup::should_start_minimized() {
            startup::apply_start_minimized(&handle);
        }
    });

    Ok(())
}

fn toggle_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.set_skip_taskbar(true);
            let _ = window.hide();
        } else {
            let _ = window.unminimize();
            let _ = window.set_skip_taskbar(false);
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn set_system_proxy_enabled(app: &AppHandle, enabled: bool) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        match system_proxy::status(&handle).await {
            Ok(current) => match system_proxy::set_enabled(handle.clone(), enabled).await {
                Ok(next) => update_proxy_label(&handle, next.enabled, next.core_running),
                Err(error) => {
                    update_proxy_label(&handle, current.enabled, current.core_running);
                    let _ = handle.emit("system-proxy-error", error);
                }
            },
            Err(error) => {
                let _ = handle.emit("system-proxy-error", error);
            }
        }
    });
}

fn exit_app(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        handle.exit(0);
    });
}

pub fn update_proxy_label(app: &AppHandle, enabled: bool, core_running: bool) {
    let enable_item = app
        .state::<TrayState>()
        .system_proxy_enable_item
        .lock()
        .ok()
        .and_then(|item| item.clone());
    let disable_item = app
        .state::<TrayState>()
        .system_proxy_disable_item
        .lock()
        .ok()
        .and_then(|item| item.clone());
    if let Some(item) = enable_item {
        let _ = item.set_enabled(core_running && !enabled);
    }
    if let Some(item) = disable_item {
        let _ = item.set_enabled(enabled);
    }
}

pub async fn update_current_node(app: &AppHandle) {
    let node = mihomo::current_node().await;
    let state = app.state::<TrayState>();
    if let Ok(mut current) = state.current_node.lock() {
        *current = node.clone();
    }
    let item = state
        .current_node_item
        .lock()
        .ok()
        .and_then(|item| item.clone());
    if let Some(item) = item {
        let locale = state
            .locale
            .lock()
            .map(|locale| *locale)
            .unwrap_or(UiLocale::EnUs);
        let labels = locale.labels();
        let node = node.unwrap_or_else(|| labels.not_running.to_string());
        let _ = item.set_text(locale.current_node_text(&node));
    }
}

#[tauri::command]
pub(crate) fn tray_set_locale(app: AppHandle, locale: UiLocaleRequest) -> Result<(), String> {
    let state = app.state::<TrayState>();
    let locale = UiLocale::from(locale);
    *state.locale.lock().map_err(|_| "托盘状态锁异常")? = locale;
    let labels = locale.labels();
    let current_node = state
        .current_node
        .lock()
        .map_err(|_| "托盘状态锁异常")?
        .clone()
        .unwrap_or_else(|| labels.not_running.to_string());

    let update = |item: &Mutex<Option<MenuItem<Wry>>>, text: String| -> Result<(), String> {
        if let Some(item) = item.lock().map_err(|_| "托盘状态锁异常")?.clone() {
            item.set_text(text).map_err(|error| error.to_string())?;
        }
        Ok(())
    };
    update(&state.show_window_item, labels.show_window.to_string())?;
    update(
        &state.system_proxy_enable_item,
        labels.enable_proxy.to_string(),
    )?;
    update(
        &state.system_proxy_disable_item,
        labels.disable_proxy.to_string(),
    )?;
    update(
        &state.current_node_item,
        locale.current_node_text(&current_node),
    )?;
    update(&state.exit_item, labels.exit.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_all_chinese_system_locales_to_zh_cn() {
        assert_eq!(UiLocale::from_system_name("zh-TW"), UiLocale::ZhCn);
        assert_eq!(UiLocale::from_system_name("zh-Hans"), UiLocale::ZhCn);
        assert_eq!(UiLocale::from_system_name("zh-SG"), UiLocale::ZhCn);
    }

    #[test]
    fn falls_back_to_english_for_unsupported_system_locales() {
        assert_eq!(UiLocale::from_system_name("en-GB"), UiLocale::EnUs);
        assert_eq!(UiLocale::from_system_name("fr-FR"), UiLocale::EnUs);
    }
}
