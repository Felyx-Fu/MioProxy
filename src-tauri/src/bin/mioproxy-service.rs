#[cfg(windows)]
mod windows_service_host {
    use std::{
        env,
        ffi::OsString,
        fs,
        path::{Path, PathBuf},
        process::Command,
        sync::mpsc,
        thread,
        time::Duration,
    };

    use mioproxy_lib::service::{self, SERVICE_NAME};
    use serde::Deserialize;
    use tokio::sync::watch;
    use windows_service::{
        define_windows_service,
        service::{
            Service, ServiceAccess, ServiceAction, ServiceActionType, ServiceControl,
            ServiceControlAccept, ServiceErrorControl, ServiceExitCode, ServiceFailureActions,
            ServiceFailureResetPeriod, ServiceInfo, ServiceStartType, ServiceState, ServiceStatus,
            ServiceType,
        },
        service_control_handler::{self, ServiceControlHandlerResult},
        service_dispatcher,
        service_manager::{ServiceManager, ServiceManagerAccess},
    };

    const SERVICE_DISPLAY_NAME: &str = "MioProxy Service";
    const FAILURE_RESET_PERIOD_SECS: u64 = 60 * 60;
    const FAILURE_RESTART_DELAYS_SECS: [u64; 3] = [5, 15, 30];
    const UPDATER_INSTALLER_FLAG: &str = "/MIOPROXY_UPDATER";
    const UPDATE_CHECKPOINT_FILE: &str = "update-checkpoint.json";
    // With this flag disabled, SCM only queues failure actions when the
    // process exits without reporting SERVICE_STOPPED. Normal Stop/Shutdown
    // therefore remains intentional, including installer and uninstall stops.
    const FAILURE_ACTIONS_ON_NON_CRASH_FAILURES: bool = false;

    #[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "lowercase")]
    enum UpdateInstallPhase {
        Preparing,
        Installing,
        Restarting,
        Completed,
        Failed,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct UpdaterInstallCheckpoint {
        previous_version: String,
        target_version: String,
        #[serde(default)]
        service_was_running: bool,
        #[serde(default)]
        core_was_running: bool,
        phase: UpdateInstallPhase,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum InstallStartPolicy {
        StartService,
        PreserveStoppedState,
    }

    fn install_start_policy(
        updater_invocation: bool,
        checkpoint: Option<&UpdaterInstallCheckpoint>,
    ) -> InstallStartPolicy {
        let preserve_stopped = updater_invocation
            && checkpoint.is_some_and(|checkpoint| {
                matches!(
                    checkpoint.phase,
                    UpdateInstallPhase::Preparing
                        | UpdateInstallPhase::Installing
                        | UpdateInstallPhase::Restarting
                ) && checkpoint.previous_version != checkpoint.target_version
                    && !checkpoint.service_was_running
                    && !checkpoint.core_was_running
            });
        if preserve_stopped {
            InstallStartPolicy::PreserveStoppedState
        } else {
            InstallStartPolicy::StartService
        }
    }

    fn read_updater_checkpoint(
        data_dir: &Path,
    ) -> Result<Option<UpdaterInstallCheckpoint>, String> {
        let path = data_dir.join(UPDATE_CHECKPOINT_FILE);
        match fs::read_to_string(&path) {
            Ok(content) => serde_json::from_str(&content)
                .map(Some)
                .map_err(|error| format!("读取更新检查点失败：{error}")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("读取更新检查点失败：{error}")),
        }
    }

    pub fn main() -> Result<(), String> {
        let args = env::args_os().skip(1).collect::<Vec<_>>();
        if has_flag(&args, "--install") {
            return install(&args);
        }
        if has_flag(&args, "--uninstall") {
            return uninstall(false);
        }
        if has_flag(&args, "--uninstall-if-present") {
            return uninstall(true);
        }
        if let Some(port) = diagnostic_port(&args)? {
            let diagnostics = service::port_diagnostics(port)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&diagnostics).map_err(|error| error.to_string())?
            );
            return Ok(());
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

    fn diagnostic_port(args: &[OsString]) -> Result<Option<u16>, String> {
        let value = option(args, "--port-diagnostics").or_else(|| {
            args.windows(2)
                .find(|pair| pair[0] == "port-diagnostics")
                .map(|pair| pair[1].clone())
        });
        value
            .map(|value| {
                value
                    .to_string_lossy()
                    .parse::<u16>()
                    .map_err(|_| "port-diagnostics 需要 1 到 65535 的 TCP 端口".to_string())
                    .and_then(|port| {
                        (port != 0).then_some(port).ok_or_else(|| {
                            "port-diagnostics 需要 1 到 65535 的 TCP 端口".to_string()
                        })
                    })
            })
            .transpose()
    }

    #[cfg(test)]
    mod tests {
        use super::{
            configured_failure_actions, diagnostic_port, has_flag, install_start_policy,
            InstallStartPolicy, UpdateInstallPhase, UpdaterInstallCheckpoint,
            FAILURE_ACTIONS_ON_NON_CRASH_FAILURES, FAILURE_RESET_PERIOD_SECS,
            FAILURE_RESTART_DELAYS_SECS, UPDATER_INSTALLER_FLAG,
        };
        use std::{ffi::OsString, time::Duration};
        use windows_service::service::{ServiceActionType, ServiceFailureResetPeriod};

        #[test]
        fn dispatcher_requires_explicit_service_mode() {
            let service_args = vec![OsString::from("--service")];
            let gui_args = vec![OsString::from("--data-dir"), OsString::from("C:\\data")];

            assert!(has_flag(&service_args, "--service"));
            assert!(!has_flag(&gui_args, "--service"));
        }

        #[test]
        fn parses_developer_port_diagnostics_command() {
            assert_eq!(
                diagnostic_port(&[OsString::from("port-diagnostics"), OsString::from("7890")])
                    .unwrap(),
                Some(7890)
            );
            assert!(
                diagnostic_port(&[OsString::from("--port-diagnostics"), OsString::from("0")])
                    .is_err()
            );
        }

        fn checkpoint(
            phase: UpdateInstallPhase,
            service_was_running: bool,
            core_was_running: bool,
        ) -> UpdaterInstallCheckpoint {
            UpdaterInstallCheckpoint {
                previous_version: "1.0.2".to_string(),
                target_version: "1.0.3".to_string(),
                service_was_running,
                core_was_running,
                phase,
            }
        }

        #[test]
        fn updater_install_preserves_stopped_service_without_changing_fresh_install() {
            let stopped = checkpoint(UpdateInstallPhase::Restarting, false, false);
            assert_eq!(
                install_start_policy(true, Some(&stopped)),
                InstallStartPolicy::PreserveStoppedState
            );
            assert_eq!(
                install_start_policy(false, Some(&stopped)),
                InstallStartPolicy::StartService
            );
            assert!(has_flag(
                &[OsString::from(UPDATER_INSTALLER_FLAG)],
                UPDATER_INSTALLER_FLAG
            ));
        }

        #[test]
        fn updater_install_keeps_running_service_recovery_possible() {
            let running = checkpoint(UpdateInstallPhase::Restarting, true, false);
            assert_eq!(
                install_start_policy(true, Some(&running)),
                InstallStartPolicy::StartService
            );
            let running_core = checkpoint(UpdateInstallPhase::Restarting, false, true);
            assert_eq!(
                install_start_policy(true, Some(&running_core)),
                InstallStartPolicy::StartService
            );
            assert_eq!(
                install_start_policy(
                    true,
                    Some(&checkpoint(UpdateInstallPhase::Preparing, false, false))
                ),
                InstallStartPolicy::PreserveStoppedState
            );
            assert_eq!(
                install_start_policy(
                    true,
                    Some(&checkpoint(UpdateInstallPhase::Completed, false, false))
                ),
                InstallStartPolicy::StartService
            );
            assert_eq!(
                install_start_policy(true, None),
                InstallStartPolicy::StartService
            );
        }

        #[test]
        fn configures_bounded_failure_actions_with_terminal_noop() {
            let configuration = configured_failure_actions();
            assert_eq!(
                configuration.reset_period,
                ServiceFailureResetPeriod::After(Duration::from_secs(FAILURE_RESET_PERIOD_SECS))
            );
            let actions = configuration.actions.expect("failure actions configured");
            assert_eq!(actions.len(), FAILURE_RESTART_DELAYS_SECS.len() + 1);
            assert_eq!(
                actions
                    .iter()
                    .map(|action| action.action_type)
                    .collect::<Vec<_>>(),
                vec![
                    ServiceActionType::Restart,
                    ServiceActionType::Restart,
                    ServiceActionType::Restart,
                    ServiceActionType::None,
                ]
            );
            assert_eq!(
                actions
                    .iter()
                    .map(|action| action.delay.as_secs())
                    .collect::<Vec<_>>(),
                vec![5, 15, 30, 0]
            );
            assert_eq!(actions.last().unwrap().action_type, ServiceActionType::None);
        }

        #[test]
        fn excludes_intentional_stopped_status_from_failure_actions() {
            let applies_to_non_crash_failures =
                std::hint::black_box(FAILURE_ACTIONS_ON_NON_CRASH_FAILURES);
            assert!(!applies_to_non_crash_failures);
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
        let start_policy = if has_flag(args, UPDATER_INSTALLER_FLAG) {
            let checkpoint = read_updater_checkpoint(&data_dir)?;
            install_start_policy(true, checkpoint.as_ref())
        } else {
            install_start_policy(false, None)
        };
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
        if existing_service.is_some() {
            disable_service_start_for_maintenance()?;
        }
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
        configure_failure_actions(&service)?;
        if start_policy == InstallStartPolicy::StartService {
            match service.start::<OsString>(&[]) {
                Ok(()) => {}
                Err(windows_service::Error::Winapi(error))
                    if error.raw_os_error() == Some(1056) => {}
                Err(error) => return Err(format!("启动 MioProxy Service 失败：{error}")),
            }
        }
        Ok(())
    }

    fn configured_failure_actions() -> ServiceFailureActions {
        let mut actions = FAILURE_RESTART_DELAYS_SECS
            .into_iter()
            .map(|delay| ServiceAction {
                action_type: ServiceActionType::Restart,
                delay: Duration::from_secs(delay),
            })
            .collect::<Vec<_>>();
        // Windows repeats the last action after cActions is exhausted. Keep
        // the final action non-restarting so recovery remains bounded.
        actions.push(ServiceAction {
            action_type: ServiceActionType::None,
            delay: Duration::default(),
        });
        ServiceFailureActions {
            reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(
                FAILURE_RESET_PERIOD_SECS,
            )),
            reboot_msg: None,
            command: None,
            actions: Some(actions),
        }
    }

    fn configure_failure_actions(service: &Service) -> Result<(), String> {
        service
            .update_failure_actions(configured_failure_actions())
            .map_err(|error| format!("配置 MioProxy Service 自动恢复动作失败：{error}"))?;
        service
            .set_failure_actions_on_non_crash_failures(FAILURE_ACTIONS_ON_NON_CRASH_FAILURES)
            .map_err(|error| format!("配置 MioProxy Service 停止语义失败：{error}"))
    }

    fn disable_service_start_for_maintenance() -> Result<(), String> {
        let sc_path = env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
            .join("System32")
            .join("sc.exe");
        let status = Command::new(sc_path)
            .args(["config", SERVICE_NAME, "start=", "disabled"])
            .status()
            .map_err(|error| format!("禁用 MioProxy Service 自动启动失败：{error}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "禁用 MioProxy Service 自动启动失败，sc.exe 退出码：{}",
                status
                    .code()
                    .map_or_else(|| "未知".to_string(), |code| code.to_string())
            ))
        }
    }

    fn uninstall(ignore_missing: bool) -> Result<(), String> {
        let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
            .map_err(|e| format!("打开 Windows Service Manager 失败：{e}"))?;
        let service = match manager.open_service(
            SERVICE_NAME,
            ServiceAccess::STOP | ServiceAccess::QUERY_STATUS | ServiceAccess::DELETE,
        ) {
            Ok(service) => service,
            Err(windows_service::Error::Winapi(error))
                if ignore_missing && error.raw_os_error() == Some(1060) =>
            {
                return Ok(());
            }
            Err(error) => return Err(format!("打开 MioProxy Service 失败：{error}")),
        };
        disable_service_start_for_maintenance()?;
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
        if result.is_ok() {
            // Only report SERVICE_STOPPED after a controlled shutdown. If the
            // daemon fails, let the process exit without that status so SCM
            // classifies it as a failure and applies the bounded policy.
            let _ = status_handle.set_service_status(ServiceStatus {
                service_type: ServiceType::OWN_PROCESS,
                current_state: ServiceState::Stopped,
                controls_accepted: ServiceControlAccept::empty(),
                exit_code: ServiceExitCode::NO_ERROR,
                checkpoint: 0,
                wait_hint: Duration::default(),
                process_id: None,
            });
        }
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
