mod config;
mod core_update;
mod mihomo;
mod profiles;
pub mod service;
mod startup;
mod system_proxy;
mod tray;
mod tun;
mod update;

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
    pub updating: AtomicBool,
}

pub(crate) fn ensure_mutations_allowed(app: &tauri::AppHandle) -> Result<(), String> {
    if app
        .try_state::<AppLifecycle>()
        .is_some_and(|lifecycle| lifecycle.updating.load(Ordering::SeqCst))
    {
        return Err("MioProxy 正在准备更新，暂时禁止切换代理、TUN 或内核状态".to_string());
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(CoreState::default())
        .manage(mihomo::traffic::TrafficStreamState::default())
        .manage(mihomo::logs::LogStreamState::default())
        .manage(AppLifecycle::default())
        .manage(system_proxy::SystemProxyState::default())
        .manage(tun::TunState::default())
        .manage(tray::TrayState::default())
        .setup(|app| {
            update::register_app_handle(app.handle());
            let data_dir = app.path().app_data_dir().map_err(|error| {
                Box::new(std::io::Error::other(error)) as Box<dyn std::error::Error>
            })?;
            mihomo::initialize_secret(&data_dir).map_err(|error| {
                Box::new(std::io::Error::other(error)) as Box<dyn std::error::Error>
            })?;
            if let Err(error) = system_proxy::recover_stale_state(app.handle()) {
                eprintln!("恢复系统代理状态失败：{error}");
            }
            match update::recover_checkpoint(app.handle()) {
                Ok(Some(message)) => eprintln!("更新恢复提示：{message}"),
                Ok(None) => {}
                Err(error) => eprintln!("读取更新恢复检查点失败：{error}"),
            }
            startup::apply_start_minimized(app.handle());
            if let Err(error) = tray::setup(app.handle()) {
                return Err(Box::new(std::io::Error::other(error)));
            }
            tun::start_monitor(app.handle().clone());
            let recovery_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tun::recover_after_startup(recovery_app.clone()).await;
                update::recover_after_startup(recovery_app).await;
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
            update::update_status,
            update::update_check,
            update::update_prepare,
            update::update_mark_failed,
            update::update_preferences_status,
            update::update_preferences_set,
            core_update::mihomo_core_update_status,
            core_update::mihomo_core_update_check,
            core_update::mihomo_core_update_install,
        ])
        .build(tauri::generate_context!())
        .expect("error while building MioProxy")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let lifecycle = app.state::<AppLifecycle>();
                if lifecycle.exiting.swap(true, Ordering::SeqCst) {
                    return;
                }
                if lifecycle.updating.load(Ordering::SeqCst) {
                    return;
                }
                let errors = tauri::async_runtime::block_on(async {
                    let mut errors = Vec::new();
                    if let Err(error) = service::restore_for_lifecycle(app).await {
                        errors.push(format!("Service TUN 清理失败：{error}"));
                    }
                    if let Err(error) =
                        tun::restore_for_lifecycle(app, &app.state::<tun::TunState>()).await
                    {
                        errors.push(format!("GUI TUN 清理失败：{error}"));
                    }
                    if let Err(error) = system_proxy::restore_for_lifecycle(app).await {
                        errors.push(format!("系统代理清理失败：{error}"));
                    }
                    errors
                });
                if !errors.is_empty() {
                    lifecycle.exiting.store(false, Ordering::SeqCst);
                    eprintln!("退出前清理未完成：{}", errors.join("；"));
                    api.prevent_exit();
                }
            }
        });
}
