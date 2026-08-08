#[cfg(windows)]
mod windows_service_host {
    use std::{
        env,
        ffi::OsString,
        fs,
        path::{Path, PathBuf},
        sync::mpsc,
        thread,
        time::Duration,
    };

    use mioproxy_lib::service::{self, SERVICE_NAME};
    use tokio::sync::watch;
    use windows_service::{
        define_windows_service,
        service::{
            ServiceAccess, ServiceControl, ServiceControlAccept, ServiceErrorControl,
            ServiceExitCode, ServiceInfo, ServiceStartType, ServiceState, ServiceStatus,
            ServiceType,
        },
        service_control_handler::{self, ServiceControlHandlerResult},
        service_dispatcher,
        service_manager::{ServiceManager, ServiceManagerAccess},
    };

    const SERVICE_DISPLAY_NAME: &str = "MioProxy Service";

    pub fn main() -> Result<(), String> {
        let args = env::args_os().skip(1).collect::<Vec<_>>();
        if has_flag(&args, "--install") {
            return install(&args);
        }
        if has_flag(&args, "--uninstall") {
            return uninstall();
        }
        let data_dir = option(&args, "--data-dir")
            .map(PathBuf::from)
            .unwrap_or_else(default_data_dir);
        let mihomo_path = option(&args, "--mihomo-path")
            .map(PathBuf::from)
            .unwrap_or_else(default_mihomo_path);
        if has_flag(&args, "--console") {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .map_err(|e| e.to_string())?;
            return runtime.block_on(service::run_service_console(data_dir, mihomo_path));
        }
        if !has_flag(&args, "--service") {
            return Err(
                "MioProxy Service 必须由 Windows SCM 以 --service 模式启动；已拒绝进入 Service dispatcher"
                    .to_string(),
            );
        }
        service_dispatcher::start(SERVICE_NAME, ffi_service_main)
            .map_err(|e| format!("启动 Windows Service dispatcher 失败：{e}"))
    }

    fn has_flag(args: &[OsString], flag: &str) -> bool {
        args.iter().any(|arg| arg == flag)
    }

    fn option(args: &[OsString], name: &str) -> Option<OsString> {
        args.windows(2)
            .find(|pair| pair[0] == name)
            .map(|pair| pair[1].clone())
    }

    #[cfg(test)]
    mod tests {
        use super::has_flag;
        use std::ffi::OsString;

        #[test]
        fn dispatcher_requires_explicit_service_mode() {
            let service_args = vec![OsString::from("--service")];
            let gui_args = vec![OsString::from("--data-dir"), OsString::from("C:\\data")];

            assert!(has_flag(&service_args, "--service"));
            assert!(!has_flag(&gui_args, "--service"));
        }
    }

    fn default_data_dir() -> PathBuf {
        env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
            .join("dev.MioProxy")
    }

    fn default_mihomo_path() -> PathBuf {
        let executable_dir = env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| PathBuf::from("."));
        [
            executable_dir.join("mihomo.exe"),
            executable_dir.join("mihomo-x86_64-pc-windows-msvc.exe"),
            executable_dir.join(r"binaries\mihomo-x86_64-pc-windows-msvc.exe"),
        ]
        .into_iter()
        .find(|path| path.exists())
        .unwrap_or_else(|| executable_dir.join("mihomo-x86_64-pc-windows-msvc.exe"))
    }

    fn protected_install_dir() -> PathBuf {
        env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"))
            .join("MioProxy")
    }

    fn copy_protected_binary(source: &Path, target: &Path, label: &str) -> Result<(), String> {
        let source = fs::canonicalize(source).map_err(|e| format!("解析 {label} 路径失败：{e}"))?;
        if fs::canonicalize(target)
            .ok()
            .is_some_and(|current| current == source)
        {
            return Ok(());
        }
        fs::copy(&source, target)
            .map(|_| ())
            .map_err(|e| format!("复制受保护的 {label} 失败：{e}"))
    }

    fn install(args: &[OsString]) -> Result<(), String> {
        let source_executable = fs::canonicalize(env::current_exe().map_err(|e| e.to_string())?)
            .map_err(|e| format!("解析 Service 可执行文件路径失败：{e}"))?;
        let data_dir = option(args, "--data-dir")
            .map(PathBuf::from)
            .unwrap_or_else(default_data_dir);
        let source_mihomo_path = option(args, "--mihomo-path")
            .map(PathBuf::from)
            .unwrap_or_else(default_mihomo_path);
        let source_mihomo_path = fs::canonicalize(source_mihomo_path)
            .map_err(|e| format!("解析 Service Mihomo 路径失败：{e}"))?;
        fs::create_dir_all(&data_dir).map_err(|e| format!("创建 Service 数据目录失败：{e}"))?;
        let data_dir =
            fs::canonicalize(&data_dir).map_err(|e| format!("解析 Service 数据目录失败：{e}"))?;
        let user_sid = option(args, "--user-sid").map(|value| value.to_string_lossy().into_owned());
        service::ensure_install_user_sid(&data_dir, user_sid.as_deref())?;
        service::ensure_install_token(&data_dir)?;
        let manager = ServiceManager::local_computer(
            None::<&str>,
            ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
        )
        .map_err(|e| format!("打开 Windows Service Manager 失败：{e}"))?;
        let service_access = ServiceAccess::CHANGE_CONFIG
            | ServiceAccess::START
            | ServiceAccess::QUERY_STATUS
            | ServiceAccess::STOP;
        let mut existing_service = match manager.open_service(SERVICE_NAME, service_access) {
            Ok(service) => Some(service),
            Err(windows_service::Error::Winapi(error)) if error.raw_os_error() == Some(1060) => {
                None
            }
            Err(error) => return Err(format!("打开现有 MioProxy Service 失败：{error}")),
        };
        if existing_service.as_ref().is_some_and(|service| {
            service
                .query_status()
                .map(|status| status.current_state == ServiceState::Running)
                .unwrap_or(false)
        }) {
            let service = existing_service.as_ref().expect("existing service checked");
            service
                .stop()
                .map_err(|e| format!("停止旧版 MioProxy Service 失败：{e}"))?;
            let stopped = (0..100).any(|_| {
                let is_stopped = service
                    .query_status()
                    .map(|status| status.current_state == ServiceState::Stopped)
                    .unwrap_or(false);
                if !is_stopped {
                    thread::sleep(Duration::from_millis(100));
                }
                is_stopped
            });
            if !stopped {
                return Err("旧版 MioProxy Service 未能在 10 秒内停止".to_string());
            }
        }

        let protected_dir = protected_install_dir();
        fs::create_dir_all(&protected_dir)
            .map_err(|e| format!("创建受保护的 MioProxy 安装目录失败：{e}"))?;
        let executable = protected_dir.join("mioproxy-service.exe");
        let mihomo_path = protected_dir.join("mihomo.exe");
        copy_protected_binary(&source_executable, &executable, "Service 可执行文件")?;
        copy_protected_binary(&source_mihomo_path, &mihomo_path, "Mihomo 可执行文件")?;

        let info = ServiceInfo {
            name: OsString::from(SERVICE_NAME),
            display_name: OsString::from(SERVICE_DISPLAY_NAME),
            service_type: ServiceType::OWN_PROCESS,
            start_type: ServiceStartType::AutoStart,
            error_control: ServiceErrorControl::Normal,
            executable_path: executable,
            launch_arguments: vec![
                OsString::from("--service"),
                OsString::from("--data-dir"),
                data_dir.into_os_string(),
                OsString::from("--mihomo-path"),
                mihomo_path.into_os_string(),
            ],
            dependencies: vec![],
            account_name: None,
            account_password: None,
        };
        let service = match manager.create_service(&info, service_access) {
            Ok(service) => service,
            Err(windows_service::Error::Winapi(error)) if error.raw_os_error() == Some(1073) => {
                existing_service
                    .take()
                    .ok_or_else(|| "MioProxy Service 已存在，但无法重新打开它".to_string())?
            }
            Err(error) => return Err(format!("创建 MioProxy Service 失败：{error}")),
        };
        service
            .change_config(&info)
            .map_err(|e| format!("更新 MioProxy Service 配置失败：{e}"))?;
        service
            .set_description("Owns MioProxy Mihomo, TUN, routes and recovery lifecycle")
            .map_err(|e| format!("写入 Service 描述失败：{e}"))?;
        match service.start::<OsString>(&[]) {
            Ok(()) => {}
            Err(windows_service::Error::Winapi(error)) if error.raw_os_error() == Some(1056) => {}
            Err(error) => return Err(format!("启动 MioProxy Service 失败：{error}")),
        }
        Ok(())
    }

    fn uninstall() -> Result<(), String> {
        let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
            .map_err(|e| format!("打开 Windows Service Manager 失败：{e}"))?;
        let service = manager
            .open_service(
                SERVICE_NAME,
                ServiceAccess::STOP | ServiceAccess::QUERY_STATUS | ServiceAccess::DELETE,
            )
            .map_err(|e| format!("打开 MioProxy Service 失败：{e}"))?;
        let status = service
            .query_status()
            .map_err(|e| format!("查询 MioProxy Service 状态失败：{e}"))?;
        if status.current_state != ServiceState::Stopped {
            match service.stop() {
                Ok(_) => {}
                Err(windows_service::Error::Winapi(error))
                    if error.raw_os_error() == Some(1062) => {}
                Err(error) => return Err(format!("停止 MioProxy Service 失败：{error}")),
            }
            let stopped = (0..100).any(|_| {
                let is_stopped = service
                    .query_status()
                    .map(|next| next.current_state == ServiceState::Stopped)
                    .unwrap_or(false);
                if !is_stopped {
                    thread::sleep(Duration::from_millis(100));
                }
                is_stopped
            });
            if !stopped {
                return Err("MioProxy Service 未能在 10 秒内停止".to_string());
            }
        }
        let final_status = service
            .query_status()
            .map_err(|e| format!("查询 MioProxy Service 停止结果失败：{e}"))?;
        if final_status.exit_code != ServiceExitCode::NO_ERROR {
            return Err(
                "MioProxy Service 停止时未完成 TUN 恢复，已保留 Service 以便重试清理".to_string(),
            );
        }
        service
            .delete()
            .map_err(|e| format!("删除 MioProxy Service 失败：{e}"))?;
        Ok(())
    }

    define_windows_service!(ffi_service_main, service_main);

    fn service_main(arguments: Vec<OsString>) {
        let _ = run_service(arguments);
    }

    fn run_service(arguments: Vec<OsString>) -> Result<(), String> {
        // ServiceInfo.launch_arguments are part of the process command line,
        // while service_main receives only arguments passed to StartService.
        // Read the launch command line first so an installed service keeps
        // using the same data directory and Mihomo binary as the GUI.
        let process_arguments = env::args_os().skip(1).collect::<Vec<_>>();
        let data_dir = option(&process_arguments, "--data-dir")
            .or_else(|| option(&arguments, "--data-dir"))
            .map(PathBuf::from)
            .unwrap_or_else(default_data_dir);
        let mihomo_path = option(&process_arguments, "--mihomo-path")
            .or_else(|| option(&arguments, "--mihomo-path"))
            .map(PathBuf::from)
            .unwrap_or_else(default_mihomo_path);
        let (shutdown_sender, shutdown_receiver) = watch::channel(false);
        let (stop_sender, stop_receiver) = mpsc::channel::<()>();
        let event_handler = move |event| -> ServiceControlHandlerResult {
            match event {
                ServiceControl::Stop | ServiceControl::Shutdown => {
                    let _ = stop_sender.send(());
                    ServiceControlHandlerResult::NoError
                }
                ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
                _ => ServiceControlHandlerResult::NotImplemented,
            }
        };
        let status_handle = service_control_handler::register(SERVICE_NAME, event_handler)
            .map_err(|e| format!("注册 MioProxy Service 控制处理器失败：{e}"))?;
        status_handle
            .set_service_status(ServiceStatus {
                service_type: ServiceType::OWN_PROCESS,
                current_state: ServiceState::Running,
                controls_accepted: ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
                exit_code: ServiceExitCode::Win32(0),
                checkpoint: 0,
                wait_hint: Duration::default(),
                process_id: None,
            })
            .map_err(|e| format!("报告 MioProxy Service 启动状态失败：{e}"))?;

        let stop_sender_for_thread = shutdown_sender.clone();
        std::thread::spawn(move || {
            if stop_receiver.recv().is_ok() {
                let _ = stop_sender_for_thread.send(true);
            }
        });
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        let result = runtime.block_on(service::run_service_daemon(
            data_dir,
            mihomo_path,
            shutdown_receiver,
        ));
        let exit_code = if result.is_ok() { 0 } else { 1 };
        let _ = status_handle.set_service_status(ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: ServiceState::Stopped,
            controls_accepted: ServiceControlAccept::empty(),
            exit_code: ServiceExitCode::Win32(exit_code),
            checkpoint: 0,
            wait_hint: Duration::default(),
            process_id: None,
        });
        result
    }
}

#[cfg(windows)]
fn main() {
    if let Err(error) = windows_service_host::main() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    panic!("mioproxy-service is only supported on Windows");
}
