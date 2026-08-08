use std::sync::Mutex;

use tauri::{
    menu::{MenuBuilder, MenuItem},
    AppHandle, Emitter, Manager, Wry,
};

use crate::{mihomo, startup, system_proxy};

const SHOW_WINDOW_ID: &str = "show-window";
const SYSTEM_PROXY_ID: &str = "system-proxy";
const CURRENT_NODE_ID: &str = "current-node";
const EXIT_ID: &str = "exit";

pub struct TrayState {
    system_proxy_item: Mutex<Option<MenuItem<Wry>>>,
    current_node_item: Mutex<Option<MenuItem<Wry>>>,
}

impl Default for TrayState {
    fn default() -> Self {
        Self {
            system_proxy_item: Mutex::new(None),
            current_node_item: Mutex::new(None),
        }
    }
}

pub fn setup(app: &AppHandle) -> Result<(), String> {
    let show_item = MenuItem::with_id(app, SHOW_WINDOW_ID, "显示 / 隐藏主窗口", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let proxy_item = MenuItem::with_id(app, SYSTEM_PROXY_ID, "系统代理：已关闭", false, None::<&str>)
        .map_err(|e| e.to_string())?;
    let node_item = MenuItem::with_id(app, CURRENT_NODE_ID, "当前节点：未运行", false, None::<&str>)
        .map_err(|e| e.to_string())?;
    let exit_item = MenuItem::with_id(app, EXIT_ID, "退出 MioProxy", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let menu = MenuBuilder::new(app)
        .items(&[&show_item, &proxy_item, &node_item, &exit_item])
        .build()
        .map_err(|e| e.to_string())?;

    {
        let state = app.state::<TrayState>();
        *state.system_proxy_item.lock().map_err(|_| "托盘状态锁异常")? = Some(proxy_item.clone());
        *state.current_node_item.lock().map_err(|_| "托盘状态锁异常")? = Some(node_item.clone());
    }

    let mut builder = tauri::tray::TrayIconBuilder::with_id("mioproxy-tray")
        .menu(&menu)
        .tooltip("MioProxy")
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            SHOW_WINDOW_ID => toggle_window(app),
            SYSTEM_PROXY_ID => toggle_system_proxy(app),
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
            let _ = window.hide();
        } else {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn toggle_system_proxy(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        match system_proxy::status(&handle).await {
            Ok(current) => match system_proxy::set_enabled(handle.clone(), !current.enabled).await {
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
    app.state::<crate::AppLifecycle>()
        .exiting
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = system_proxy::restore_for_lifecycle(&handle).await;
        handle.exit(0);
    });
}

pub fn update_proxy_label(app: &AppHandle, enabled: bool, core_running: bool) {
    let item = app
        .state::<TrayState>()
        .system_proxy_item
        .lock()
        .ok()
        .and_then(|item| item.clone());
    if let Some(item) = item {
        let text = if enabled {
            "系统代理：已开启"
        } else if core_running {
            "系统代理：已关闭"
        } else {
            "系统代理：需先启动内核"
        };
        let _ = item.set_text(text);
        let _ = item.set_enabled(core_running || enabled);
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
        let node = mihomo::current_node().await.unwrap_or_else(|| "未运行".to_string());
        let _ = item.set_text(format!("当前节点：{node}"));
    }
}
