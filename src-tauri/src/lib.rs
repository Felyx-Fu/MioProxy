mod config;
mod mihomo;
mod profiles;
pub mod service;
mod startup;
mod system_proxy;
mod tray;
mod tun;

use mihomo::{
    mihomo_close_all_connections, mihomo_close_connection, mihomo_connections, mihomo_proxies,
    mihomo_proxy_delay, mihomo_reload, mihomo_rule_provider_update, mihomo_rule_providers,
    mihomo_rules, mihomo_select_proxy, mihomo_start, mihomo_status, mihomo_stop, mihomo_version,
    CoreState,
};
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
        .manage(mihomo::traffic::TrafficStreamState::default())
        .manage(mihomo::logs::LogStreamState::default())
        .manage(AppLifecycle::default())
        .manage(system_proxy::SystemProxyState::default())
        .manage(tun::TunState::default())
        .manage(tray::TrayState::default())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| Box::new(std::io::Error::other(error)) as Box<dyn std::error::Error>)?;
            mihomo::initialize_secret(&data_dir)
                .map_err(|error| Box::new(std::io::Error::other(error)) as Box<dyn std::error::Error>)?;
            if let Err(error) = system_proxy::recover_stale_state(app.handle()) {
                eprintln!("恢复系统代理状态失败：{error}");
            }
            startup::apply_start_minimized(app.handle());
            if let Err(error) = tray::setup(app.handle()) {
                return Err(Box::new(std::io::Error::other(error)));
            }
            tun::start_monitor(app.handle().clone());
            let recovery_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tun::recover_after_startup(recovery_app).await;
            });
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
            mihomo_rules,
            mihomo_rule_providers,
            mihomo_rule_provider_update,
            mihomo_reload,
            mihomo_select_proxy,
            mihomo_proxy_delay,
            mihomo_connections,
            mihomo_close_connection,
            mihomo_close_all_connections,
            system_proxy::system_proxy_status,
            system_proxy::system_proxy_set_enabled,
            startup::startup_status,
            startup::startup_set,
            profile_list,
            profile_add,
            profile_download,
            profile_apply,
            profile_remove,
            config::override_get,
            config::override_set,
            config::config_preview,
            config::config_apply,
            config::dns_get,
            config::dns_set,
            tun::tun_status,
            tun::tun_set_enabled,
            service::service_status_command,
        ])
        .build(tauri::generate_context!())
        .expect("error while building MioProxy")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let _ = tauri::async_runtime::block_on(service::restore_for_lifecycle(app));
                let _ = tauri::async_runtime::block_on(tun::restore_for_lifecycle(
                    app,
                    &app.state::<tun::TunState>(),
                ));
                let _ = tauri::async_runtime::block_on(system_proxy::restore_for_lifecycle(app));
            }
        });
}
