use std::sync::Mutex;

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

pub struct TrayState {
    system_proxy_enable_item: Mutex<Option<MenuItem<Wry>>>,
    system_proxy_disable_item: Mutex<Option<MenuItem<Wry>>>,
    current_node_item: Mutex<Option<MenuItem<Wry>>>,
}

impl Default for TrayState {
    fn default() -> Self {
        Self {
            system_proxy_enable_item: Mutex::new(None),
            system_proxy_disable_item: Mutex::new(None),
            current_node_item: Mutex::new(None),
        }
    }
}

pub fn setup(app: &AppHandle) -> Result<(), String> {
    let show_item = MenuItem::with_id(app, SHOW_WINDOW_ID, "显示 / 隐藏主窗口", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let proxy_enable_item = MenuItem::with_id(
        app,
        SYSTEM_PROXY_ENABLE_ID,
        "开启系统代理",
        false,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let proxy_disable_item = MenuItem::with_id(
        app,
        SYSTEM_PROXY_DISABLE_ID,
        "关闭系统代理",
        false,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let node_item = MenuItem::with_id(
        app,
        CURRENT_NODE_ID,
        "当前节点：未运行",
        false,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let exit_item = MenuItem::with_id(app, EXIT_ID, "退出 MioProxy", true, None::<&str>)
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
    let item = app
        .state::<TrayState>()
        .current_node_item
        .lock()
        .ok()
        .and_then(|item| item.clone());
    if let Some(item) = item {
        let node = mihomo::current_node()
            .await
            .unwrap_or_else(|| "未运行".to_string());
        let _ = item.set_text(format!("当前节点：{node}"));
    }
}
