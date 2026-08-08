use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

pub const SERVICE_NAME: &str = "MioProxyService";
pub const PIPE_NAME: &str = r"\\.\pipe\MioProxyService";
pub const SERVICE_PROTOCOL_VERSION: u32 = 1;
pub const SERVICE_VERSION: &str = env!("CARGO_PKG_VERSION");
const TOKEN_FILE: &str = "service-token";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "camelCase")]
pub enum ServiceCommand {
    Status,
    Start,
    Stop,
    Reload,
    ApplyProfile {
        profile_id: String,
    },
    TunSetEnabled {
        enabled: bool,
        profile_id: Option<String>,
        system_proxy_enabled: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceRequest {
    pub protocol_version: u32,
    pub client_version: String,
    pub token: String,
    pub command: ServiceCommand,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceResponse {
    pub protocol_version: u32,
    pub service_version: String,
    pub ok: bool,
    pub error: Option<String>,
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatusData {
    pub core: crate::mihomo::CoreStatus,
    pub running: bool,
    pub owns_core: bool,
    pub ownership_conflict: bool,
    pub admin: bool,
    pub tun_status: String,
    pub tun_message: Option<String>,
    pub tun_profile_id: Option<String>,
    pub tun_snapshot: Option<crate::tun::NetworkSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceConnectionStatus {
    pub reachable: bool,
    pub protocol_version: u32,
    pub service_version: Option<String>,
    pub owns_core: bool,
    pub core_running: bool,
    pub ownership_conflict: bool,
    pub tun_status: Option<String>,
    pub tun_message: Option<String>,
}

pub(crate) fn token_path(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join(TOKEN_FILE)
}

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use std::{
        fs, io,
        path::{Path, PathBuf},
        process::{Child, Command, Stdio},
        sync::{Arc, Mutex},
        time::Duration,
    };

    use serde::Deserialize;
    use serde_json::json;
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions},
        sync::watch,
    };
    use windows_service::{
        service::ServiceAccess,
        service_manager::{ServiceManager, ServiceManagerAccess},
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
            },
            SECURITY_ATTRIBUTES,
        },
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            SystemInformation::GetTickCount64,
            Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
        },
    };

    use crate::{config, mihomo};

    fn is_admin() -> bool {
        unsafe { windows_sys::Win32::UI::Shell::IsUserAnAdmin() != 0 }
    }

    struct JobGuard {
        handle: HANDLE,
    }

    unsafe impl Send for JobGuard {}
    unsafe impl Sync for JobGuard {}

    impl JobGuard {
        fn new() -> Result<Self, String> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err("创建 Mihomo Job Object 失败".to_string());
            }
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if configured == 0 {
                unsafe { CloseHandle(handle) };
                return Err("配置 Mihomo Job Object 失败".to_string());
            }
            Ok(Self { handle })
        }

        fn assign(&self, process_id: u32) -> Result<(), String> {
            let process =
                unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, process_id) };
            if process.is_null() {
                return Err("打开 Mihomo 进程失败，无法绑定 Job Object".to_string());
            }
            let assigned = unsafe { AssignProcessToJobObject(self.handle, process) };
            unsafe { CloseHandle(process) };
            if assigned == 0 {
                return Err("绑定 Mihomo Job Object 失败".to_string());
            }
            Ok(())
        }
    }

    impl Drop for JobGuard {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.handle) };
        }
    }

    fn ensure_token(data_dir: &Path) -> Result<String, String> {
        fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
        let path = token_path(data_dir);
        if path.exists() {
            let token = fs::read_to_string(path).map_err(|e| e.to_string())?;
            if !token.trim().is_empty() {
                return Ok(token.trim().to_string());
            }
        }
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|e| format!("生成 Service 令牌失败：{e}"))?;
        let token = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        fs::write(token_path(data_dir), &token).map_err(|e| e.to_string())?;
        Ok(token)
    }

    fn client_token(app: &AppHandle) -> Result<String, String> {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let path = token_path(&data_dir);
        fs::read_to_string(path)
            .map(|token| token.trim().to_string())
            .map_err(|_| "MioProxy Service 令牌不存在，请先启动或安装 Service".to_string())
    }

    fn is_pipe_missing(error: &io::Error) -> bool {
        matches!(error.raw_os_error(), Some(2 | 3))
    }

    fn service_is_installed() -> Result<bool, String> {
        let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
            .map_err(|error| format!("查询 MioProxy Service 失败：{error}"))?;
        match manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS) {
            Ok(_) => Ok(true),
            Err(windows_service::Error::Winapi(error)) if error.raw_os_error() == Some(1060) => {
                Ok(false)
            }
            Err(error) => Err(format!("查询 MioProxy Service 失败：{error}")),
        }
    }

    pub(crate) async fn try_request(
        app: &AppHandle,
        command: ServiceCommand,
    ) -> Result<Option<ServiceResponse>, String> {
        let mut client = match ClientOptions::new().open(PIPE_NAME) {
            Ok(client) => client,
            Err(error) if is_pipe_missing(&error) => {
                if service_is_installed()? {
                    return Err(
                        "MioProxy Service 已安装但当前 IPC 不可用，已阻止 GUI 接管 Mihomo"
                            .to_string(),
                    );
                }
                return Ok(None);
            }
            Err(error) => return Err(format!("连接 MioProxy Service 失败：{error}")),
        };
        let request = ServiceRequest {
            protocol_version: SERVICE_PROTOCOL_VERSION,
            client_version: SERVICE_VERSION.to_string(),
            token: client_token(app)?,
            command,
        };
        let line = serde_json::to_string(&request).map_err(|e| e.to_string())? + "\n";
        client
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("写入 Service 请求失败：{e}"))?;
        client
            .flush()
            .await
            .map_err(|e| format!("发送 Service 请求失败：{e}"))?;
        let mut reader = BufReader::new(client);
        let mut response_line = String::new();
        reader
            .read_line(&mut response_line)
            .await
            .map_err(|e| format!("读取 Service 响应失败：{e}"))?;
        let response = serde_json::from_str::<ServiceResponse>(&response_line)
            .map_err(|e| format!("Service 响应无效：{e}"))?;
        if response.protocol_version != SERVICE_PROTOCOL_VERSION {
            return Err(format!(
                "MioProxy Service 协议版本不匹配：GUI={}，Service={}",
                SERVICE_PROTOCOL_VERSION, response.protocol_version
            ));
        }
        if response.service_version != SERVICE_VERSION {
            return Err(format!(
                "MioProxy Service 版本不匹配：GUI={}，Service={}",
                SERVICE_VERSION, response.service_version
            ));
        }
        if !response.ok {
            return Err(response
                .error
                .unwrap_or_else(|| "MioProxy Service 请求失败".to_string()));
        }
        Ok(Some(response))
    }

    pub(crate) fn data<T: for<'de> Deserialize<'de>>(
        response: ServiceResponse,
    ) -> Result<T, String> {
        serde_json::from_value(
            response
                .data
                .ok_or_else(|| "Service 响应缺少数据".to_string())?,
        )
        .map_err(|e| format!("Service 响应数据无效：{e}"))
    }

    pub(crate) async fn service_status(app: AppHandle) -> Result<ServiceConnectionStatus, String> {
        let Some(response) = try_request(&app, ServiceCommand::Status).await? else {
            return Ok(ServiceConnectionStatus {
                reachable: false,
                protocol_version: SERVICE_PROTOCOL_VERSION,
                service_version: None,
                owns_core: false,
                core_running: false,
                ownership_conflict: false,
                tun_status: None,
                tun_message: None,
            });
        };
        let status: ServiceStatusData = data(response)?;
        Ok(ServiceConnectionStatus {
            reachable: true,
            protocol_version: SERVICE_PROTOCOL_VERSION,
            service_version: Some(SERVICE_VERSION.to_string()),
            owns_core: status.owns_core,
            core_running: status.core.running,
            ownership_conflict: status.ownership_conflict,
            tun_status: Some(status.tun_status),
            tun_message: status.tun_message,
        })
    }

    pub(crate) async fn service_tun_status(
        app: &AppHandle,
    ) -> Result<Option<crate::tun::TunStatusSnapshot>, String> {
        let Some(response) = try_request(app, ServiceCommand::Status).await? else {
            return Ok(None);
        };
        let status: ServiceStatusData = data(response)?;
        let tun_status = match status.tun_status.as_str() {
            "disabled" => crate::tun::TunStatus::Disabled,
            "starting" => crate::tun::TunStatus::Starting,
            "running" => crate::tun::TunStatus::Running,
            "stopping" => crate::tun::TunStatus::Stopping,
            _ => crate::tun::TunStatus::Error,
        };
        Ok(Some(crate::tun::TunStatusSnapshot {
            status: tun_status,
            message: status.tun_message,
            admin: status.admin,
            profile_id: status.tun_profile_id,
            snapshot: status.tun_snapshot,
        }))
    }

    pub(crate) async fn request_core(
        app: &AppHandle,
        command: ServiceCommand,
    ) -> Result<Option<crate::mihomo::CoreStatus>, String> {
        let Some(response) = try_request(app, command).await? else {
            return Ok(None);
        };
        data(response).map(Some)
    }

    pub(crate) async fn request_core_status(
        app: &AppHandle,
    ) -> Result<Option<crate::mihomo::CoreStatus>, String> {
        let Some(response) = try_request(app, ServiceCommand::Status).await? else {
            return Ok(None);
        };
        let status: ServiceStatusData = data(response)?;
        Ok(Some(status.core))
    }

    pub(crate) async fn request_reload(app: &AppHandle) -> Result<Option<Value>, String> {
        let Some(response) = try_request(app, ServiceCommand::Reload).await? else {
            return Ok(None);
        };
        Ok(Some(response.data.unwrap_or(Value::Null)))
    }

    pub(crate) async fn request_apply_profile(
        app: &AppHandle,
        profile_id: &str,
    ) -> Result<Option<crate::config::ConfigApplyResult>, String> {
        let Some(response) = try_request(
            app,
            ServiceCommand::ApplyProfile {
                profile_id: profile_id.to_string(),
            },
        )
        .await?
        else {
            return Ok(None);
        };
        data(response).map(Some)
    }

    pub(crate) async fn request_tun(
        app: &AppHandle,
        enabled: bool,
        profile_id: Option<String>,
        system_proxy_enabled: bool,
    ) -> Result<Option<crate::tun::TunStatusSnapshot>, String> {
        let command = ServiceCommand::TunSetEnabled {
            enabled,
            profile_id,
            system_proxy_enabled,
        };
        let Some(response) = try_request(app, command).await? else {
            return Ok(None);
        };
        let value: ServiceTunData = data(response)?;
        Ok(Some(value.into_snapshot()))
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ServiceTunData {
        status: String,
        message: Option<String>,
        admin: bool,
        profile_id: Option<String>,
        snapshot: Option<crate::tun::NetworkSnapshot>,
    }

    impl ServiceTunData {
        fn into_snapshot(self) -> crate::tun::TunStatusSnapshot {
            let status = match self.status.as_str() {
                "disabled" => crate::tun::TunStatus::Disabled,
                "starting" => crate::tun::TunStatus::Starting,
                "running" => crate::tun::TunStatus::Running,
                "stopping" => crate::tun::TunStatus::Stopping,
                _ => crate::tun::TunStatus::Error,
            };
            crate::tun::TunStatusSnapshot {
                status,
                message: self.message,
                admin: self.admin,
                profile_id: self.profile_id,
                snapshot: self.snapshot,
            }
        }
    }

    struct ServiceTunState {
        status: crate::tun::TunStatus,
        message: Option<String>,
        profile_id: Option<String>,
        previous_override: Option<String>,
        snapshot: Option<crate::tun::NetworkSnapshot>,
    }

    impl Default for ServiceTunState {
        fn default() -> Self {
            Self {
                status: crate::tun::TunStatus::Disabled,
                message: None,
                profile_id: None,
                previous_override: None,
                snapshot: None,
            }
        }
    }

    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PersistedServiceTunState {
        previous_override: String,
        profile_id: String,
        snapshot: crate::tun::NetworkSnapshot,
    }

    struct ServiceRuntime {
        data_dir: PathBuf,
        mihomo_path: PathBuf,
        child: Mutex<Option<Child>>,
        job: JobGuard,
        tun: Mutex<ServiceTunState>,
    }

    impl ServiceRuntime {
        fn new(data_dir: PathBuf, mihomo_path: PathBuf) -> Result<Self, String> {
            fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
            let _ = ensure_token(&data_dir)?;
            Ok(Self {
                data_dir,
                mihomo_path,
                child: Mutex::new(None),
                job: JobGuard::new()?,
                tun: Mutex::new(ServiceTunState::default()),
            })
        }

        fn config_path(&self) -> PathBuf {
            config::config_path_at(&self.data_dir)
        }

        fn service_tun_path(&self) -> PathBuf {
            self.data_dir.join("service-tun-state.json")
        }

        fn read_tun_persisted(&self) -> Result<Option<PersistedServiceTunState>, String> {
            let path = self.service_tun_path();
            if !path.exists() {
                return Ok(None);
            }
            let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
            serde_json::from_str(&content)
                .map(Some)
                .map_err(|e| e.to_string())
        }

        fn write_tun_persisted(&self) -> Result<(), String> {
            let tun = self.tun.lock().map_err(|_| "Service TUN 状态锁异常")?;
            let state = PersistedServiceTunState {
                previous_override: tun
                    .previous_override
                    .clone()
                    .ok_or_else(|| "Service TUN 缺少恢复用 Override 快照".to_string())?,
                profile_id: tun
                    .profile_id
                    .clone()
                    .ok_or_else(|| "Service TUN 缺少恢复用 Profile".to_string())?,
                snapshot: tun
                    .snapshot
                    .clone()
                    .ok_or_else(|| "Service TUN 缺少网络快照".to_string())?,
            };
            let path = self.service_tun_path();
            let temp = path.with_extension("tmp");
            fs::write(
                &temp,
                serde_json::to_vec_pretty(&state).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            if path.exists() {
                fs::remove_file(&path).map_err(|e| e.to_string())?;
            }
            fs::rename(temp, path).map_err(|e| e.to_string())
        }

        fn clear_tun_persisted(&self) -> Result<(), String> {
            let path = self.service_tun_path();
            if path.exists() {
                fs::remove_file(path).map_err(|e| e.to_string())?;
            }
            Ok(())
        }

        fn tun_data(&self) -> Result<ServiceTunData, String> {
            let tun = self.tun.lock().map_err(|_| "Service TUN 状态锁异常")?;
            Ok(ServiceTunData {
                status: match tun.status {
                    crate::tun::TunStatus::Disabled => "disabled",
                    crate::tun::TunStatus::Starting => "starting",
                    crate::tun::TunStatus::Running => "running",
                    crate::tun::TunStatus::Stopping => "stopping",
                    crate::tun::TunStatus::Error => "error",
                }
                .to_string(),
                message: tun.message.clone(),
                admin: is_admin(),
                profile_id: tun.profile_id.clone(),
                snapshot: tun.snapshot.clone(),
            })
        }

        fn refresh_child(&self) -> Result<(), String> {
            let mut child = self.child.lock().map_err(|_| "Service Mihomo 状态锁异常")?;
            if let Some(process) = child.as_mut() {
                if process.try_wait().map_err(|e| e.to_string())?.is_some() {
                    *child = None;
                }
            }
            Ok(())
        }

        fn owns_core(&self) -> Result<bool, String> {
            self.refresh_child()?;
            Ok(self
                .child
                .lock()
                .map_err(|_| "Service Mihomo 状态锁异常")?
                .is_some())
        }

        fn default_config(&self) -> Result<(), String> {
            if self.config_path().exists() {
                return Ok(());
            }
            let yaml = format!(
                r#"mixed-port: 7890
allow-lan: false
bind-address: 127.0.0.1
mode: rule
log-level: info
ipv6: true
external-controller: {controller}
secret: "{secret}"

proxies: []

proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - DIRECT

rules:
  - MATCH,PROXY
"#,
                controller = mihomo::CONTROLLER,
                secret = mihomo::SECRET,
            );
            write_atomic(&self.config_path(), yaml.as_bytes())
        }

        fn runtime_config(&self) -> Result<(u16, String), String> {
            #[derive(Deserialize)]
            struct RuntimeConfig {
                #[serde(rename = "mixed-port")]
                mixed_port: Option<u16>,
                mode: Option<String>,
            }
            if !self.config_path().exists() {
                return Ok((7890, "rule".to_string()));
            }
            let value = serde_yaml::from_str::<RuntimeConfig>(
                &fs::read_to_string(self.config_path()).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            Ok((
                value.mixed_port.unwrap_or(7890),
                value.mode.unwrap_or_else(|| "rule".to_string()),
            ))
        }

        async fn core_status(&self) -> Result<crate::mihomo::CoreStatus, String> {
            let running = mihomo::is_running().await;
            let (mixed_port, mode) = self.runtime_config()?;
            Ok(crate::mihomo::CoreStatus {
                running,
                controller: mihomo::CONTROLLER.to_string(),
                config_path: self.config_path().display().to_string(),
                mixed_port,
                mode,
            })
        }

        async fn start(&self) -> Result<crate::mihomo::CoreStatus, String> {
            if self.owns_core()? {
                return self.core_status().await;
            }
            if mihomo::is_running().await {
                return Err("检测到已有非 Service 管理的 Mihomo，拒绝启动以避免双实例".to_string());
            }
            self.default_config()?;
            if !self.mihomo_path.exists() {
                return Err(format!(
                    "找不到 Service 使用的 Mihomo：{}",
                    self.mihomo_path.display()
                ));
            }
            let mut command = Command::new(&self.mihomo_path);
            command
                .args(["-d", self.data_dir.to_string_lossy().as_ref()])
                .args(["-f", self.config_path().to_string_lossy().as_ref()])
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let mut child = command
                .spawn()
                .map_err(|e| format!("Service 启动 Mihomo 失败：{e}"))?;
            if let Err(error) = self.job.assign(child.id()) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            *self.child.lock().map_err(|_| "Service Mihomo 状态锁异常")? = Some(child);
            for _ in 0..50 {
                if mihomo::is_running().await {
                    return self.core_status().await;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            if let Some(mut child) = self
                .child
                .lock()
                .map_err(|_| "Service Mihomo 状态锁异常")?
                .take()
            {
                let _ = child.kill();
                let _ = child.wait();
            }
            Err("Service 启动 Mihomo 超时，已清理子进程".to_string())
        }

        async fn stop(&self) -> Result<crate::mihomo::CoreStatus, String> {
            let owns_core = self.owns_core()?;
            if owns_core {
                let tun_status = self.tun_data()?.status;
                if tun_status == "running" || tun_status == "starting" || tun_status == "stopping" {
                    self.disable_tun().await?;
                }
                if let Some(mut child) = self
                    .child
                    .lock()
                    .map_err(|_| "Service Mihomo 状态锁异常")?
                    .take()
                {
                    child
                        .kill()
                        .map_err(|e| format!("Service 停止 Mihomo 失败：{e}"))?;
                    let _ = child.wait();
                }
            } else if mihomo::is_running().await {
                return Err("当前 Mihomo 不是 Service 管理，拒绝停止".to_string());
            }
            self.core_status().await
        }

        async fn reload(&self) -> Result<Value, String> {
            if !self.owns_core()? {
                return Err("Service 当前没有拥有 Mihomo，拒绝重载".to_string());
            }
            mihomo::api_put(
                "/configs?force=true",
                json!({ "path": self.config_path().display().to_string() }),
            )
            .await
        }

        async fn apply_profile(
            &self,
            profile_id: &str,
        ) -> Result<crate::config::ConfigApplyResult, String> {
            let built = config::build_value_at(&self.data_dir, profile_id)?;
            let profile_name = built.profile.name.clone();
            let override_active = built.override_active;
            let yaml = serde_yaml::to_string(&built.value).map_err(|e| e.to_string())?;
            let candidate = config::candidate_path_at(&self.data_dir);
            write_atomic(&candidate, yaml.as_bytes())?;
            if !mihomo::is_running().await {
                let _ = fs::remove_file(candidate);
                return Err("Mihomo 未运行，无法加载配置".to_string());
            }
            let result = mihomo::api_put(
                "/configs?force=true",
                json!({ "path": candidate.display().to_string() }),
            )
            .await;
            if let Err(error) = result {
                let _ = fs::remove_file(&candidate);
                return Err(format!("Mihomo 配置校验失败：{error}"));
            }
            write_atomic(&self.config_path(), yaml.as_bytes())?;
            let _ = fs::remove_file(candidate);
            Ok(crate::config::ConfigApplyResult {
                profile_id: profile_id.to_string(),
                profile_name,
                path: self.config_path().display().to_string(),
                controller_validated: true,
                override_active,
            })
        }

        async fn enable_tun(
            &self,
            profile_id: String,
            system_proxy_enabled: bool,
        ) -> Result<ServiceTunData, String> {
            if !is_admin() {
                return Err("MioProxy Service 没有管理员权限".to_string());
            }
            if system_proxy_enabled {
                return Err("TUN 与系统代理不能同时开启".to_string());
            }
            if profile_id.trim().is_empty() {
                return Err("启用 TUN 需要已下载的 Profile".to_string());
            }
            if !self.owns_core()? || !mihomo::is_running().await {
                return Err("Service 尚未拥有运行中的 Mihomo".to_string());
            }
            let previous_override = config::override_content_at(&self.data_dir)?;
            let snapshot = crate::tun::capture_snapshot().await?;
            {
                let mut tun = self.tun.lock().map_err(|_| "Service TUN 状态锁异常")?;
                tun.status = crate::tun::TunStatus::Starting;
                tun.message = None;
                tun.profile_id = Some(profile_id.clone());
                tun.previous_override = Some(previous_override.clone());
                tun.snapshot = Some(snapshot);
            }
            if let Err(error) = self.write_tun_persisted() {
                if let Ok(mut tun) = self.tun.lock() {
                    *tun = ServiceTunState::default();
                }
                return Err(format!("保存 Service TUN 恢复状态失败：{error}"));
            }
            if let Err(error) = config::set_tun_enabled_at(&self.data_dir, true) {
                return self
                    .rollback_tun(
                        &profile_id,
                        &previous_override,
                        format!("写入 TUN 配置失败：{error}"),
                    )
                    .await;
            }
            if let Err(error) = self.apply_profile(&profile_id).await {
                return self
                    .rollback_tun(
                        &profile_id,
                        &previous_override,
                        format!("加载 TUN 配置失败：{error}"),
                    )
                    .await;
            }
            let tun_enabled = mihomo::api_get("/configs")
                .await
                .ok()
                .and_then(|value| value.get("tun").cloned())
                .and_then(|value| value.get("enable").and_then(Value::as_bool));
            if tun_enabled == Some(false) {
                return self
                    .rollback_tun(
                        &profile_id,
                        &previous_override,
                        "Mihomo 未确认 TUN 已启用".to_string(),
                    )
                    .await;
            }
            {
                let mut tun = self.tun.lock().map_err(|_| "Service TUN 状态锁异常")?;
                tun.status = crate::tun::TunStatus::Running;
                tun.message = None;
            }
            if let Err(error) = self.write_tun_persisted() {
                return self
                    .rollback_tun(
                        &profile_id,
                        &previous_override,
                        format!("保存 Service TUN 运行状态失败：{error}"),
                    )
                    .await;
            }
            let tun = self.tun.lock().map_err(|_| "Service TUN 状态锁异常")?;
            Ok(ServiceTunData {
                status: "running".to_string(),
                message: None,
                admin: true,
                profile_id: tun.profile_id.clone(),
                snapshot: tun.snapshot.clone(),
            })
        }

        async fn rollback_tun(
            &self,
            profile_id: &str,
            previous_override: &str,
            reason: String,
        ) -> Result<ServiceTunData, String> {
            let recovery = config::restore_override_content_at(&self.data_dir, previous_override)
                .and_then(|_| Ok(()));
            let recovery = if recovery.is_ok() && mihomo::is_running().await {
                self.apply_profile(profile_id).await.map(|_| ())
            } else if recovery.is_ok() {
                config::restore_profile_config_at(&self.data_dir, profile_id)
            } else {
                recovery
            };
            let message = match recovery {
                Ok(()) => {
                    let _ = self.clear_tun_persisted();
                    format!("{reason}；已恢复原始配置")
                }
                Err(error) => format!("{reason}；TUN 回滚也失败：{error}"),
            };
            let mut tun = self.tun.lock().map_err(|_| "Service TUN 状态锁异常")?;
            tun.status = crate::tun::TunStatus::Error;
            tun.message = Some(message.clone());
            Err(message)
        }

        async fn disable_tun(&self) -> Result<ServiceTunData, String> {
            let persisted = self.read_tun_persisted()?;
            let previous = persisted
                .as_ref()
                .map(|state| state.previous_override.clone())
                .or_else(|| {
                    self.tun
                        .lock()
                        .ok()
                        .and_then(|tun| tun.previous_override.clone())
                });
            let profile_id = persisted
                .as_ref()
                .map(|state| state.profile_id.clone())
                .or_else(|| self.tun.lock().ok().and_then(|tun| tun.profile_id.clone()));
            let Some(previous) = previous else {
                let mut tun = self.tun.lock().map_err(|_| "Service TUN 状态锁异常")?;
                tun.status = crate::tun::TunStatus::Disabled;
                tun.message = None;
                return self.tun_data();
            };
            {
                let mut tun = self.tun.lock().map_err(|_| "Service TUN 状态锁异常")?;
                tun.status = crate::tun::TunStatus::Stopping;
                tun.message = None;
            }
            if let Err(error) = config::restore_override_content_at(&self.data_dir, &previous) {
                let message = format!("恢复 TUN 原始 Override 失败：{error}");
                if let Ok(mut tun) = self.tun.lock() {
                    tun.status = crate::tun::TunStatus::Error;
                    tun.message = Some(message.clone());
                }
                return Err(message);
            }
            if mihomo::is_running().await {
                let Some(profile_id) = profile_id else {
                    let message = "停止 TUN 缺少 Profile".to_string();
                    if let Ok(mut tun) = self.tun.lock() {
                        tun.status = crate::tun::TunStatus::Error;
                        tun.message = Some(message.clone());
                    }
                    return Err(message);
                };
                if let Err(error) = self.apply_profile(&profile_id).await {
                    let message = format!("Mihomo 停止 TUN 失败：{error}");
                    if let Ok(mut tun) = self.tun.lock() {
                        tun.status = crate::tun::TunStatus::Error;
                        tun.message = Some(message.clone());
                    }
                    return Err(message);
                }
            }
            self.clear_tun_persisted()?;
            {
                let mut tun = self.tun.lock().map_err(|_| "Service TUN 状态锁异常")?;
                *tun = ServiceTunState::default();
            }
            self.tun_data()
        }

        async fn tun_set(
            &self,
            enabled: bool,
            profile_id: Option<String>,
            system_proxy_enabled: bool,
        ) -> Result<ServiceTunData, String> {
            if enabled {
                self.enable_tun(profile_id.unwrap_or_default(), system_proxy_enabled)
                    .await
            } else {
                self.disable_tun().await
            }
        }

        async fn recover(&self) -> Result<Option<String>, String> {
            let Some(persisted) = self.read_tun_persisted()? else {
                return Ok(None);
            };
            let result =
                config::restore_override_content_at(&self.data_dir, &persisted.previous_override)
                    .and_then(|_| {
                        config::restore_profile_config_at(&self.data_dir, &persisted.profile_id)
                    });
            match result {
                Ok(()) => {
                    self.clear_tun_persisted()?;
                    let mut tun = self.tun.lock().map_err(|_| "Service TUN 状态锁异常")?;
                    tun.status = crate::tun::TunStatus::Error;
                    tun.message = Some("Service 上次异常退出，已恢复 TUN 原始配置".to_string());
                    tun.profile_id = Some(persisted.profile_id);
                    tun.snapshot = Some(persisted.snapshot);
                    Ok(tun.message.clone())
                }
                Err(error) => {
                    let mut tun = self.tun.lock().map_err(|_| "Service TUN 状态锁异常")?;
                    tun.status = crate::tun::TunStatus::Error;
                    tun.message = Some(format!("Service TUN 启动恢复失败：{error}"));
                    Ok(tun.message.clone())
                }
            }
        }

        async fn status(&self) -> Result<ServiceStatusData, String> {
            let core = self.core_status().await?;
            let running = core.running;
            let owns_core = self.owns_core()?;
            let tun = self.tun_data()?;
            Ok(ServiceStatusData {
                core,
                running,
                owns_core,
                ownership_conflict: running && !owns_core,
                admin: is_admin(),
                tun_status: tun.status,
                tun_message: tun.message,
                tun_profile_id: tun.profile_id,
                tun_snapshot: tun.snapshot,
            })
        }

        async fn handle(&self, command: ServiceCommand) -> Result<Value, String> {
            match command {
                ServiceCommand::Status => {
                    Ok(serde_json::to_value(self.status().await?).map_err(|e| e.to_string())?)
                }
                ServiceCommand::Start => Ok(serde_json::to_value::<crate::mihomo::CoreStatus>(
                    self.start().await?,
                )
                .map_err(|e| e.to_string())?),
                ServiceCommand::Stop => Ok(serde_json::to_value::<crate::mihomo::CoreStatus>(
                    self.stop().await?,
                )
                .map_err(|e| e.to_string())?),
                ServiceCommand::Reload => self.reload().await,
                ServiceCommand::ApplyProfile { profile_id } => {
                    Ok(serde_json::to_value(self.apply_profile(&profile_id).await?)
                        .map_err(|e| e.to_string())?)
                }
                ServiceCommand::TunSetEnabled {
                    enabled,
                    profile_id,
                    system_proxy_enabled,
                } => Ok(serde_json::to_value(
                    self.tun_set(enabled, profile_id, system_proxy_enabled)
                        .await?,
                )
                .map_err(|e| e.to_string())?),
            }
        }

        async fn shutdown(&self) -> Result<(), String> {
            let status = self.tun_data()?;
            if status.status == "running"
                || status.status == "starting"
                || status.status == "stopping"
            {
                let _ = self.disable_tun().await;
            }
            if let Some(mut child) = self
                .child
                .lock()
                .map_err(|_| "Service Mihomo 状态锁异常")?
                .take()
            {
                let _ = child.kill();
                let _ = child.wait();
            }
            Ok(())
        }

        async fn monitor(self: Arc<Self>, mut shutdown: watch::Receiver<bool>) {
            let mut previous_tick = unsafe { GetTickCount64() };
            loop {
                tokio::select! {
                    changed = shutdown.changed() => {
                        if changed.is_err() || *shutdown.borrow() { return; }
                    }
                    _ = tokio::time::sleep(Duration::from_secs(12)) => {}
                }
                if *shutdown.borrow() {
                    return;
                }
                let tun = match self.tun_data() {
                    Ok(tun) if tun.status == "running" => tun,
                    _ => continue,
                };
                if !self.owns_core().unwrap_or(false) || !mihomo::is_running().await {
                    continue;
                }
                let now = unsafe { GetTickCount64() };
                let wake_gap = now.saturating_sub(previous_tick) > 30_000;
                previous_tick = now;
                let Ok(snapshot) = crate::tun::capture_snapshot().await else {
                    continue;
                };
                let changed = wake_gap
                    || tun
                        .snapshot
                        .as_ref()
                        .map(|old| {
                            old.default_route != snapshot.default_route
                                || old.dns_servers != snapshot.dns_servers
                                || old.adapters != snapshot.adapters
                        })
                        .unwrap_or(true);
                if !changed {
                    continue;
                }
                let Some(profile_id) = tun.profile_id.clone() else {
                    continue;
                };
                if let Ok(mut current) = self.tun.lock() {
                    current.status = crate::tun::TunStatus::Starting;
                    current.message = Some("检测到网络变化，正在重新绑定 TUN 路由".to_string());
                    current.snapshot = Some(snapshot);
                }
                match self.apply_profile(&profile_id).await {
                    Ok(_) => {
                        if let Ok(mut current) = self.tun.lock() {
                            current.status = crate::tun::TunStatus::Running;
                            current.message = None;
                        }
                        let _ = self.write_tun_persisted();
                    }
                    Err(error) => {
                        if let Ok(mut current) = self.tun.lock() {
                            current.status = crate::tun::TunStatus::Error;
                            current.message = Some(format!("网络变化后重载 TUN 失败：{error}"));
                        }
                    }
                }
            }
        }
    }

    fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let temp = path.with_extension("tmp");
        fs::write(&temp, bytes).map_err(|e| e.to_string())?;
        if path.exists() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        fs::rename(temp, path).map_err(|e| e.to_string())
    }

    fn response_ok(data: Value) -> ServiceResponse {
        ServiceResponse {
            protocol_version: SERVICE_PROTOCOL_VERSION,
            service_version: SERVICE_VERSION.to_string(),
            ok: true,
            error: None,
            data: Some(data),
        }
    }

    fn response_error(error: String) -> ServiceResponse {
        ServiceResponse {
            protocol_version: SERVICE_PROTOCOL_VERSION,
            service_version: SERVICE_VERSION.to_string(),
            ok: false,
            error: Some(error),
            data: None,
        }
    }

    fn server_attributes() -> Result<SECURITY_ATTRIBUTES, String> {
        let sddl = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;AU)\0";
        let wide = sddl.encode_utf16().collect::<Vec<u16>>();
        let mut descriptor = std::ptr::null_mut();
        let converted = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        };
        if converted == 0 {
            return Err("创建 Service IPC 安全描述符失败".to_string());
        }
        Ok(SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        })
    }

    fn create_server(first: bool) -> Result<NamedPipeServer, String> {
        let mut options = ServerOptions::new();
        options
            .first_pipe_instance(first)
            .max_instances(1)
            .in_buffer_size(16 * 1024)
            .out_buffer_size(16 * 1024);
        let mut attributes = server_attributes()?;
        let server = unsafe {
            options.create_with_security_attributes_raw(
                PIPE_NAME,
                &mut attributes as *mut SECURITY_ATTRIBUTES as *mut std::ffi::c_void,
            )
        }
        .map_err(|e| format!("创建 Service IPC 管道失败：{e}"));
        if !attributes.lpSecurityDescriptor.is_null() {
            unsafe {
                let _ = windows_sys::Win32::Foundation::LocalFree(attributes.lpSecurityDescriptor);
            }
        }
        server
    }

    async fn handle_client(
        server: NamedPipeServer,
        runtime: &ServiceRuntime,
        expected_token: &str,
    ) -> Result<(), String> {
        let mut reader = BufReader::new(server);
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("读取 Service 请求失败：{e}"))?;
        let request = match serde_json::from_str::<ServiceRequest>(&line) {
            Ok(request) => request,
            Err(error) => {
                let mut server = reader.into_inner();
                let line =
                    serde_json::to_string(&response_error(format!("Service 请求无效：{error}")))
                        .map_err(|error| error.to_string())?
                        + "\n";
                server
                    .write_all(line.as_bytes())
                    .await
                    .map_err(|e| e.to_string())?;
                return Ok(());
            }
        };
        let response = if request.protocol_version != SERVICE_PROTOCOL_VERSION {
            response_error(format!(
                "Service 协议版本不匹配：{SERVICE_PROTOCOL_VERSION} != {}",
                request.protocol_version
            ))
        } else if request.client_version != SERVICE_VERSION {
            response_error(format!(
                "GUI 与 Service 版本不匹配：{SERVICE_VERSION} != {}",
                request.client_version
            ))
        } else if request.token != expected_token {
            response_error("Service 令牌无效".to_string())
        } else {
            match runtime.handle(request.command).await {
                Ok(data) => response_ok(data),
                Err(error) => response_error(error),
            }
        };
        let mut server = reader.into_inner();
        let line = serde_json::to_string(&response).map_err(|e| e.to_string())? + "\n";
        server
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("发送 Service 响应失败：{e}"))?;
        server.flush().await.map_err(|e| e.to_string())
    }

    async fn create_server_until_ready(
        first: bool,
        shutdown: &mut watch::Receiver<bool>,
    ) -> Result<Option<NamedPipeServer>, String> {
        loop {
            match create_server(first) {
                Ok(server) => return Ok(Some(server)),
                Err(error) if !first && error.contains("os error 231") => {
                    tokio::select! {
                        changed = shutdown.changed() => {
                            if changed.is_err() || *shutdown.borrow() {
                                return Ok(None);
                            }
                        }
                        _ = tokio::time::sleep(Duration::from_millis(25)) => {}
                    }
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub async fn run_service_daemon(
        data_dir: PathBuf,
        mihomo_path: PathBuf,
        mut shutdown: watch::Receiver<bool>,
    ) -> Result<(), String> {
        let expected_token = ensure_token(&data_dir)?;
        let runtime = Arc::new(ServiceRuntime::new(data_dir, mihomo_path)?);
        let _ = runtime.recover().await?;
        let monitor = tokio::spawn(runtime.clone().monitor(shutdown.clone()));
        let mut first = true;
        loop {
            let Some(server) = create_server_until_ready(first, &mut shutdown).await? else {
                let _ = runtime.shutdown().await;
                break;
            };
            first = false;
            tokio::select! {
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        let _ = runtime.shutdown().await;
                        break;
                    }
                }
                connected = server.connect() => {
                    if connected.is_ok() {
                        let _ = handle_client(server, &runtime, &expected_token).await;
                    }
                }
            }
        }
        monitor.abort();
        Ok(())
    }

    pub async fn run_service_console(
        data_dir: PathBuf,
        mihomo_path: PathBuf,
    ) -> Result<(), String> {
        let (sender, receiver) = watch::channel(false);
        tokio::spawn(async move {
            let _ = tokio::signal::ctrl_c().await;
            let _ = sender.send(true);
        });
        run_service_daemon(data_dir, mihomo_path, receiver).await
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::time::{SystemTime, UNIX_EPOCH};

        #[tokio::test]
        async fn named_pipe_status_round_trip() {
            let data_dir = std::env::temp_dir().join(format!(
                "mioproxy-service-test-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let (sender, receiver) = watch::channel(false);
            let daemon = tokio::spawn(run_service_daemon(
                data_dir.clone(),
                PathBuf::from("missing-mihomo.exe"),
                receiver,
            ));
            let token_path = token_path(&data_dir);
            let mut client = None;
            for _ in 0..50 {
                if let Ok(token) = fs::read_to_string(&token_path) {
                    if let Ok(next) = ClientOptions::new().open(PIPE_NAME) {
                        client = Some((next, token));
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let (mut client, token) = client.expect("Service named pipe did not become ready");
            let request = ServiceRequest {
                protocol_version: SERVICE_PROTOCOL_VERSION,
                client_version: SERVICE_VERSION.to_string(),
                token: token.trim().to_string(),
                command: ServiceCommand::Status,
            };
            let line = serde_json::to_string(&request).unwrap() + "\n";
            client.write_all(line.as_bytes()).await.unwrap();
            client.flush().await.unwrap();
            let mut reader = BufReader::new(client);
            let mut response_line = String::new();
            reader.read_line(&mut response_line).await.unwrap();
            let response: ServiceResponse = serde_json::from_str(&response_line).unwrap();
            assert!(response.ok);
            assert_eq!(response.protocol_version, SERVICE_PROTOCOL_VERSION);
            let status: ServiceStatusData = serde_json::from_value(response.data.unwrap()).unwrap();
            assert!(!status.running);
            assert!(!status.owns_core);
            let _ = sender.send(true);
            daemon.await.unwrap().unwrap();
            let _ = fs::remove_dir_all(data_dir);
        }
    }
}

#[cfg(windows)]
pub use windows_impl::{run_service_console, run_service_daemon};

#[cfg(windows)]
pub(crate) use windows_impl::{
    request_apply_profile, request_core, request_core_status, request_reload, request_tun,
    service_tun_status,
};

#[cfg(not(windows))]
pub(crate) async fn try_request(
    _app: &AppHandle,
    _command: ServiceCommand,
) -> Result<Option<ServiceResponse>, String> {
    Ok(None)
}

#[cfg(not(windows))]
pub(crate) async fn service_tun_status(
    _app: &AppHandle,
) -> Result<Option<crate::tun::TunStatusSnapshot>, String> {
    Ok(None)
}

#[cfg(not(windows))]
pub(crate) async fn request_core(
    _app: &AppHandle,
    _command: ServiceCommand,
) -> Result<Option<crate::mihomo::CoreStatus>, String> {
    Ok(None)
}

#[cfg(not(windows))]
pub(crate) async fn request_core_status(
    _app: &AppHandle,
) -> Result<Option<crate::mihomo::CoreStatus>, String> {
    Ok(None)
}

#[cfg(not(windows))]
pub(crate) async fn request_reload(_app: &AppHandle) -> Result<Option<Value>, String> {
    Ok(None)
}

#[cfg(not(windows))]
pub(crate) async fn request_apply_profile(
    _app: &AppHandle,
    _profile_id: &str,
) -> Result<Option<crate::config::ConfigApplyResult>, String> {
    Ok(None)
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn service_status_command(_app: AppHandle) -> Result<ServiceConnectionStatus, String> {
    Ok(ServiceConnectionStatus {
        reachable: false,
        protocol_version: SERVICE_PROTOCOL_VERSION,
        service_version: None,
        owns_core: false,
        core_running: false,
        ownership_conflict: false,
        tun_status: None,
        tun_message: None,
    })
}

#[cfg(windows)]
#[tauri::command]
pub async fn service_status_command(app: AppHandle) -> Result<ServiceConnectionStatus, String> {
    windows_impl::service_status(app).await
}
