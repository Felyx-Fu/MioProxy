mod mihomo;
mod profiles;
mod startup;
mod system_proxy;
mod tray;

use mihomo::{CoreState, mihomo_proxies, mihomo_proxy_delay, mihomo_reload, mihomo_select_proxy, mihomo_start, mihomo_status, mihomo_stop, mihomo_version};
use profiles::{profile_add, profile_apply, profile_download, profile_list, profile_remove};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

#[derive(Default)]
pub struct AppLifecycle {
    pub exiting: AtomicBool,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(CoreState::default())
        .manage(AppLifecycle::default())
        .manage(system_proxy::SystemProxyState::default())
        .manage(tray::TrayState::default())
        .setup(|app| {
            if let Err(error) = system_proxy::recover_stale_state(&app.handle()) {
                eprintln!("恢复系统代理状态失败：{error}");
            }
            startup::apply_start_minimized(&app.handle());
            if let Err(error) = tray::setup(&app.handle()) {
                return Err(Box::new(std::io::Error::other(error)));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let exiting = window
                    .app_handle()
                    .state::<AppLifecycle>()
                    .exiting
                    .load(Ordering::SeqCst);
                if !exiting {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            mihomo_start,
            mihomo_stop,
            mihomo_status,
            mihomo_version,
            mihomo_proxies,
            mihomo_reload,
            mihomo_select_proxy,
            mihomo_proxy_delay,
            system_proxy::system_proxy_status,
            system_proxy::system_proxy_set_enabled,
            startup::startup_status,
            startup::startup_set,
            profile_list,
            profile_add,
            profile_download,
            profile_apply,
            profile_remove,
        ])
        .build(tauri::generate_context!())
        .expect("error while building MioProxy")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let _ = tauri::async_runtime::block_on(system_proxy::restore_for_lifecycle(app));
            }
        });
}
