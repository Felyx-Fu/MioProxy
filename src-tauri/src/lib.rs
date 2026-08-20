mod config;
mod core_update;
mod diagnostics;
mod migration;
mod mihomo;
mod outbound;
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
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::Manager;

pub struct AppLifecycle {
    pub exiting: AtomicBool,
    pub updating: AtomicBool,
    pub migration_error: Mutex<Option<String>>,
}

impl Default for AppLifecycle {
    fn default() -> Self {
        Self {
            exiting: AtomicBool::new(false),
            updating: AtomicBool::new(false),
            migration_error: Mutex::new(None),
        }
    }
}

pub(crate) fn ensure_mutations_allowed(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(lifecycle) = app.try_state::<AppLifecycle>() {
        if lifecycle.updating.load(Ordering::SeqCst) {
            return Err("MioProxy 正在准备更新，暂时禁止切换代理、TUN 或内核状态".to_string());
        }
        if let Some(error) = lifecycle
            .migration_error
            .lock()
            .map_err(|_| "配置迁移状态锁异常")?
            .clone()
        {
            return Err(format!("配置迁移未完成，已阻止修改用户数据：{error}"));
        }
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
                let _ = window.set_skip_taskbar(false);
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(CoreState::default())
        .manage(mihomo::traffic::TrafficStreamState::default())
        .manage(mihomo::logs::LogStreamState::default())
        .manage(diagnostics::DiagnosticLogState::default())
        .manage(AppLifecycle::default())
        .manage(system_proxy::SystemProxyState::default())
        .manage(tun::TunState::default())
        .manage(tray::TrayState::default())
        .setup(|app| {
            diagnostics::record_event(app.handle(), "info", "gui", "GUI startup");
            update::register_app_handle(app.handle());
            let data_dir = app.path().app_data_dir().map_err(|error| {
                Box::new(std::io::Error::other(error)) as Box<dyn std::error::Error>
            })?;
            if let Err(error) = migration::ensure_current(app.handle()) {
                if let Ok(mut migration_error) = app.state::<AppLifecycle>().migration_error.lock()
                {
                    *migration_error = Some(error.clone());
                }
                eprintln!("配置迁移检查失败：{error}");
                diagnostics::record_event(app.handle(), "error", "migration", error);
            }
            mihomo::initialize_secret(&data_dir).map_err(|error| {
                Box::new(std::io::Error::other(error)) as Box<dyn std::error::Error>
            })?;
            match update::recover_checkpoint(app.handle()) {
                Ok(Some(message)) => eprintln!("更新恢复提示：{message}"),
                Ok(None) => {}
                Err(error) => eprintln!("读取更新恢复检查点失败：{error}"),
            }
            startup::apply_start_minimized(app.handle());
            if let Err(error) = tray::setup(app.handle()) {
                return Err(Box::new(std::io::Error::other(error)));
            }
            let recovery_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tun::recover_after_startup(recovery_app.clone()).await;
                update::recover_after_startup(recovery_app.clone()).await;
                if let Err(error) = system_proxy::recover_stale_state(&recovery_app).await {
                    eprintln!("恢复系统代理状态失败：{error}");
                }
                let service_start =
                    service::request_core(&recovery_app, service::ServiceCommand::Start).await;
                match service_start {
                    Ok(Some(status)) if status.state == mihomo::CoreUserState::Ready => {
                        mihomo::traffic::start(&recovery_app);
                        mihomo::logs::start(&recovery_app);
                        tray::update_current_node(&recovery_app).await;
                    }
                    Ok(Some(status)) => diagnostics::record_event(
                        &recovery_app,
                        "error",
                        "mihomo",
                        status
                            .recovery_message
                            .unwrap_or_else(|| "Service Core 未达到 Ready".to_string()),
                    ),
                    Ok(None) | Err(_) => {
                        if let Err(error) = mihomo::start_owned_for_lifecycle(&recovery_app).await {
                            diagnostics::record_event(
                                &recovery_app,
                                "error",
                                "mihomo",
                                format!("自动准备 Core 失败：{error}"),
                            );
                        }
                    }
                }
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
                    let _ = window.set_skip_taskbar(true);
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
            diagnostics::diagnostic_bundle_generate,
            #[cfg(feature = "validation-fault-injection")]
            service::validation_crash_managed_core,
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
