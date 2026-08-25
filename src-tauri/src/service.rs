use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::reconciliation::ServiceConnectivity;

pub const SERVICE_NAME: &str = "MioProxyService";
pub const PIPE_NAME: &str = r"\\.\pipe\MioProxyService";
pub const SERVICE_PROTOCOL_VERSION: u32 = 1;
pub const SERVICE_VERSION: &str = env!("CARGO_PKG_VERSION");
const TOKEN_FILE: &str = "service-token";
const USER_SID_FILE: &str = "service-user-sid";
const CORE_STATE_FILE: &str = "service-core-state.json";
const SERVICE_CORE_OWNER_FILE: &str = "service-core-owner.json";
const CORE_STATE_FORMAT_VERSION: u8 = 2;
const CORE_RECOVERY_STATE_FILE: &str = "service-core-recovery.json";
const CORE_RECOVERY_STATE_FORMAT_VERSION: u8 = 1;
const CORE_RECOVERY_FAILURE_WINDOW_SECS: u64 = 10 * 60;
const CORE_RECOVERY_HEALTHY_RESET_SECS: u64 = 60;
const CORE_RECOVERY_RETRY_DELAYS_SECS: [u64; 3] = [15, 30, 60];
const CORE_RECOVERY_MAX_FAILURES: u32 = 4;
const CORE_START_MAX_CANDIDATES: u32 = 4;
const CORE_RECOVERY_ERROR_MAX_CHARS: usize = 512;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "camelCase")]
pub enum ServiceCommand {
    Status,
    /// Development and validation only. This is authenticated Service IPC, not a GUI command.
    PortDiagnostics {
        port: u16,
    },
    Start,
    Stop,
    Reload,
    CoreCheck,
    CoreInstall,
    ApplyProfile {
        #[serde(rename = "profileId")]
        profile_id: String,
    },
    TunSetEnabled {
        enabled: bool,
        #[serde(rename = "profileId")]
        profile_id: Option<String>,
        #[serde(rename = "systemProxyEnabled")]
        system_proxy_enabled: bool,
    },
    #[cfg(feature = "validation-fault-injection")]
    ValidationCrashManagedCore,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceRequest {
    #[serde(default)]
    pub request_id: u64,
    pub protocol_version: u32,
    pub client_version: String,
    pub token: String,
    pub command: ServiceCommand,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceResponse {
    #[serde(default)]
    pub request_id: u64,
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
    pub core_update: crate::core_update::CoreUpdateStatus,
    pub running: bool,
    pub owns_core: bool,
    pub ownership_conflict: bool,
    pub admin: bool,
    pub tun_status: String,
    pub tun_message: Option<String>,
    pub tun_profile_id: Option<String>,
    pub tun_snapshot: Option<crate::tun::NetworkSnapshot>,
    #[serde(default)]
    pub desired_core_running: bool,
    #[serde(default)]
    pub core_recovery_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceConnectionStatus {
    pub state: ServiceProjectionState,
    pub reachable: bool,
    pub protocol_version: u32,
    pub service_version: Option<String>,
    pub version_mismatch: bool,
    pub error: Option<String>,
    pub admin: bool,
    pub owns_core: bool,
    pub core_running: bool,
    pub ownership_conflict: bool,
    pub tun_status: Option<String>,
    pub tun_message: Option<String>,
    pub desired_core_running: bool,
    pub core_recovery_message: Option<String>,
    pub connectivity: ServiceConnectivity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceProjectionState {
    Running,
    Stopped,
    Starting,
    Reconnecting,
    Error,
}

impl ServiceConnectionStatus {
    fn disconnected_with(
        state: ServiceProjectionState,
        error: Option<String>,
        version_mismatch: bool,
        connectivity: ServiceConnectivity,
    ) -> Self {
        let core_recovery_message = if version_mismatch {
            error.clone()
        } else {
            None
        };
        Self {
            state,
            reachable: false,
            protocol_version: SERVICE_PROTOCOL_VERSION,
            service_version: None,
            version_mismatch,
            error,
            admin: false,
            owns_core: false,
            core_running: false,
            ownership_conflict: false,
            tun_status: None,
            tun_message: None,
            desired_core_running: false,
            core_recovery_message,
            connectivity,
        }
    }

    fn disconnected(
        state: ServiceProjectionState,
        error: Option<String>,
        version_mismatch: bool,
    ) -> Self {
        let connectivity = match state {
            ServiceProjectionState::Starting => ServiceConnectivity::ScmStarting,
            ServiceProjectionState::Reconnecting => ServiceConnectivity::Transient,
            ServiceProjectionState::Stopped => ServiceConnectivity::ServiceStopped,
            ServiceProjectionState::Error => {
                if version_mismatch {
                    ServiceConnectivity::ProtocolFailure
                } else {
                    ServiceConnectivity::CommandFailure
                }
            }
            ServiceProjectionState::Running => ServiceConnectivity::Ready,
        };
        Self::disconnected_with(state, error, version_mismatch, connectivity)
    }
}

pub(crate) fn token_path(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join(TOKEN_FILE)
}

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use std::{
        fs,
        io::{self, Write},
        os::windows::{ffi::OsStrExt, fs::MetadataExt},
        path::{Path, PathBuf},
        process::{Child, Command, Stdio},
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc, Mutex,
        },
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    #[cfg(not(test))]
    use std::os::windows::io::AsRawHandle;

    use serde::{Deserialize, Deserializer};
    use serde_json::json;
    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
        net::windows::named_pipe::{
            ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
        },
        sync::{watch, Mutex as AsyncMutex},
    };

    static REQUEST_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());
    static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
    const IPC_TIMEOUT: Duration = Duration::from_secs(5);

    #[derive(Debug, Clone)]
    struct ServiceIpcError {
        connectivity: ServiceConnectivity,
        request_written: bool,
        message: String,
    }

    impl ServiceIpcError {
        fn new(
            connectivity: ServiceConnectivity,
            request_written: bool,
            message: impl Into<String>,
        ) -> Self {
            Self {
                connectivity,
                request_written,
                message: message.into(),
            }
        }
    }

    impl std::fmt::Display for ServiceIpcError {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str(&self.message)
        }
    }

    impl std::error::Error for ServiceIpcError {}
    use windows_service::{
        service::{ServiceAccess, ServiceExitCode, ServiceState},
        service_manager::{ServiceManager, ServiceManagerAccess},
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        Security::{
            Authorization::{
                ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
                SDDL_REVISION_1,
            },
            GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
        },
        Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH},
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{
                GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_SET_QUOTA,
                PROCESS_TERMINATE,
            },
        },
    };

    #[cfg(not(test))]
    use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;

    use crate::{config, mihomo, outbound};

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
        if let Some(token) = config::read_text_file_at(&path, "读取 Service 令牌")? {
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
        write_atomic(&path, token.as_bytes())?;
        Ok(token)
    }

    fn sid_to_string(
        sid: windows_sys::Win32::Security::PSID,
        label: &str,
    ) -> Result<String, String> {
        if sid.is_null() {
            return Err(format!("{label}为空"));
        }
        let mut sid_text = std::ptr::null_mut();
        if unsafe { ConvertSidToStringSidW(sid, &mut sid_text) } == 0 {
            return Err(format!("格式化{label}失败"));
        }
        let mut length = 0;
        unsafe {
            while *sid_text.add(length) != 0 {
                length += 1;
            }
        }
        let sid = unsafe { String::from_utf16_lossy(std::slice::from_raw_parts(sid_text, length)) };
        unsafe {
            let _ = windows_sys::Win32::Foundation::LocalFree(sid_text as _);
        }
        Ok(sid)
    }

    fn current_process_user_sid() -> Result<String, String> {
        let mut token = std::ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(format!(
                "读取 Service 安装用户令牌失败：{}",
                io::Error::last_os_error()
            ));
        }

        let mut required_length = 0;
        let queried = unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                std::ptr::null_mut(),
                0,
                &mut required_length,
            )
        };
        if queried != 0 || required_length == 0 {
            unsafe { CloseHandle(token) };
            return Err("读取 Service 安装用户 SID 大小失败".to_string());
        }

        let mut buffer = vec![0u8; required_length as usize];
        let result = if unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr() as *mut std::ffi::c_void,
                required_length,
                &mut required_length,
            )
        } == 0
        {
            Err(format!(
                "读取 Service 安装用户 SID 失败：{}",
                io::Error::last_os_error()
            ))
        } else {
            let token_user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };
            sid_to_string(token_user.User.Sid, "Service 安装用户 SID")
        };
        unsafe { CloseHandle(token) };
        result
    }

    fn validate_sid(raw: &str) -> Result<String, String> {
        let sid = raw.trim();
        if !sid.starts_with("S-")
            || sid
                .chars()
                .any(|character| !character.is_ascii_alphanumeric() && character != '-')
        {
            return Err("Service 安装用户 SID 无效".to_string());
        }
        Ok(sid.to_string())
    }

    pub fn ensure_install_user_sid(
        data_dir: &Path,
        explicit_sid: Option<&str>,
    ) -> Result<(), String> {
        let sid = match explicit_sid {
            Some(sid) => validate_sid(sid)?,
            None => current_process_user_sid()?,
        };
        write_atomic(&data_dir.join(USER_SID_FILE), sid.as_bytes())
            .map_err(|e| format!("保存 Service 安装用户身份失败：{e}"))
    }

    pub fn ensure_install_token(data_dir: &Path) -> Result<(), String> {
        ensure_token(data_dir).map(|_| ())
    }

    fn client_token(app: &AppHandle) -> Result<String, String> {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let path = token_path(&data_dir);
        config::read_text_file_at(&path, "读取 Service 令牌")?
            .map(|token| token.trim().to_string())
            .filter(|token| !token.is_empty())
            .ok_or_else(|| "MioProxy Service 令牌不存在，请先启动或安装 Service".to_string())
    }

    fn is_pipe_missing(error: &io::Error) -> bool {
        matches!(error.raw_os_error(), Some(2 | 3))
    }

    fn is_pipe_busy(error: &io::Error) -> bool {
        matches!(error.raw_os_error(), Some(121 | 231))
    }

    fn pipe_name() -> String {
        #[cfg(test)]
        if let Some(name) = std::env::var_os("MIOPROXY_TEST_PIPE_NAME") {
            return name.to_string_lossy().into_owned();
        }
        PIPE_NAME.to_string()
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

    fn installed_service_state() -> Result<Option<ServiceState>, String> {
        let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
            .map_err(|error| format!("查询 MioProxy Service 状态失败：{error}"))?;
        let service = match manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS) {
            Ok(service) => service,
            Err(windows_service::Error::Winapi(error)) if error.raw_os_error() == Some(1060) => {
                return Ok(None);
            }
            Err(error) => return Err(format!("查询 MioProxy Service 状态失败：{error}")),
        };
        service
            .query_status()
            .map(|status| Some(status.current_state))
            .map_err(|error| format!("查询 MioProxy Service 状态失败：{error}"))
    }

    fn project_scm_state(state: Option<ServiceState>) -> ServiceProjectionState {
        match state {
            None | Some(ServiceState::Stopped | ServiceState::StopPending) => {
                ServiceProjectionState::Stopped
            }
            Some(ServiceState::StartPending | ServiceState::ContinuePending) => {
                ServiceProjectionState::Starting
            }
            Some(ServiceState::Running) => ServiceProjectionState::Running,
            Some(ServiceState::PausePending | ServiceState::Paused) => {
                ServiceProjectionState::Error
            }
        }
    }

    #[cfg(not(test))]
    fn service_process_id() -> Result<Option<u32>, String> {
        let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
            .map_err(|error| format!("查询 MioProxy Service 失败：{error}"))?;
        let service = manager
            .open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS)
            .map_err(|error| format!("查询 MioProxy Service 失败：{error}"))?;
        service
            .query_status()
            .map(|status| status.process_id)
            .map_err(|error| format!("查询 MioProxy Service 进程失败：{error}"))
    }

    #[cfg(not(test))]
    fn verify_service_pipe(client: &NamedPipeClient) -> Result<(), String> {
        let mut server_pid = 0;
        let ok = unsafe { GetNamedPipeServerProcessId(client.as_raw_handle(), &mut server_pid) };
        if ok == 0 {
            return Err("无法确认 MioProxy Service IPC 服务端身份".to_string());
        }
        let expected_pid =
            service_process_id()?.ok_or_else(|| "MioProxy Service 当前没有运行进程".to_string())?;
        if server_pid != expected_pid {
            return Err("MioProxy Service IPC 服务端身份不匹配".to_string());
        }
        Ok(())
    }

    #[cfg(test)]
    fn verify_service_pipe(_client: &NamedPipeClient) -> Result<(), String> {
        Ok(())
    }

    async fn open_client() -> Result<NamedPipeClient, io::Error> {
        for _ in 0..20 {
            match ClientOptions::new().open(pipe_name()) {
                Ok(client) => return Ok(client),
                Err(error) if is_pipe_busy(&error) => {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "MioProxy Service IPC 忙，重试超时",
        ))
    }

    fn scm_connectivity(state: Option<ServiceState>) -> ServiceConnectivity {
        match state {
            None => ServiceConnectivity::NotInstalled,
            Some(ServiceState::Stopped | ServiceState::StopPending) => {
                ServiceConnectivity::ServiceStopped
            }
            Some(ServiceState::StartPending | ServiceState::ContinuePending) => {
                ServiceConnectivity::ScmStarting
            }
            Some(ServiceState::Running) => ServiceConnectivity::Ready,
            Some(ServiceState::PausePending | ServiceState::Paused) => {
                ServiceConnectivity::CommandFailure
            }
        }
    }

    fn classify_pipe_open_error(error: &io::Error) -> ServiceIpcError {
        let connectivity = if is_pipe_busy(error) || error.kind() == io::ErrorKind::TimedOut {
            ServiceConnectivity::Transient
        } else {
            match installed_service_state() {
                Ok(Some(ServiceState::Running)) => ServiceConnectivity::PipeNotReady,
                Ok(state) => scm_connectivity(state),
                Err(_) => ServiceConnectivity::Transient,
            }
        };
        let message = match connectivity {
            ServiceConnectivity::NotInstalled => {
                "MioProxy Service 未安装，允许使用未特权的开发回退路径"
            }
            ServiceConnectivity::ServiceStopped => "MioProxy Service 已安装但当前处于 Stopped",
            ServiceConnectivity::ScmStarting => "MioProxy Service 正在启动，等待 Named Pipe 就绪",
            ServiceConnectivity::Transient => "MioProxy Service IPC 暂时不可用，等待重新连接",
            ServiceConnectivity::PipeNotReady => "MioProxy Service 已运行但 Named Pipe 尚未就绪",
            ServiceConnectivity::Ready => "MioProxy Service IPC 已就绪但连接失败",
            ServiceConnectivity::Ambiguous => "MioProxy Service IPC 状态不明确，等待权威状态",
            ServiceConnectivity::ProtocolFailure => "MioProxy Service IPC 协议不可用",
            ServiceConnectivity::AuthenticationFailure => "MioProxy Service IPC 身份验证不可用",
            ServiceConnectivity::CommandFailure => "MioProxy Service 无法接受 IPC 连接",
        };
        let suffix = if error.to_string().is_empty() {
            String::new()
        } else {
            format!("：{error}")
        };
        ServiceIpcError::new(connectivity, false, format!("{message}{suffix}"))
    }

    fn classified_error(
        connectivity: ServiceConnectivity,
        request_written: bool,
        message: impl Into<String>,
    ) -> ServiceIpcError {
        ServiceIpcError::new(connectivity, request_written, message)
    }

    fn response_error_connectivity(error: &str) -> ServiceConnectivity {
        if error.contains("令牌无效") || error.contains("令牌") && error.contains("无效") {
            ServiceConnectivity::AuthenticationFailure
        } else if error.contains("版本不匹配") || error.contains("协议") {
            ServiceConnectivity::ProtocolFailure
        } else {
            ServiceConnectivity::CommandFailure
        }
    }

    async fn try_request_classified(
        app: &AppHandle,
        command: ServiceCommand,
        request_id: u64,
    ) -> Result<Option<ServiceResponse>, ServiceIpcError> {
        let _request = tokio::time::timeout(IPC_TIMEOUT, REQUEST_LOCK.lock())
            .await
            .map_err(|_| {
                classified_error(
                    ServiceConnectivity::Transient,
                    false,
                    "等待 MioProxy Service IPC 请求锁超时",
                )
            })?;
        let mut client = match open_client().await {
            Ok(client) => client,
            Err(error) if is_pipe_missing(&error) => {
                let classified = classify_pipe_open_error(&error);
                if classified.connectivity == ServiceConnectivity::NotInstalled {
                    return Err(classified);
                }
                return Err(classified);
            }
            Err(error) => return Err(classify_pipe_open_error(&error)),
        };

        verify_service_pipe(&client).map_err(|error| {
            classified_error(
                ServiceConnectivity::AuthenticationFailure,
                false,
                format!("MioProxy Service IPC 身份确认失败：{error}"),
            )
        })?;
        let token = client_token(app).map_err(|error| {
            classified_error(ServiceConnectivity::AuthenticationFailure, false, error)
        })?;
        let request = ServiceRequest {
            request_id,
            protocol_version: SERVICE_PROTOCOL_VERSION,
            client_version: SERVICE_VERSION.to_string(),
            token,
            command,
        };
        let line = serde_json::to_string(&request).map_err(|error| {
            classified_error(
                ServiceConnectivity::CommandFailure,
                false,
                error.to_string(),
            )
        })? + "\n";

        tokio::time::timeout(IPC_TIMEOUT, client.write_all(line.as_bytes()))
            .await
            .map_err(|_| {
                classified_error(
                    ServiceConnectivity::Ambiguous,
                    true,
                    "写入 Service 请求超时；请求结果不明确，等待权威状态",
                )
            })?
            .map_err(|error| {
                classified_error(
                    ServiceConnectivity::Ambiguous,
                    true,
                    format!("写入 Service 请求失败；请求结果不明确：{error}"),
                )
            })?;
        tokio::time::timeout(IPC_TIMEOUT, client.flush())
            .await
            .map_err(|_| {
                classified_error(
                    ServiceConnectivity::Ambiguous,
                    true,
                    "发送 Service 请求超时；请求结果不明确，等待权威状态",
                )
            })?
            .map_err(|error| {
                classified_error(
                    ServiceConnectivity::Ambiguous,
                    true,
                    format!("发送 Service 请求失败；请求结果不明确：{error}"),
                )
            })?;

        let mut reader = BufReader::new(client);
        let mut response_line = String::new();
        let bytes_read = tokio::time::timeout(IPC_TIMEOUT, reader.read_line(&mut response_line))
            .await
            .map_err(|_| {
                classified_error(
                    ServiceConnectivity::Ambiguous,
                    true,
                    "读取 Service 响应超时；请求结果不明确，等待权威状态",
                )
            })?
            .map_err(|error| {
                classified_error(
                    ServiceConnectivity::Ambiguous,
                    true,
                    format!("读取 Service 响应失败；请求结果不明确：{error}"),
                )
            })?;
        if bytes_read == 0 {
            return Err(classified_error(
                ServiceConnectivity::Ambiguous,
                true,
                "Service 已关闭 IPC 响应；请求结果不明确，等待权威状态",
            ));
        }
        let response =
            serde_json::from_str::<ServiceResponse>(&response_line).map_err(|error| {
                classified_error(
                    ServiceConnectivity::Ambiguous,
                    true,
                    format!("Service 响应无效；请求结果不明确：{error}"),
                )
            })?;
        if response.request_id != request_id {
            return Err(classified_error(
                ServiceConnectivity::ProtocolFailure,
                true,
                format!(
                    "MioProxy Service 响应请求 ID 不匹配：请求={}，响应={}",
                    request_id, response.request_id
                ),
            ));
        }
        if response.protocol_version != SERVICE_PROTOCOL_VERSION {
            return Err(classified_error(
                ServiceConnectivity::ProtocolFailure,
                true,
                format!(
                    "MioProxy Service 协议版本不匹配：GUI={}，Service={}",
                    SERVICE_PROTOCOL_VERSION, response.protocol_version
                ),
            ));
        }
        if response.service_version != SERVICE_VERSION {
            return Err(classified_error(
                ServiceConnectivity::ProtocolFailure,
                true,
                format!(
                    "MioProxy Service 版本不匹配：GUI={}，Service={}",
                    SERVICE_VERSION, response.service_version
                ),
            ));
        }
        if !response.ok {
            let message = response
                .error
                .unwrap_or_else(|| "MioProxy Service 请求失败".to_string());
            return Err(classified_error(
                response_error_connectivity(&message),
                true,
                message,
            ));
        }
        Ok(Some(response))
    }

    pub(crate) async fn try_request(
        app: &AppHandle,
        command: ServiceCommand,
    ) -> Result<Option<ServiceResponse>, String> {
        let request_id = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
        match try_request_classified(app, command, request_id).await {
            Ok(result) => Ok(result),
            Err(error) if error.connectivity == ServiceConnectivity::NotInstalled => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn is_optional_ipc_transport_error(error: &str) -> bool {
        error.starts_with("连接 MioProxy Service 失败：")
            || error.starts_with("写入 Service 请求失败：")
            || error.starts_with("发送 Service 请求失败：")
            || error.starts_with("读取 Service 响应失败：")
            || error == "等待 MioProxy Service IPC 请求锁超时"
            || error == "写入 Service 请求超时"
            || error == "发送 Service 请求超时"
            || error == "读取 Service 响应超时"
            || error.starts_with("MioProxy Service IPC 暂时不可用")
            || error.starts_with("MioProxy Service 正在启动")
            || error.starts_with("MioProxy Service 已运行但 Named Pipe 尚未就绪")
    }

    async fn optional_request(
        app: &AppHandle,
        command: ServiceCommand,
    ) -> Result<Option<ServiceResponse>, String> {
        match try_request(app, command).await {
            Err(error) if is_optional_ipc_transport_error(&error) => Ok(None),
            result => result,
        }
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
        let scm_state = match installed_service_state() {
            Ok(state) => state,
            Err(error) => {
                return Ok(ServiceConnectionStatus::disconnected(
                    ServiceProjectionState::Error,
                    Some(error),
                    false,
                ));
            }
        };
        let scm_projection = project_scm_state(scm_state);
        if scm_projection != ServiceProjectionState::Running {
            let error = (scm_projection == ServiceProjectionState::Error)
                .then(|| format!("MioProxy Service 处于不受支持的 SCM 状态：{scm_state:?}"));
            return Ok(ServiceConnectionStatus::disconnected_with(
                scm_projection,
                error,
                false,
                scm_connectivity(scm_state),
            ));
        }

        // Health checks are deliberately short and non-disruptive. A service
        // which is still starting must be represented as unavailable so the GUI
        // can reconnect in the background, not stalled behind a full IPC timeout.
        let response = match tokio::time::timeout(
            Duration::from_millis(250),
            try_request_classified(
                &app,
                ServiceCommand::Status,
                NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed),
            ),
        )
        .await
        {
            Err(_) => {
                return Ok(ServiceConnectionStatus::disconnected_with(
                    ServiceProjectionState::Reconnecting,
                    Some("MioProxy Service health check timed out".to_string()),
                    false,
                    ServiceConnectivity::Transient,
                ));
            }
            Ok(response) => response,
        };
        let response = match response {
            Ok(response) => response,
            Err(error) if error.connectivity == ServiceConnectivity::ProtocolFailure => {
                return Ok(ServiceConnectionStatus::disconnected_with(
                    ServiceProjectionState::Error,
                    Some(error.to_string()),
                    true,
                    ServiceConnectivity::ProtocolFailure,
                ));
            }
            Err(error) => {
                let projection = match error.connectivity {
                    ServiceConnectivity::ScmStarting
                    | ServiceConnectivity::PipeNotReady
                    | ServiceConnectivity::Transient
                    | ServiceConnectivity::Ambiguous => ServiceProjectionState::Reconnecting,
                    ServiceConnectivity::AuthenticationFailure
                    | ServiceConnectivity::CommandFailure => ServiceProjectionState::Error,
                    ServiceConnectivity::NotInstalled | ServiceConnectivity::ServiceStopped => {
                        ServiceProjectionState::Stopped
                    }
                    ServiceConnectivity::Ready => ServiceProjectionState::Reconnecting,
                    ServiceConnectivity::ProtocolFailure => ServiceProjectionState::Error,
                };
                return Ok(ServiceConnectionStatus::disconnected_with(
                    projection,
                    Some(error.to_string()),
                    false,
                    error.connectivity,
                ));
            }
        };
        let Some(response) = response else {
            return Ok(ServiceConnectionStatus::disconnected_with(
                ServiceProjectionState::Reconnecting,
                None,
                false,
                ServiceConnectivity::Transient,
            ));
        };
        let status: ServiceStatusData = match data(response) {
            Ok(status) => status,
            Err(error) => {
                return Ok(ServiceConnectionStatus::disconnected(
                    ServiceProjectionState::Error,
                    Some(error),
                    false,
                ));
            }
        };
        Ok(ServiceConnectionStatus {
            state: ServiceProjectionState::Running,
            reachable: true,
            protocol_version: SERVICE_PROTOCOL_VERSION,
            service_version: Some(SERVICE_VERSION.to_string()),
            version_mismatch: false,
            error: None,
            admin: status.admin,
            owns_core: status.owns_core,
            core_running: status.core.running,
            ownership_conflict: status.ownership_conflict,
            tun_status: Some(status.tun_status),
            tun_message: status.tun_message,
            desired_core_running: status.desired_core_running,
            core_recovery_message: status.core_recovery_message,
            connectivity: ServiceConnectivity::Ready,
        })
    }

    pub(crate) async fn service_tun_status(
        app: &AppHandle,
    ) -> Result<Option<crate::tun::TunStatusSnapshot>, String> {
        match try_request_classified(
            app,
            ServiceCommand::Status,
            NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed),
        )
        .await
        {
            Ok(Some(response)) => {
                let status: ServiceStatusData = data(response)?;
                Ok(Some(snapshot_from_service_status(status, false)))
            }
            Ok(None) => Ok(None),
            Err(error)
                if matches!(
                    error.connectivity,
                    ServiceConnectivity::ServiceStopped
                        | ServiceConnectivity::ScmStarting
                        | ServiceConnectivity::PipeNotReady
                        | ServiceConnectivity::Transient
                        | ServiceConnectivity::Ambiguous
                ) =>
            {
                Ok(Some(unavailable_tun_snapshot(false, error.to_string())))
            }
            Err(error) => Err(error.to_string()),
        }
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

    #[cfg(feature = "validation-fault-injection")]
    pub(crate) async fn validation_crash_managed_core(app: AppHandle) -> Result<Value, String> {
        let Some(response) = try_request(&app, ServiceCommand::ValidationCrashManagedCore).await?
        else {
            return Err("MioProxy Service IPC 不可用，无法注入受管 Mihomo 故障".to_string());
        };
        Ok(response.data.unwrap_or(Value::Null))
    }

    pub(crate) async fn request_core_update(
        app: &AppHandle,
        command: ServiceCommand,
    ) -> Result<Option<crate::core_update::CoreUpdateStatus>, String> {
        let Some(response) = try_request(app, command).await? else {
            return Ok(None);
        };
        data(response).map(Some)
    }

    pub(crate) async fn request_service_status(
        app: &AppHandle,
    ) -> Result<Option<ServiceStatusData>, String> {
        let Some(response) = optional_request(app, ServiceCommand::Status).await? else {
            return Ok(None);
        };
        data(response).map(Some)
    }

    pub(crate) async fn request_reload(app: &AppHandle) -> Result<Option<Value>, String> {
        let Some(response) = optional_request(app, ServiceCommand::Reload).await? else {
            return Ok(None);
        };
        Ok(Some(response.data.unwrap_or(Value::Null)))
    }

    pub(crate) async fn request_apply_profile(
        app: &AppHandle,
        profile_id: &str,
    ) -> Result<Option<crate::config::ConfigApplyResult>, String> {
        let Some(response) = optional_request(
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

    fn tun_actual_state(
        status: &str,
        external_detected: bool,
    ) -> crate::reconciliation::TunActualState {
        if external_detected {
            return crate::reconciliation::TunActualState::External;
        }
        match status {
            "disabled" => crate::reconciliation::TunActualState::Disabled,
            "running" => crate::reconciliation::TunActualState::Enabled,
            "starting" | "stopping" => crate::reconciliation::TunActualState::Transitioning,
            _ => crate::reconciliation::TunActualState::Unknown,
        }
    }

    fn snapshot_from_service_status(
        status: ServiceStatusData,
        desired_enabled: bool,
    ) -> crate::tun::TunStatusSnapshot {
        let tun_status = match status.tun_status.as_str() {
            "disabled" => crate::tun::TunStatus::Disabled,
            "starting" => crate::tun::TunStatus::Starting,
            "running" => crate::tun::TunStatus::Running,
            "stopping" => crate::tun::TunStatus::Stopping,
            _ => crate::tun::TunStatus::Error,
        };
        crate::tun::TunStatusSnapshot {
            status: tun_status,
            message: status.tun_message,
            admin: status.admin,
            profile_id: status.tun_profile_id,
            snapshot: status.tun_snapshot,
            desired_enabled,
            actual_state: crate::tun::tun_state_for_status(tun_status).0,
            owner: crate::tun::tun_state_for_status(tun_status).1,
            external_detected: false,
            projection: match tun_status {
                crate::tun::TunStatus::Starting => {
                    crate::reconciliation::TunProjectionState::Enabling
                }
                crate::tun::TunStatus::Running => crate::reconciliation::TunProjectionState::On,
                crate::tun::TunStatus::Stopping => {
                    crate::reconciliation::TunProjectionState::Disabling
                }
                crate::tun::TunStatus::Error => crate::reconciliation::TunProjectionState::Error,
                crate::tun::TunStatus::Disabled => {
                    if desired_enabled {
                        crate::reconciliation::TunProjectionState::Recovering
                    } else {
                        crate::reconciliation::TunProjectionState::Off
                    }
                }
            },
        }
    }

    fn unavailable_tun_snapshot(
        desired_enabled: bool,
        message: impl Into<String>,
    ) -> crate::tun::TunStatusSnapshot {
        crate::tun::TunStatusSnapshot {
            status: crate::tun::TunStatus::Error,
            message: Some(message.into()),
            admin: false,
            profile_id: None,
            snapshot: None,
            desired_enabled,
            actual_state: crate::tun::TunActualState::Unknown,
            owner: crate::tun::TunOwner::Unknown,
            external_detected: false,
            projection: crate::reconciliation::TunProjectionState::Recovering,
        }
    }

    fn external_tun_snapshot(
        desired_enabled: bool,
        message: impl Into<String>,
    ) -> crate::tun::TunStatusSnapshot {
        crate::tun::TunStatusSnapshot {
            status: crate::tun::TunStatus::Disabled,
            message: Some(message.into()),
            admin: is_admin(),
            profile_id: None,
            snapshot: None,
            desired_enabled,
            actual_state: crate::tun::TunActualState::ExternalTun,
            owner: crate::tun::TunOwner::External,
            external_detected: true,
            projection: crate::reconciliation::TunProjectionState::External,
        }
    }

    pub(crate) async fn request_tun(
        app: &AppHandle,
        enabled: bool,
        profile_id: Option<String>,
        system_proxy_enabled: bool,
    ) -> Result<Option<crate::tun::TunStatusSnapshot>, String> {
        if let Some(message) = crate::tun::foreign_tun_conflict()? {
            return Ok(Some(external_tun_snapshot(enabled, message)));
        }
        if !service_is_installed()? {
            return Ok(None);
        }

        if enabled && matches!(installed_service_state()?, Some(ServiceState::Stopped)) {
            tokio::task::spawn_blocking(start_installed_service_once)
                .await
                .map_err(|error| format!("启动 MioProxy Service 任务失败：{error}"))??;
        }

        let generation = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
        let mut reconciler = crate::reconciliation::TunReconciler::new(enabled, generation);
        debug_assert_eq!(reconciler.generation(), generation);
        debug_assert_eq!(reconciler.desired_enabled(), enabled);
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut last_snapshot = None;

        while Instant::now() < deadline {
            let external = crate::tun::foreign_tun_conflict()?.is_some();
            let status_result = try_request_classified(
                app,
                ServiceCommand::Status,
                NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed),
            )
            .await;
            let (connectivity, actual, snapshot) = match status_result {
                Ok(Some(response)) => {
                    let status: ServiceStatusData = data(response)?;
                    let actual = tun_actual_state(&status.tun_status, external);
                    let snapshot = snapshot_from_service_status(status, enabled);
                    (ServiceConnectivity::Ready, actual, Some(snapshot))
                }
                Ok(None) => (
                    ServiceConnectivity::NotInstalled,
                    crate::reconciliation::TunActualState::Unknown,
                    None,
                ),
                Err(error) => {
                    let actual = if external {
                        crate::reconciliation::TunActualState::External
                    } else {
                        crate::reconciliation::TunActualState::Unknown
                    };
                    (error.connectivity, actual, None)
                }
            };
            if let Some(snapshot) = snapshot {
                last_snapshot = Some(snapshot);
            }

            match reconciler.observe(generation, connectivity, actual, external) {
                crate::reconciliation::ReconcileDecision::Complete => {
                    let mut snapshot = last_snapshot.unwrap_or_else(|| {
                        unavailable_tun_snapshot(enabled, "Service TUN 已达到目标状态")
                    });
                    snapshot.desired_enabled = enabled;
                    snapshot.projection = if enabled {
                        crate::reconciliation::TunProjectionState::On
                    } else {
                        crate::reconciliation::TunProjectionState::Off
                    };
                    return Ok(Some(snapshot));
                }
                crate::reconciliation::ReconcileDecision::AbortExternal => {
                    return Ok(Some(external_tun_snapshot(
                        enabled,
                        "检测到外部 TUN，已停止 MioProxy TUN 恢复操作",
                    )));
                }
                crate::reconciliation::ReconcileDecision::Fail(connectivity) => {
                    return Err(format!("MioProxy Service TUN 操作失败（{connectivity:?}）"));
                }
                crate::reconciliation::ReconcileDecision::IssueMutation => {
                    let command = ServiceCommand::TunSetEnabled {
                        enabled,
                        profile_id: profile_id.clone(),
                        system_proxy_enabled,
                    };
                    let result = try_request_classified(
                        app,
                        command,
                        NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed),
                    )
                    .await;
                    match result {
                        Ok(Some(response)) => {
                            let value: ServiceTunData = data(response)?;
                            last_snapshot = Some(value.clone().into_snapshot());
                            let _ = reconciler.record_mutation(
                                generation,
                                crate::reconciliation::MutationOutcome::Applied,
                            );
                        }
                        Ok(None) => {
                            let _ = reconciler.record_mutation(
                                generation,
                                crate::reconciliation::MutationOutcome::NotSent,
                            );
                        }
                        Err(error)
                            if matches!(
                                error.connectivity,
                                ServiceConnectivity::ProtocolFailure
                                    | ServiceConnectivity::AuthenticationFailure
                                    | ServiceConnectivity::CommandFailure
                            ) =>
                        {
                            let _ = reconciler.record_mutation(
                                generation,
                                crate::reconciliation::MutationOutcome::DeterministicFailure,
                            );
                            return Err(error.to_string());
                        }
                        Err(error) if error.request_written => {
                            let _ = reconciler.record_mutation(
                                generation,
                                crate::reconciliation::MutationOutcome::Ambiguous,
                            );
                            last_snapshot = Some(unavailable_tun_snapshot(
                                enabled,
                                "Service 已收到 TUN 请求但响应丢失，正在按权威状态恢复",
                            ));
                        }
                        Err(error)
                            if matches!(
                                error.connectivity,
                                ServiceConnectivity::ScmStarting
                                    | ServiceConnectivity::PipeNotReady
                                    | ServiceConnectivity::Transient
                                    | ServiceConnectivity::ServiceStopped
                            ) =>
                        {
                            let _ = reconciler.record_mutation(
                                generation,
                                crate::reconciliation::MutationOutcome::NotSent,
                            );
                        }
                        Err(error) => {
                            let _ = reconciler.record_mutation(
                                generation,
                                crate::reconciliation::MutationOutcome::DeterministicFailure,
                            );
                            return Err(error.to_string());
                        }
                    }
                }
                crate::reconciliation::ReconcileDecision::Wait(projection) => {
                    let mut snapshot = last_snapshot.clone().unwrap_or_else(|| {
                        unavailable_tun_snapshot(enabled, "等待 MioProxy Service IPC 恢复")
                    });
                    snapshot.desired_enabled = enabled;
                    snapshot.projection = projection;
                    last_snapshot = Some(snapshot);
                }
                crate::reconciliation::ReconcileDecision::Stale => {
                    return Ok(Some(unavailable_tun_snapshot(
                        enabled,
                        "TUN 请求已被更新的用户意图取代",
                    )));
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        let mut snapshot = last_snapshot.unwrap_or_else(|| {
            unavailable_tun_snapshot(enabled, "MioProxy Service IPC 尚未在期限内恢复")
        });
        snapshot.desired_enabled = enabled;
        snapshot.projection = crate::reconciliation::TunProjectionState::Recovering;
        snapshot.message = Some(
            "MioProxy Service IPC 正在恢复；已保留用户期望 TUN 状态，未重复执行未确认的切换"
                .to_string(),
        );
        Ok(Some(snapshot))
    }

    pub(crate) async fn restore_for_lifecycle(app: &AppHandle) -> Result<(), String> {
        let installed = match service_is_installed() {
            Ok(installed) => installed,
            Err(error) => {
                crate::diagnostics::record_event(
                    app,
                    "warn",
                    "service",
                    format!("退出时无法确认 Service 安装状态，保留现有网络状态：{error}"),
                );
                return Ok(());
            }
        };
        if !installed {
            return Ok(());
        }

        let status = match tokio::time::timeout(
            Duration::from_secs(1),
            try_request_classified(
                app,
                ServiceCommand::Status,
                NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed),
            ),
        )
        .await
        {
            Ok(Ok(Some(response))) => match data::<ServiceStatusData>(response) {
                Ok(status) => status,
                Err(error) => {
                    crate::diagnostics::record_event(
                        app,
                        "warn",
                        "service",
                        format!("退出时 Service 状态无效，保留现有网络状态：{error}"),
                    );
                    return Ok(());
                }
            },
            Ok(Ok(None)) | Ok(Err(_)) | Err(_) => {
                crate::diagnostics::record_event(
                    app,
                    "warn",
                    "service",
                    "退出时 Service IPC 不可确认，未重复执行 TUN 清理",
                );
                return Ok(());
            }
        };
        if status.tun_status == "disabled" {
            return Ok(());
        }
        let external_tun = match crate::tun::foreign_tun_conflict() {
            Ok(external) => external.is_some(),
            Err(error) => {
                crate::diagnostics::record_event(
                    app,
                    "warn",
                    "service",
                    format!("退出时无法确认外部 TUN，未修改任何 TUN 状态：{error}"),
                );
                return Ok(());
            }
        };
        if external_tun {
            crate::diagnostics::record_event(
                app,
                "warn",
                "service",
                "退出时检测到外部 TUN，未修改任何 TUN 状态",
            );
            return Ok(());
        }

        let command = ServiceCommand::TunSetEnabled {
            enabled: false,
            profile_id: None,
            system_proxy_enabled: false,
        };
        match tokio::time::timeout(
            Duration::from_secs(2),
            try_request_classified(
                app,
                command,
                NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed),
            ),
        )
        .await
        {
            Ok(Ok(Some(_))) => Ok(()),
            Ok(Ok(None)) | Ok(Err(_)) | Err(_) => {
                crate::diagnostics::record_event(
                    app,
                    "warn",
                    "service",
                    "退出时 TUN 清理未确认，未重复执行或反转请求，保留现有网络状态",
                );
                Ok(())
            }
        }
    }

    fn stop_installed_service() -> Result<(), String> {
        let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
            .map_err(|error| format!("打开 MioProxy Service Manager 失败：{error}"))?;
        let service = manager
            .open_service(
                SERVICE_NAME,
                ServiceAccess::STOP | ServiceAccess::QUERY_STATUS,
            )
            .map_err(|error| format!("打开 MioProxy Service 失败：{error}"))?;
        let status = service
            .query_status()
            .map_err(|error| format!("查询 MioProxy Service 状态失败：{error}"))?;
        if status.current_state != ServiceState::Stopped {
            match service.stop() {
                Ok(_) => {}
                Err(windows_service::Error::Winapi(error))
                    if error.raw_os_error() == Some(1062) => {}
                Err(error) => return Err(format!("停止 MioProxy Service 失败：{error}")),
            }
        }
        let stopped = (0..100).any(|_| {
            let is_stopped = service
                .query_status()
                .map(|next| next.current_state == ServiceState::Stopped)
                .unwrap_or(false);
            if !is_stopped {
                std::thread::sleep(Duration::from_millis(100));
            }
            is_stopped
        });
        if !stopped {
            return Err("MioProxy Service 未能在 10 秒内停止，拒绝进入安装阶段".to_string());
        }
        let final_status = service
            .query_status()
            .map_err(|error| format!("查询 MioProxy Service 停止结果失败：{error}"))?;
        if final_status.exit_code != ServiceExitCode::NO_ERROR {
            return Err("MioProxy Service 停止时未完成 TUN/网络恢复，拒绝进入安装阶段".to_string());
        }
        Ok(())
    }

    fn start_installed_service_once() -> Result<(), String> {
        let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
            .map_err(|error| format!("打开 MioProxy Service Manager 失败：{error}"))?;
        let service = manager
            .open_service(
                SERVICE_NAME,
                ServiceAccess::START | ServiceAccess::QUERY_STATUS,
            )
            .map_err(|error| format!("打开 MioProxy Service 失败：{error}"))?;
        let status = service
            .query_status()
            .map_err(|error| format!("查询 MioProxy Service 状态失败：{error}"))?;
        if status.current_state == ServiceState::Stopped {
            match service.start::<&str>(&[]) {
                Ok(()) => {}
                Err(windows_service::Error::Winapi(error))
                    if error.raw_os_error() == Some(1056) => {}
                Err(error) => return Err(format!("重新启动 MioProxy Service 失败：{error}")),
            }
        }
        Ok(())
    }

    fn start_installed_service() -> Result<(), String> {
        start_installed_service_once()?;
        let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
            .map_err(|error| format!("打开 MioProxy Service Manager 失败：{error}"))?;
        let service = manager
            .open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS)
            .map_err(|error| format!("打开 MioProxy Service 失败：{error}"))?;
        let running = (0..100).any(|_| {
            let is_running = service
                .query_status()
                .map(|next| next.current_state == ServiceState::Running)
                .unwrap_or(false);
            if !is_running {
                std::thread::sleep(Duration::from_millis(100));
            }
            is_running
        });
        if !running {
            return Err("MioProxy Service 未能在 10 秒内恢复 Running".to_string());
        }
        Ok(())
    }

    pub(crate) fn verify_stopped_for_update() -> Result<(), String> {
        if !service_is_installed()? {
            return Ok(());
        }
        let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
            .map_err(|error| format!("打开 MioProxy Service Manager 失败：{error}"))?;
        let service = manager
            .open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS)
            .map_err(|error| format!("打开 MioProxy Service 失败：{error}"))?;
        let status = service
            .query_status()
            .map_err(|error| format!("查询 MioProxy Service 状态失败：{error}"))?;
        if status.current_state != ServiceState::Stopped {
            return Err("MioProxy Service 仍在运行，拒绝启动更新安装器".to_string());
        }
        if status.exit_code != ServiceExitCode::NO_ERROR {
            return Err("MioProxy Service 上次停止未完成网络清理，拒绝启动更新安装器".to_string());
        }
        Ok(())
    }

    pub(crate) async fn prepare_for_update(app: &AppHandle) -> Result<(), String> {
        let installed = service_is_installed()?;
        let Some(response) = try_request(app, ServiceCommand::Status).await? else {
            if installed {
                return Err("MioProxy Service 已安装但 IPC 不可用，拒绝更新".to_string());
            }
            return Ok(());
        };
        let status: ServiceStatusData = data(response)?;
        if status.tun_status != "disabled" {
            let Some(response) = try_request(
                app,
                ServiceCommand::TunSetEnabled {
                    enabled: false,
                    profile_id: None,
                    system_proxy_enabled: false,
                },
            )
            .await?
            else {
                return Err("MioProxy Service TUN 清理后 IPC 丢失，拒绝更新".to_string());
            };
            let tun: ServiceTunData = data(response)?;
            if tun.status != "disabled" {
                return Err(format!(
                    "MioProxy Service TUN 未恢复为 disabled（当前 {}），拒绝更新",
                    tun.status
                ));
            }
        }
        if status.owns_core || status.core.running {
            let Some(response) = try_request(app, ServiceCommand::Stop).await? else {
                return Err("停止受管 Mihomo 后 IPC 丢失，拒绝更新".to_string());
            };
            let core: crate::mihomo::CoreStatus = data(response)?;
            if core.running || mihomo::is_running().await {
                return Err("受管 Mihomo 未完全停止，拒绝更新".to_string());
            }
        }
        if installed {
            stop_installed_service()?;
        }
        verify_stopped_for_update()
    }

    pub(crate) async fn resume_after_update_failure(
        app: &AppHandle,
        should_restart: bool,
    ) -> Result<(), String> {
        if !should_restart || !service_is_installed()? {
            return Ok(());
        }
        start_installed_service()?;
        for _ in 0..100 {
            if try_request(app, ServiceCommand::Status).await?.is_some() {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Err("MioProxy Service 已启动但 IPC 未在 10 秒内恢复".to_string())
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
                desired_enabled: status != crate::tun::TunStatus::Disabled,
                actual_state: crate::tun::tun_state_for_status(status).0,
                owner: crate::tun::tun_state_for_status(status).1,
                external_detected: false,
                projection: match status {
                    crate::tun::TunStatus::Starting => {
                        crate::reconciliation::TunProjectionState::Enabling
                    }
                    crate::tun::TunStatus::Running => crate::reconciliation::TunProjectionState::On,
                    crate::tun::TunStatus::Stopping => {
                        crate::reconciliation::TunProjectionState::Disabling
                    }
                    crate::tun::TunStatus::Error => {
                        crate::reconciliation::TunProjectionState::Error
                    }
                    crate::tun::TunStatus::Disabled => {
                        crate::reconciliation::TunProjectionState::Off
                    }
                },
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
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "deserialize_previous_override"
        )]
        previous_override: Option<String>,
        profile_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        snapshot: Option<crate::tun::NetworkSnapshot>,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum TunRuntimeRestorePath<'a> {
        ActiveRuntime,
        LegacyOverride(&'a str),
    }

    fn normalize_previous_override(previous_override: Option<String>) -> Option<String> {
        previous_override.filter(|content| !content.trim().is_empty())
    }

    fn deserialize_previous_override<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<String>::deserialize(deserializer).map(normalize_previous_override)
    }

    fn tun_runtime_restore_path(previous_override: Option<&str>) -> TunRuntimeRestorePath<'_> {
        match previous_override {
            Some(content) if !content.trim().is_empty() => {
                TunRuntimeRestorePath::LegacyOverride(content)
            }
            _ => TunRuntimeRestorePath::ActiveRuntime,
        }
    }

    fn controller_reload_diagnostic_stage(error: &str) -> &'static str {
        if error.starts_with("Mihomo Controller 拒绝请求") {
            "controller-reload"
        } else {
            "controller-communication"
        }
    }

    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PersistedCoreState {
        #[serde(default)]
        format_version: u8,
        desired_running: bool,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum CoreRecoveryMode {
        Active,
        BackingOff,
        Suspended,
    }

    #[derive(Debug, Clone, Default, PartialEq, Eq)]
    struct CoreRecoveryState {
        failure_count: u32,
        last_failure_at: Option<u64>,
        next_retry_at: Option<u64>,
        healthy_since: Option<u64>,
        suspended: bool,
        last_error: Option<String>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PersistedCoreRecoveryState {
        #[serde(default)]
        format_version: u8,
        #[serde(default)]
        failure_count: u32,
        #[serde(default)]
        last_failure_at: Option<u64>,
        #[serde(default)]
        next_retry_at: Option<u64>,
        #[serde(default)]
        healthy_since: Option<u64>,
        #[serde(default)]
        suspended: bool,
        #[serde(default)]
        last_error: Option<String>,
    }

    impl CoreRecoveryState {
        fn from_persisted(persisted: PersistedCoreRecoveryState, now: u64) -> (Self, bool) {
            if persisted.format_version != CORE_RECOVERY_STATE_FORMAT_VERSION
                || (persisted.failure_count == 0 && persisted.suspended)
                || persisted.failure_count > CORE_RECOVERY_MAX_FAILURES
                || (persisted.failure_count > 0 && persisted.last_failure_at.is_none())
                || persisted
                    .last_failure_at
                    .is_some_and(|last_failure_at| last_failure_at > now)
                || persisted
                    .healthy_since
                    .is_some_and(|healthy_since| healthy_since > now)
            {
                return (Self::default(), true);
            }

            let mut state = Self {
                failure_count: persisted.failure_count,
                last_failure_at: persisted.last_failure_at,
                next_retry_at: persisted.next_retry_at,
                healthy_since: persisted.healthy_since,
                suspended: persisted.suspended,
                last_error: persisted
                    .last_error
                    .as_deref()
                    .map(bounded_core_recovery_error),
            };
            let original = state.clone();

            if state.failure_count == 0
                || state.last_failure_at.is_some_and(|last| {
                    now.saturating_sub(last) >= CORE_RECOVERY_FAILURE_WINDOW_SECS
                })
                || state.healthy_since.is_some_and(|healthy_since| {
                    now.saturating_sub(healthy_since) >= CORE_RECOVERY_HEALTHY_RESET_SECS
                })
            {
                state = Self::default();
            } else if state.failure_count == CORE_RECOVERY_MAX_FAILURES {
                state.suspended = true;
                state.next_retry_at = None;
            }

            (state.clone(), state != original)
        }

        fn expired(&self, now: u64) -> bool {
            self.last_failure_at
                .is_some_and(|last| now.saturating_sub(last) >= CORE_RECOVERY_FAILURE_WINDOW_SECS)
        }

        fn reset_if_expired(&mut self, now: u64) -> bool {
            if !self.expired(now) {
                return false;
            }
            *self = Self::default();
            true
        }

        fn reset(&mut self) {
            *self = Self::default();
        }

        fn to_persisted(&self) -> PersistedCoreRecoveryState {
            PersistedCoreRecoveryState {
                format_version: CORE_RECOVERY_STATE_FORMAT_VERSION,
                failure_count: self.failure_count,
                last_failure_at: self.last_failure_at,
                next_retry_at: self.next_retry_at,
                healthy_since: self.healthy_since,
                suspended: self.suspended,
                last_error: self.last_error.clone(),
            }
        }

        fn mode(&self, now: u64) -> CoreRecoveryMode {
            if self.suspended {
                CoreRecoveryMode::Suspended
            } else if self.next_retry_at.is_some_and(|retry_at| retry_at > now) {
                CoreRecoveryMode::BackingOff
            } else {
                CoreRecoveryMode::Active
            }
        }

        fn can_attempt(&self, now: u64) -> bool {
            matches!(self.mode(now), CoreRecoveryMode::Active)
        }

        fn record_failure(&mut self, now: u64, error: &str) {
            self.reset_if_expired(now);
            self.failure_count = self
                .failure_count
                .saturating_add(1)
                .min(CORE_RECOVERY_MAX_FAILURES);
            self.last_failure_at = Some(now);
            self.healthy_since = None;
            self.last_error = Some(bounded_core_recovery_error(error));
            if self.failure_count >= CORE_RECOVERY_MAX_FAILURES {
                self.suspended = true;
                self.next_retry_at = None;
            } else {
                let delay_index = (self.failure_count - 1) as usize;
                self.suspended = false;
                let delay = CORE_RECOVERY_RETRY_DELAYS_SECS
                    .get(delay_index)
                    .copied()
                    .unwrap_or_else(|| {
                        *CORE_RECOVERY_RETRY_DELAYS_SECS
                            .last()
                            .expect("core recovery retry policy is non-empty")
                    });
                self.next_retry_at = Some(now.saturating_add(delay));
            }
        }

        fn mark_ready(&mut self, now: u64) -> bool {
            if self.reset_if_expired(now) {
                return true;
            }
            if self.failure_count == 0 {
                return false;
            }
            self.next_retry_at = None;
            if self.healthy_since.is_none() {
                self.healthy_since = Some(now);
                return true;
            }
            if now.saturating_sub(self.healthy_since.unwrap_or(now))
                >= CORE_RECOVERY_HEALTHY_RESET_SECS
            {
                *self = Self::default();
                return true;
            }
            false
        }

        fn retry_remaining_secs(&self, now: u64) -> Option<u64> {
            self.next_retry_at
                .filter(|retry_at| *retry_at > now)
                .map(|retry_at| retry_at - now)
        }
    }

    fn bounded_core_recovery_error(error: &str) -> String {
        error.chars().take(CORE_RECOVERY_ERROR_MAX_CHARS).collect()
    }

    fn recovery_now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or_default()
    }

    fn core_recovery_message(state: &CoreRecoveryState, now: u64) -> Option<String> {
        if state.failure_count == 0 || state.expired(now) || state.healthy_since.is_some() {
            return None;
        }
        let detail = state
            .last_error
            .as_deref()
            .map(|error| format!("：{error}"))
            .unwrap_or_default();
        match state.mode(now) {
            CoreRecoveryMode::Suspended => Some(format!(
                "Mihomo 反复启动失败，自动恢复已暂停，请手动重试{detail}"
            )),
            CoreRecoveryMode::BackingOff => Some(format!(
                "Mihomo 自动恢复退避中，约 {} 秒后重试{detail}",
                state.retry_remaining_secs(now).unwrap_or_default()
            )),
            CoreRecoveryMode::Active if state.failure_count > 0 => Some(format!(
                "Mihomo 正在自动恢复（第 {} / {} 次失败）{detail}",
                state.failure_count, CORE_RECOVERY_MAX_FAILURES
            )),
            CoreRecoveryMode::Active => None,
        }
    }

    fn read_core_recovery_state(
        data_dir: &Path,
        now: u64,
    ) -> Result<(CoreRecoveryState, bool), String> {
        let path = data_dir.join(CORE_RECOVERY_STATE_FILE);
        let Some(content) = config::read_text_file_at(&path, "读取 Service Core 恢复状态")?
        else {
            return Ok((CoreRecoveryState::default(), false));
        };
        let persisted = serde_json::from_str::<PersistedCoreRecoveryState>(&content)
            .map_err(|error| format!("Service Core 恢复状态损坏：{error}"))?;
        Ok(CoreRecoveryState::from_persisted(persisted, now))
    }

    fn persist_core_recovery_state(
        data_dir: &Path,
        state: &CoreRecoveryState,
    ) -> Result<(), String> {
        let path = data_dir.join(CORE_RECOVERY_STATE_FILE);
        if state.failure_count == 0 {
            return config::remove_file(&path, "清理 Service Core 恢复状态");
        }
        let bytes =
            serde_json::to_vec_pretty(&state.to_persisted()).map_err(|error| error.to_string())?;
        write_atomic(&path, &bytes)
    }

    #[derive(Deserialize, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct PersistedServiceCoreOwner {
        owner: String,
        pid: u32,
    }

    fn read_persisted_service_core_pid_at(data_dir: &Path) -> Option<u32> {
        let path = data_dir.join(SERVICE_CORE_OWNER_FILE);
        let content = config::read_text_file_at(&path, "读取 Service Core owner").ok()??;
        let state = serde_json::from_str::<PersistedServiceCoreOwner>(&content).ok()?;
        (state.owner == "service" && state.pid != 0).then_some(state.pid)
    }

    pub(crate) fn persisted_managed_core_pid(app: &AppHandle) -> Option<u32> {
        let data_dir = app.path().app_data_dir().ok()?;
        read_persisted_service_core_pid_at(&data_dir)
    }

    fn persist_service_core_owner(data_dir: &Path, pid: u32) -> Result<(), String> {
        let bytes = serde_json::to_vec(&PersistedServiceCoreOwner {
            owner: "service".to_string(),
            pid,
        })
        .map_err(|error| error.to_string())?;
        write_atomic(&data_dir.join(SERVICE_CORE_OWNER_FILE), &bytes)
    }

    fn clear_service_core_owner_if_matches(data_dir: &Path, pid: u32) -> Result<(), String> {
        if read_persisted_service_core_pid_at(data_dir) == Some(pid) {
            config::remove_file(
                &data_dir.join(SERVICE_CORE_OWNER_FILE),
                "清理 Service Core owner",
            )?;
        }
        Ok(())
    }

    fn read_desired_core_state(data_dir: &Path) -> Result<bool, String> {
        let path = data_dir.join(CORE_STATE_FILE);
        let Some(content) = config::read_text_file_at(&path, "读取 Service Mihomo 期望状态")?
        else {
            // Core is a Service-owned prerequisite. A missing legacy state file
            // therefore means the default desired state is Ready, not stopped.
            return Ok(true);
        };
        let state = serde_json::from_str::<PersistedCoreState>(&content)
            .map_err(|e| format!("Service Mihomo 期望状态损坏：{e}"))?;
        // V0.9 makes Core Ready the normal product default. State files written
        // before this format version came from the old primary Start/Stop UI, so
        // they must not keep a newly upgraded Service permanently stopped.
        if state.format_version < CORE_STATE_FORMAT_VERSION {
            return Ok(true);
        }
        Ok(state.desired_running)
    }

    struct ServiceRuntime {
        data_dir: PathBuf,
        mihomo_path: PathBuf,
        child: Mutex<Option<Child>>,
        job: JobGuard,
        tun: Mutex<ServiceTunState>,
        desired_core_running: Mutex<bool>,
        core_recovery: Mutex<CoreRecoveryState>,
        core_recovery_message: Mutex<Option<String>>,
        core_exit_pending: Mutex<bool>,
        pending_tun_profile: Mutex<Option<String>>,
        outbound_compatibility: Mutex<outbound::OutboundCompatibility>,
        core_transition: AsyncMutex<()>,
        tun_transition: AsyncMutex<()>,
        core_update: Mutex<crate::core_update::CoreUpdateStatus>,
        core_update_transition: AsyncMutex<()>,
    }

    impl ServiceRuntime {
        fn new(data_dir: PathBuf, mihomo_path: PathBuf) -> Result<Self, String> {
            fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
            crate::core_update::recover_orphaned_backup(&mihomo_path)?;
            let _ = ensure_token(&data_dir)?;
            let desired_core_running = read_desired_core_state(&data_dir).unwrap_or_else(|error| {
                eprintln!("读取 Service Mihomo 期望状态失败：{error}");
                false
            });
            let now = recovery_now();
            let core_recovery = match read_core_recovery_state(&data_dir, now) {
                Ok((state, should_clear)) => {
                    if should_clear {
                        if let Err(error) =
                            persist_core_recovery_state(&data_dir, &CoreRecoveryState::default())
                        {
                            eprintln!("清理过期 Service Core 恢复状态失败：{error}");
                        }
                    }
                    state
                }
                Err(error) => {
                    eprintln!("读取 Service Core 恢复状态失败，已重置：{error}");
                    if let Err(reset_error) =
                        persist_core_recovery_state(&data_dir, &CoreRecoveryState::default())
                    {
                        eprintln!("重置 Service Core 恢复状态失败：{reset_error}");
                    }
                    CoreRecoveryState::default()
                }
            };
            let initial_recovery_message = core_recovery_message(&core_recovery, now);
            Ok(Self {
                data_dir,
                mihomo_path,
                child: Mutex::new(None),
                job: JobGuard::new()?,
                tun: Mutex::new(ServiceTunState::default()),
                desired_core_running: Mutex::new(desired_core_running),
                core_recovery: Mutex::new(core_recovery),
                core_recovery_message: Mutex::new(initial_recovery_message),
                core_exit_pending: Mutex::new(false),
                pending_tun_profile: Mutex::new(None),
                outbound_compatibility: Mutex::new(outbound::resolve().unwrap_or_default()),
                core_transition: AsyncMutex::const_new(()),
                tun_transition: AsyncMutex::const_new(()),
                core_update: Mutex::new(crate::core_update::CoreUpdateStatus::default()),
                core_update_transition: AsyncMutex::const_new(()),
            })
        }

        fn config_path(&self) -> PathBuf {
            config::config_path_at(&self.data_dir)
        }

        fn service_tun_path(&self) -> PathBuf {
            self.data_dir.join("service-tun-state.json")
        }

        fn core_state_path(&self) -> PathBuf {
            self.data_dir.join(CORE_STATE_FILE)
        }

        fn desired_core_running(&self) -> Result<bool, String> {
            self.desired_core_running
                .lock()
                .map(|desired| *desired)
                .map_err(|_| "Service Mihomo 期望状态锁异常".to_string())
        }

        fn set_desired_core_running(&self, desired: bool) -> Result<(), String> {
            let mut current = self
                .desired_core_running
                .lock()
                .map_err(|_| "Service Mihomo 期望状态锁异常")?;
            *current = desired;
            let state = PersistedCoreState {
                format_version: CORE_STATE_FORMAT_VERSION,
                desired_running: desired,
            };
            let bytes = serde_json::to_vec_pretty(&state).map_err(|e| e.to_string())?;
            write_atomic(&self.core_state_path(), &bytes)
        }

        fn core_recovery_message(&self) -> Result<Option<String>, String> {
            self.core_recovery_message
                .lock()
                .map(|message| message.clone())
                .map_err(|_| "Service Mihomo 恢复状态锁异常".to_string())
        }

        fn set_core_recovery_message(&self, message: Option<String>) -> Result<(), String> {
            *self
                .core_recovery_message
                .lock()
                .map_err(|_| "Service Mihomo 恢复状态锁异常")? = message;
            Ok(())
        }

        fn persist_core_recovery(&self, state: &CoreRecoveryState) -> Result<(), String> {
            persist_core_recovery_state(&self.data_dir, state)
        }

        fn reset_core_recovery(&self) -> Result<(), String> {
            let state = {
                let mut current = self
                    .core_recovery
                    .lock()
                    .map_err(|_| "Service Mihomo 恢复策略锁异常")?;
                current.reset();
                current.clone()
            };
            self.persist_core_recovery(&state)?;
            self.set_core_recovery_message(None)
        }

        fn recovery_can_attempt(&self, now: u64) -> Result<bool, String> {
            let (state, expired) = {
                let mut current = self
                    .core_recovery
                    .lock()
                    .map_err(|_| "Service Mihomo 恢复策略锁异常")?;
                let expired = current.reset_if_expired(now);
                (current.clone(), expired)
            };
            if expired {
                self.persist_core_recovery(&state)?;
                self.set_core_recovery_message(None)?;
                return Ok(true);
            }
            let can_attempt = state.can_attempt(now);
            if !can_attempt {
                self.set_core_recovery_message(core_recovery_message(&state, now))?;
            }
            Ok(can_attempt)
        }

        fn record_core_recovery_failure(&self, error: &str) -> Result<(), String> {
            let now = recovery_now();
            let state = {
                let mut current = self
                    .core_recovery
                    .lock()
                    .map_err(|_| "Service Mihomo 恢复策略锁异常")?;
                current.record_failure(now, error);
                current.clone()
            };
            self.persist_core_recovery(&state)?;
            self.set_core_recovery_message(core_recovery_message(&state, now))
        }

        fn observe_core_ready(&self) -> Result<(), String> {
            let now = recovery_now();
            let (state, changed) = {
                let mut current = self
                    .core_recovery
                    .lock()
                    .map_err(|_| "Service Mihomo 恢复策略锁异常")?;
                let changed = current.mark_ready(now);
                (current.clone(), changed)
            };
            if changed {
                self.persist_core_recovery(&state)?;
            }
            self.set_core_recovery_message(None)
        }

        fn take_core_exit_pending(&self) -> Result<bool, String> {
            let mut pending = self
                .core_exit_pending
                .lock()
                .map_err(|_| "Service Mihomo 退出状态锁异常")?;
            let exited = *pending;
            *pending = false;
            Ok(exited)
        }

        fn clear_core_exit_pending(&self) -> Result<(), String> {
            *self
                .core_exit_pending
                .lock()
                .map_err(|_| "Service Mihomo 退出状态锁异常")? = false;
            Ok(())
        }

        fn read_tun_persisted(&self) -> Result<Option<PersistedServiceTunState>, String> {
            let path = self.service_tun_path();
            let Some(content) = config::read_text_file_at(&path, "读取 Service TUN 恢复状态")?
            else {
                return Ok(None);
            };
            serde_json::from_str(&content)
                .map(Some)
                .map_err(|e| e.to_string())
        }

        fn set_recovery_error(&self, error: String) -> Result<(), String> {
            let mut tun = self.tun.lock().map_err(|_| "Service TUN 状态锁异常")?;
            tun.status = crate::tun::TunStatus::Error;
            tun.message = Some(format!("Service TUN 启动恢复失败：{error}"));
            Ok(())
        }

        fn write_tun_persisted(&self) -> Result<(), String> {
            let tun = self.tun.lock().map_err(|_| "Service TUN 状态锁异常")?;
            let state = PersistedServiceTunState {
                previous_override: normalize_previous_override(tun.previous_override.clone()),
                profile_id: tun
                    .profile_id
                    .clone()
                    .ok_or_else(|| "Service TUN 缺少恢复用 Profile".to_string())?,
                snapshot: tun.snapshot.clone(),
            };
            let path = self.service_tun_path();
            let bytes = serde_json::to_vec_pretty(&state).map_err(|e| e.to_string())?;
            write_atomic(&path, &bytes)
        }

        fn ensure_profile_apply_allowed(&self) -> Result<(), String> {
            let status = self
                .tun
                .lock()
                .map_err(|_| "Service TUN 状态锁异常")?
                .status;
            match status {
                crate::tun::TunStatus::Disabled | crate::tun::TunStatus::Running => Ok(()),
                crate::tun::TunStatus::Starting | crate::tun::TunStatus::Stopping => {
                    Err("Service TUN 正在切换，暂时不能应用 Profile".to_string())
                }
                crate::tun::TunStatus::Error if self.has_tun_recovery() => {
                    Err("Service TUN 正在等待恢复，暂时不能应用 Profile".to_string())
                }
                crate::tun::TunStatus::Error => Ok(()),
            }
        }

        fn rebind_tun_profile(&self, profile_id: &str) -> Result<(), String> {
            let previous_profile_id = {
                let mut tun = self.tun.lock().map_err(|_| "Service TUN 状态锁异常")?;
                if tun.status == crate::tun::TunStatus::Disabled {
                    return Ok(());
                }
                if tun.status != crate::tun::TunStatus::Running {
                    return Err("Service TUN 正在切换或等待恢复，暂时不能应用 Profile".to_string());
                }
                let previous_profile_id = tun.profile_id.clone();
                tun.profile_id = Some(profile_id.to_string());
                previous_profile_id
            };
            if let Err(error) = self.write_tun_persisted() {
                if let Ok(mut tun) = self.tun.lock() {
                    tun.profile_id = previous_profile_id;
                }
                return Err(format!("更新 Service TUN 显示 Profile 失败：{error}"));
            }
            Ok(())
        }

        fn clear_tun_persisted(&self) -> Result<(), String> {
            let path = self.service_tun_path();
            config::remove_file(&path, "删除 Service TUN 恢复状态")
        }

        fn has_tun_recovery(&self) -> bool {
            fs::symlink_metadata(self.service_tun_path()).is_ok()
                || self
                    .tun
                    .lock()
                    .ok()
                    .is_some_and(|tun| tun.profile_id.is_some())
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
            let mut exited = false;
            if let Some(process) = child.as_mut() {
                if process.try_wait().map_err(|e| e.to_string())?.is_some() {
                    let managed_pid = process.id();
                    *child = None;
                    clear_service_core_owner_if_matches(&self.data_dir, managed_pid)?;
                    exited = true;
                }
            }
            drop(child);
            if exited {
                *self
                    .core_exit_pending
                    .lock()
                    .map_err(|_| "Service Mihomo 退出状态锁异常")? = true;
            }
            Ok(())
        }

        #[cfg(feature = "validation-fault-injection")]
        async fn validation_crash_managed_core(&self) -> Result<Value, String> {
            let _core_transition = self.core_transition.lock().await;
            let _transition = self.tun_transition.lock().await;
            self.refresh_child()?;
            let mut child = self.child.lock().map_err(|_| "Service Mihomo 状态锁异常")?;
            let process = child
                .as_mut()
                .ok_or_else(|| "Service 当前没有可注入故障的受管 Mihomo".to_string())?;
            let managed_pid = process.id();
            process
                .kill()
                .map_err(|error| format!("注入受管 Mihomo 异常退出失败：{error}"))?;
            clear_service_core_owner_if_matches(&self.data_dir, managed_pid)?;
            Ok(json!({
                "triggered": true,
                "managedPid": managed_pid,
                "managedExecutablePath": self.mihomo_path,
            }))
        }

        fn owns_core(&self) -> Result<bool, String> {
            self.refresh_child()?;
            Ok(self
                .child
                .lock()
                .map_err(|_| "Service Mihomo 状态锁异常")?
                .is_some())
        }

        fn managed_core_pid(&self) -> Result<Option<u32>, String> {
            self.refresh_child()?;
            Ok(self
                .child
                .lock()
                .map_err(|_| "Service Mihomo 状态锁异常")?
                .as_ref()
                .map(Child::id))
        }

        async fn owned_core_ready(&self) -> Result<bool, String> {
            let Some(managed_pid) = self.managed_core_pid()? else {
                return Ok(false);
            };
            let (configured_mixed_port, _) = self.runtime_config()?;
            let mixed_port = config::actual_runtime_mixed_port_at(&self.data_dir)
                .unwrap_or(configured_mixed_port);
            mihomo::core_ready_for_pid(mixed_port, managed_pid).await
        }

        fn stop_owned_child_for_retry(&self) -> Result<(), String> {
            if let Some(mut child) = self
                .child
                .lock()
                .map_err(|_| "Service Mihomo 状态锁异常")?
                .take()
            {
                let managed_pid = child.id();
                let _ = child.kill();
                let _ = child.wait();
                clear_service_core_owner_if_matches(&self.data_dir, managed_pid)?;
            }
            Ok(())
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
                secret = mihomo::secret(),
            );
            write_atomic(&self.config_path(), yaml.as_bytes())
        }

        fn refresh_outbound_compatibility(&self) -> Result<bool, String> {
            let current = outbound::resolve()?;
            let mut previous = self
                .outbound_compatibility
                .lock()
                .map_err(|_| "Service outbound compatibility 状态锁异常")?;
            if *previous == current {
                return Ok(false);
            }
            *previous = current;
            Ok(true)
        }

        fn runtime_config(&self) -> Result<(u16, String), String> {
            #[derive(Deserialize)]
            struct RuntimeConfig {
                #[serde(rename = "mixed-port")]
                mixed_port: Option<u16>,
                mode: Option<String>,
            }
            let Some(content) =
                config::read_text_file_at(&self.config_path(), "读取 Service 配置")?
            else {
                return Ok((7890, "rule".to_string()));
            };
            let value =
                serde_yaml::from_str::<RuntimeConfig>(&content).map_err(|e| e.to_string())?;
            Ok((
                value.mixed_port.unwrap_or(7890),
                value.mode.unwrap_or_else(|| "rule".to_string()),
            ))
        }

        async fn core_status(&self) -> Result<crate::mihomo::CoreStatus, String> {
            let managed_pid = self.managed_core_pid()?;
            let controller_ready = mihomo::is_running().await;
            let (configured_mixed_port, mode) = self.runtime_config()?;
            let mixed_port = if controller_ready {
                config::actual_runtime_mixed_port_at(&self.data_dir)
                    .unwrap_or(configured_mixed_port)
            } else {
                configured_mixed_port
            };
            let recovery_message = self.core_recovery_message()?;
            let ready = match managed_pid {
                Some(managed_pid) => mihomo::core_ready_for_pid(mixed_port, managed_pid).await?,
                None => false,
            };
            let state = if ready {
                crate::mihomo::CoreUserState::Ready
            } else if managed_pid.is_some() {
                if recovery_message.is_some() {
                    crate::mihomo::CoreUserState::Error
                } else {
                    crate::mihomo::CoreUserState::Starting
                }
            } else if controller_ready {
                // A controller owned by another MioProxy runtime is an ownership
                // boundary, not a Service Core failure.
                crate::mihomo::CoreUserState::Stopped
            } else if self.desired_core_running()? {
                if recovery_message.is_some() {
                    crate::mihomo::CoreUserState::Error
                } else {
                    crate::mihomo::CoreUserState::Starting
                }
            } else {
                crate::mihomo::CoreUserState::Stopped
            };
            Ok(crate::mihomo::CoreStatus {
                state,
                running: ready,
                controller: mihomo::CONTROLLER.to_string(),
                config_path: config::mihomo_path_string(&self.config_path()),
                mixed_port,
                mode,
                recovery_message,
            })
        }

        fn core_update_status(&self) -> Result<crate::core_update::CoreUpdateStatus, String> {
            self.core_update
                .lock()
                .map(|status| status.clone())
                .map_err(|_| "Service Core 更新状态锁异常".to_string())
        }

        fn set_core_update_status(
            &self,
            status: crate::core_update::CoreUpdateStatus,
        ) -> Result<crate::core_update::CoreUpdateStatus, String> {
            let mut current = self
                .core_update
                .lock()
                .map_err(|_| "Service Core 更新状态锁异常")?;
            *current = status.clone();
            Ok(status)
        }

        async fn running_core_version() -> Option<String> {
            mihomo::api_get("/version").await.ok().and_then(|value| {
                value
                    .get("version")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
        }

        async fn core_check(&self) -> Result<crate::core_update::CoreUpdateStatus, String> {
            let current = Self::running_core_version().await;
            self.set_core_update_status(crate::core_update::CoreUpdateStatus {
                current_version: current.clone(),
                available_version: None,
                asset_name: None,
                phase: crate::core_update::CoreUpdatePhase::Checking,
                error: None,
            })?;
            let result = crate::core_update::latest_release(current.as_deref()).await;
            match result {
                Ok(Some(release)) => {
                    self.set_core_update_status(crate::core_update::CoreUpdateStatus {
                        current_version: current,
                        available_version: Some(release.version.to_string()),
                        asset_name: Some(release.asset_name),
                        phase: crate::core_update::CoreUpdatePhase::Available,
                        error: None,
                    })
                }
                Ok(None) => self.set_core_update_status(crate::core_update::CoreUpdateStatus {
                    current_version: current,
                    available_version: None,
                    asset_name: None,
                    phase: crate::core_update::CoreUpdatePhase::Idle,
                    error: None,
                }),
                Err(error) => self.set_core_update_status(crate::core_update::CoreUpdateStatus {
                    current_version: current,
                    available_version: None,
                    asset_name: None,
                    phase: crate::core_update::CoreUpdatePhase::Error,
                    error: Some(error),
                }),
            }
        }

        async fn core_install(&self) -> Result<crate::core_update::CoreUpdateStatus, String> {
            let _update = self.core_update_transition.lock().await;
            let result = self.core_install_inner().await;
            if let Err(error) = &result {
                let mut status = self.core_update_status().unwrap_or_default();
                status.current_version = Self::running_core_version()
                    .await
                    .or(status.current_version);
                status.phase = crate::core_update::CoreUpdatePhase::Error;
                status.error = Some(error.clone());
                let _ = self.set_core_update_status(status);
            }
            result
        }

        async fn core_install_inner(&self) -> Result<crate::core_update::CoreUpdateStatus, String> {
            let current = Self::running_core_version().await;
            self.set_core_update_status(crate::core_update::CoreUpdateStatus {
                current_version: current.clone(),
                available_version: None,
                asset_name: None,
                phase: crate::core_update::CoreUpdatePhase::Checking,
                error: None,
            })?;
            let release = match crate::core_update::latest_release(current.as_deref()).await {
                Ok(Some(release)) => release,
                Ok(None) => {
                    return self.set_core_update_status(crate::core_update::CoreUpdateStatus {
                        current_version: current,
                        ..crate::core_update::CoreUpdateStatus::default()
                    })
                }
                Err(error) => {
                    let _ = self.set_core_update_status(crate::core_update::CoreUpdateStatus {
                        current_version: current,
                        phase: crate::core_update::CoreUpdatePhase::Error,
                        error: Some(error.clone()),
                        ..crate::core_update::CoreUpdateStatus::default()
                    });
                    return Err(error);
                }
            };
            self.set_core_update_status(crate::core_update::CoreUpdateStatus {
                current_version: current.clone(),
                available_version: Some(release.version.to_string()),
                asset_name: Some(release.asset_name.clone()),
                phase: crate::core_update::CoreUpdatePhase::Downloading,
                error: None,
            })?;
            let staging_dir = self.data_dir.join("updates").join("core");
            let staged = match crate::core_update::download_to_staging(&release, &staging_dir).await
            {
                Ok(path) => path,
                Err(error) => {
                    let _ = self.set_core_update_status(crate::core_update::CoreUpdateStatus {
                        current_version: current,
                        available_version: Some(release.version.to_string()),
                        asset_name: Some(release.asset_name),
                        phase: crate::core_update::CoreUpdatePhase::Error,
                        error: Some(error.clone()),
                    });
                    return Err(error);
                }
            };
            self.set_core_update_status(crate::core_update::CoreUpdateStatus {
                current_version: current.clone(),
                available_version: Some(release.version.to_string()),
                asset_name: Some(release.asset_name.clone()),
                phase: crate::core_update::CoreUpdatePhase::Staging,
                error: None,
            })?;
            self.set_core_update_status(crate::core_update::CoreUpdateStatus {
                current_version: current.clone(),
                available_version: Some(release.version.to_string()),
                asset_name: Some(release.asset_name.clone()),
                phase: crate::core_update::CoreUpdatePhase::Verifying,
                error: None,
            })?;
            self.default_config()?;
            if let Err(error) =
                crate::core_update::validate_config(&staged, &self.data_dir, &self.config_path())
            {
                let _ = self.set_core_update_status(crate::core_update::CoreUpdateStatus {
                    current_version: current,
                    available_version: Some(release.version.to_string()),
                    asset_name: Some(release.asset_name),
                    phase: crate::core_update::CoreUpdatePhase::Error,
                    error: Some(error.clone()),
                });
                return Err(error);
            }

            let tun_before = self.tun_data()?;
            let tun_was_running = tun_before.status == "running";
            let tun_profile_id = tun_before.profile_id.clone();
            self.refresh_child()?;
            let was_running = self.owns_core()?;
            if self.has_tun_recovery() {
                self.disable_tun().await?;
            }
            if was_running {
                self.stop().await?;
            }
            self.set_core_update_status(crate::core_update::CoreUpdateStatus {
                current_version: current.clone(),
                available_version: Some(release.version.to_string()),
                asset_name: Some(release.asset_name.clone()),
                phase: crate::core_update::CoreUpdatePhase::Installing,
                error: None,
            })?;
            let backup = match crate::core_update::replace_core(&self.mihomo_path, &staged) {
                Ok(backup) => backup,
                Err(error) => {
                    let _ = self.set_core_update_status(crate::core_update::CoreUpdateStatus {
                        current_version: current,
                        available_version: Some(release.version.to_string()),
                        asset_name: Some(release.asset_name),
                        phase: crate::core_update::CoreUpdatePhase::Error,
                        error: Some(error.clone()),
                    });
                    return Err(error);
                }
            };
            self.set_core_update_status(crate::core_update::CoreUpdateStatus {
                current_version: current.clone(),
                available_version: Some(release.version.to_string()),
                asset_name: Some(release.asset_name.clone()),
                phase: crate::core_update::CoreUpdatePhase::Restarting,
                error: None,
            })?;

            let health = async {
                self.start().await?;
                let running = Self::running_core_version().await;
                let Some(running) = running else {
                    return Err("新 Mihomo Core 未返回 /version，健康检查失败".to_string());
                };
                let running_version = crate::update::parse_version(&running)?;
                if running_version != release.version {
                    return Err(format!(
                        "新 Mihomo Core 版本不匹配：期望 {}，实际 {}",
                        release.version, running
                    ));
                }
                if tun_was_running {
                    let profile_id = tun_profile_id
                        .clone()
                        .ok_or_else(|| "Core 更新后缺少 TUN Profile，拒绝恢复 TUN".to_string())?;
                    let tun = self.tun_set(true, Some(profile_id), false).await?;
                    if tun.status != "running" {
                        return Err(format!(
                            "新 Mihomo Core 健康但 TUN 未恢复 Running（当前 {}）",
                            tun.status
                        ));
                    }
                }
                Ok::<(), String>(())
            }
            .await;
            if let Err(error) = health {
                let _ = self.stop().await;
                let rollback = crate::core_update::rollback_core(&backup);
                let restart = if was_running {
                    match self.start().await {
                        Ok(_) if tun_was_running => {
                            let profile_id = tun_profile_id.clone().ok_or_else(|| {
                                "回滚后缺少 TUN Profile，未恢复旧 TUN".to_string()
                            })?;
                            self.tun_set(true, Some(profile_id), false)
                                .await
                                .map(|_| ())
                                .map_err(|restore_error| {
                                    format!("恢复旧 TUN 失败：{restore_error}")
                                })
                        }
                        Ok(_) => Ok(()),
                        Err(restart_error) => {
                            Err(format!("恢复旧 Mihomo Core 失败：{restart_error}"))
                        }
                    }
                } else {
                    Ok(())
                };
                let combined = match (rollback, restart) {
                    (Ok(()), Ok(())) => format!("Core 健康检查失败，已回滚：{error}"),
                    (rollback, restart) => format!(
                        "Core 健康检查失败：{error}；回滚：{}；恢复旧 Core：{}",
                        rollback.err().unwrap_or_else(|| "成功".to_string()),
                        restart.err().unwrap_or_else(|| "成功".to_string())
                    ),
                };
                let _ = self.set_core_update_status(crate::core_update::CoreUpdateStatus {
                    current_version: current,
                    available_version: Some(release.version.to_string()),
                    asset_name: Some(release.asset_name),
                    phase: crate::core_update::CoreUpdatePhase::Error,
                    error: Some(combined.clone()),
                });
                return Err(combined);
            }
            crate::core_update::finalize_core(&backup)?;
            let _ = config::remove_file(&staged, "清理 Core staging 文件");
            let final_version = Self::running_core_version().await;
            self.set_core_update_status(crate::core_update::CoreUpdateStatus {
                current_version: final_version,
                available_version: None,
                asset_name: None,
                phase: crate::core_update::CoreUpdatePhase::Completed,
                error: None,
            })
        }

        async fn start(&self) -> Result<crate::mihomo::CoreStatus, String> {
            let _transition = self.core_transition.lock().await;
            self.reset_core_recovery()?;
            self.clear_core_exit_pending()?;
            match self.start_inner().await {
                Ok(status) => {
                    self.observe_core_ready()?;
                    self.restore_pending_tun_locked().await?;
                    Ok(status)
                }
                Err(error) => {
                    self.record_core_recovery_failure(&error)?;
                    Err(error)
                }
            }
        }

        async fn automatic_start_locked(
            &self,
        ) -> Result<Option<crate::mihomo::CoreStatus>, String> {
            if !self.recovery_can_attempt(recovery_now())? {
                return Ok(None);
            }
            match self.start_inner().await {
                Ok(status) => {
                    self.observe_core_ready()?;
                    if let Err(error) = self.restore_pending_tun_locked().await {
                        let _ = self.set_core_recovery_message(Some(format!(
                            "Mihomo 已恢复，但 TUN 自动恢复失败：{error}"
                        )));
                        return Err(error);
                    }
                    Ok(Some(status))
                }
                Err(error) => {
                    self.record_core_recovery_failure(&error)?;
                    Err(error)
                }
            }
        }

        async fn start_inner(&self) -> Result<crate::mihomo::CoreStatus, String> {
            self.set_desired_core_running(true)?;
            if let Some(managed_pid) = self.managed_core_pid()? {
                let (mixed_port, _) = self.runtime_config()?;
                let mixed_port =
                    config::actual_runtime_mixed_port_at(&self.data_dir).unwrap_or(mixed_port);
                if mihomo::core_ready_for_pid(mixed_port, managed_pid).await? {
                    self.set_core_recovery_message(None)?;
                    return self.core_status().await;
                }
                self.stop_owned_child_for_retry()?;
            }
            if mihomo::is_running().await {
                // A GUI-owned MioProxy Core can outlive a temporary Service IPC
                // outage. Treat it as an ownership boundary, not a Service
                // failure, and never race it with another child.
                self.set_desired_core_running(false)?;
                self.set_core_recovery_message(None)?;
                return self.core_status().await;
            }
            if self.has_tun_recovery() {
                self.disable_tun().await?;
            }
            if !self.has_tun_recovery() {
                let _ = config::restore_active_profile_config_at(&self.data_dir)?;
            }
            let _ = self.refresh_outbound_compatibility();
            self.default_config()?;
            if !self.mihomo_path.exists() {
                return Err(format!(
                    "找不到 Service 使用的 Mihomo：{}",
                    self.mihomo_path.display()
                ));
            }
            let config_path = self.config_path();
            let bundled_geodata_dirs = crate::geodata::bundled_search_dirs(&self.mihomo_path);
            crate::geodata::ensure_for_candidate(
                &self.data_dir,
                &config_path,
                &bundled_geodata_dirs,
            )
            .await
            .map_err(|error| {
                format!(
                    "Mihomo 启动前 geodata 准备失败（{}）：{error}",
                    crate::geodata::validation_category(&error)
                )
            })?;
            if let Err(error) =
                crate::core_update::validate_config(&self.mihomo_path, &self.data_dir, &config_path)
            {
                if crate::geodata::is_geodata_error(&error) {
                    let replacement = crate::geodata::replace_after_validation_failure(
                        &self.data_dir,
                        &config_path,
                        &bundled_geodata_dirs,
                    )
                    .await
                    .map_err(|repair| {
                        format!(
                            "Mihomo 启动前配置校验失败（{}），geodata 修复失败：{repair}",
                            crate::geodata::validation_category(&error)
                        )
                    })?;
                    if let Err(retry_error) = crate::core_update::validate_config(
                        &self.mihomo_path,
                        &self.data_dir,
                        &config_path,
                    ) {
                        let restore_error = replacement.restore().err();
                        return Err(match restore_error {
                            Some(restore_error) => format!(
                                "Mihomo 启动前配置校验失败（{}），已保留当前 Runtime；geodata 回滚失败：{restore_error}；重试错误：{retry_error}",
                                crate::geodata::validation_category(&retry_error)
                            ),
                            None => format!(
                                "Mihomo 启动前配置校验失败（{}），已保留当前 Runtime：{retry_error}",
                                crate::geodata::validation_category(&retry_error)
                            ),
                        });
                    }
                } else {
                    return Err(format!(
                        "Mihomo 启动前配置校验失败（{}）：{error}",
                        crate::geodata::validation_category(&error)
                    ));
                }
            }
            let mut minimum_mixed_port = None;
            let mut last_error = "Mihomo 未通过启动健康检查".to_string();
            for _ in 0..CORE_START_MAX_CANDIDATES {
                config::clear_actual_runtime_mixed_port_at(&self.data_dir)?;
                let mixed_port = config::prepare_runtime_resources_from_at(
                    &self.config_path(),
                    mihomo::CONTROLLER,
                    mihomo::secret(),
                    minimum_mixed_port,
                )?;
                let mut command = Command::new(&self.mihomo_path);
                command
                    .args(["-d", config::mihomo_path_string(&self.data_dir).as_str()])
                    .args([
                        "-f",
                        config::mihomo_path_string(&self.config_path()).as_str(),
                    ])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                let mut child = command
                    .spawn()
                    .map_err(|e| format!("Service 启动 Mihomo 失败：{e}"))?;
                let managed_pid = child.id();
                if let Err(error) = self.job.assign(managed_pid) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error);
                }
                if let Err(error) = persist_service_core_owner(&self.data_dir, managed_pid) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("保存 Service Core owner 失败：{error}"));
                }
                let _ = self.set_core_recovery_message(None);
                match self.child.lock() {
                    Ok(mut current) => *current = Some(child),
                    Err(_) => {
                        let _ = clear_service_core_owner_if_matches(&self.data_dir, managed_pid);
                        let mut child = child;
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err("Service Mihomo 状态锁异常".to_string());
                    }
                }
                let mut runtime_state_error = None;
                for _ in 0..50 {
                    if mihomo::core_ready_for_pid(mixed_port, managed_pid).await? {
                        match config::commit_actual_runtime_mixed_port_at(
                            &self.data_dir,
                            mixed_port,
                        ) {
                            Ok(()) => return self.core_status().await,
                            Err(error) => {
                                runtime_state_error = Some(format!(
                                    "保存 MioProxy mixed-port {mixed_port} 失败：{error}"
                                ));
                                break;
                            }
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                self.stop_owned_child_for_retry()?;
                last_error = runtime_state_error
                    .unwrap_or_else(|| format!("MioProxy mixed-port {mixed_port} 未通过健康检查"));
                minimum_mixed_port = mixed_port.checked_add(1);
            }
            let _ = self.set_core_recovery_message(Some(last_error.clone()));
            Err(last_error)
        }

        async fn ensure_desired_core_ready(&self) {
            let _transition = self.core_transition.lock().await;
            if !self.desired_core_running().unwrap_or(false) {
                return;
            }
            if self.owned_core_ready().await.unwrap_or(false) {
                let _ = self.observe_core_ready();
                return;
            }
            if self.managed_core_pid().ok().flatten().is_none() && mihomo::is_running().await {
                let _ = self.set_desired_core_running(false);
                let _ = self.reset_core_recovery();
                return;
            }
            if let Err(error) = self.automatic_start_locked().await {
                eprintln!("Service Mihomo 自动恢复失败：{error}");
            }
        }

        async fn stop(&self) -> Result<crate::mihomo::CoreStatus, String> {
            let _transition = self.core_transition.lock().await;
            self.reset_core_recovery()?;
            self.clear_core_exit_pending()?;
            self.clear_pending_tun_restore()?;
            self.stop_inner().await
        }

        async fn stop_inner(&self) -> Result<crate::mihomo::CoreStatus, String> {
            self.set_desired_core_running(false)?;
            self.set_core_recovery_message(None)?;
            let owns_core = self.owns_core()?;
            if self.has_tun_recovery() {
                self.disable_tun().await?;
            }
            if owns_core {
                if let Some(mut child) = self
                    .child
                    .lock()
                    .map_err(|_| "Service Mihomo 状态锁异常")?
                    .take()
                {
                    let managed_pid = child.id();
                    child
                        .kill()
                        .map_err(|e| format!("Service 停止 Mihomo 失败：{e}"))?;
                    let _ = child.wait();
                    clear_service_core_owner_if_matches(&self.data_dir, managed_pid)?;
                }
            } else if mihomo::is_running().await {
                return Err("当前 Mihomo 不是 MioProxy Service 管理，拒绝停止外部进程".to_string());
            }
            self.core_status().await
        }

        async fn reload(&self) -> Result<Value, String> {
            if !self.owns_core()? {
                return Err("Service 当前没有拥有 Mihomo，拒绝重载".to_string());
            }
            mihomo::api_put(
                "/configs?force=true",
                json!({ "path": config::mihomo_path_string(&self.config_path()) }),
            )
            .await
        }

        async fn apply_profile(
            &self,
            profile_id: &str,
        ) -> Result<crate::config::ConfigApplyResult, String> {
            let _registry = crate::profiles::lock_registry().await;
            if !self.owned_core_ready().await? {
                return Err("Service Core 尚未 Ready，拒绝应用配置".to_string());
            }
            let built = config::build_value_at(&self.data_dir, profile_id)?;
            let profile_name = built.profile.name.clone();
            let override_active = built.override_active;
            let expected_tun = config::tun_enabled_in_value(&built.value);
            let yaml = serde_yaml::to_string(&built.value).map_err(|e| e.to_string())?;
            let candidate = config::candidate_path_at(&self.data_dir);
            let stable = self.config_path();
            let previous_stable = config::read_text_file_at(&stable, "读取当前 Runtime 配置")?
                .ok_or_else(|| "当前 Runtime 配置不存在，拒绝无回滚点应用 Profile".to_string())?;
            write_atomic(&candidate, yaml.as_bytes())?;
            let result = config::load_candidate_with_geodata(
                &self.data_dir,
                &candidate,
                &crate::geodata::bundled_search_dirs(&self.mihomo_path),
            )
            .await;
            if let Err(error) = result {
                let _ = config::remove_file(&candidate, "清理候选配置");
                return Err(format!(
                    "Mihomo 配置校验失败（{}）：{error}；已保留当前配置",
                    crate::geodata::validation_category(&error)
                ));
            }
            let finish = async {
                config::verify_controller_runtime(Some(expected_tun)).await?;
                config::commit_runtime_state_at(
                    &self.data_dir,
                    profile_id,
                    &built.base_value,
                    &yaml,
                )
            }
            .await;
            if let Err(error) = finish {
                let stable_restore = write_atomic(&stable, previous_stable.as_bytes());
                let controller_restore = if stable_restore.is_ok() {
                    mihomo::api_put(
                        "/configs?force=true",
                        json!({ "path": config::mihomo_path_string(&stable) }),
                    )
                    .await
                    .map(|_| ())
                } else {
                    Err("旧 Runtime 配置文件恢复失败".to_string())
                };
                let _ = config::remove_file(&candidate, "清理候选配置");
                return Err(match (stable_restore, controller_restore) {
                    (Ok(()), Ok(())) => format!("应用 Profile 事务失败，已回滚：{error}"),
                    (stable_result, controller_result) => format!(
                        "应用 Profile 事务失败：{error}；Runtime 回滚：{}；Controller 回滚：{}",
                        stable_result.err().unwrap_or_else(|| "成功".to_string()),
                        controller_result
                            .err()
                            .unwrap_or_else(|| "成功".to_string())
                    ),
                });
            }
            let _ = config::remove_file(&candidate, "清理候选配置");
            Ok(crate::config::ConfigApplyResult {
                profile_id: profile_id.to_string(),
                profile_name,
                path: config::mihomo_path_string(&stable),
                controller_validated: true,
                override_active,
            })
        }

        async fn apply_active_runtime(&self, expected_tun: bool) -> Result<(), String> {
            if !self.owned_core_ready().await? {
                return Err("Service Core 尚未 Ready，拒绝重载 Runtime 配置".to_string());
            }
            let value = config::active_runtime_value_at(&self.data_dir)
                .map_err(|error| format!("本地 Runtime 生成/校验阶段失败：{error}"))?
                .ok_or_else(|| {
                    "本地 Runtime 生成/校验阶段失败：没有活动 Runtime 基线".to_string()
                })?;
            if config::tun_enabled_in_value(&value) != expected_tun {
                return Err(format!(
                    "本地 Runtime 生成/校验阶段失败：TUN 状态不一致，期望 {expected_tun}"
                ));
            }
            let yaml = serde_yaml::to_string(&value)
                .map_err(|error| format!("本地 Runtime YAML 生成阶段失败：{error}"))?;
            let candidate = config::candidate_path_at(&self.data_dir);
            let stable = self.config_path();
            let previous_stable = config::read_text_file_at(&stable, "读取当前 Runtime 配置")?
                .ok_or_else(|| "当前 Runtime 配置不存在，拒绝无回滚点重载".to_string())?;
            write_atomic(&candidate, yaml.as_bytes())
                .map_err(|error| format!("保存 Runtime 候选配置失败：{error}"))?;
            let diagnostics_note =
                |stage: &str, error: &str| match config::preserve_failed_runtime_diagnostics_at(
                    &self.data_dir,
                    &yaml,
                    stage,
                    error,
                ) {
                    Ok(()) => "；Runtime 诊断已保存".to_string(),
                    Err(_) => "；Runtime 诊断保存失败".to_string(),
                };
            let load = match config::load_candidate_with_geodata(
                &self.data_dir,
                &candidate,
                &crate::geodata::bundled_search_dirs(&self.mihomo_path),
            )
            .await
            {
                Ok(_) => match config::verify_controller_runtime(Some(expected_tun)).await {
                    Ok(()) => write_atomic(&stable, yaml.as_bytes())
                        .map_err(|error| format!("提交稳定 Runtime 阶段失败：{error}")),
                    Err(error) => {
                        let note = diagnostics_note("read-back-verification", &error);
                        Err(format!("Controller 回读验证阶段失败：{error}{note}"))
                    }
                },
                Err(error) => {
                    let note = diagnostics_note(controller_reload_diagnostic_stage(&error), &error);
                    Err(format!("Mihomo /configs 重载阶段失败：{error}{note}"))
                }
            };
            if let Err(error) = load {
                let stable_restore = write_atomic(&stable, previous_stable.as_bytes());
                let controller_restore = if stable_restore.is_ok() {
                    mihomo::api_put(
                        "/configs?force=true",
                        json!({ "path": config::mihomo_path_string(&stable) }),
                    )
                    .await
                    .map(|_| ())
                } else {
                    Err("旧 Runtime 配置文件恢复失败".to_string())
                };
                let _ = config::remove_file(&candidate, "清理候选配置");
                return Err(match (stable_restore, controller_restore) {
                    (Ok(()), Ok(())) => format!("Runtime 重载失败，已回滚：{error}"),
                    (stable_result, controller_result) => format!(
                        "Runtime 重载失败：{error}；文件回滚：{}；Controller 回滚：{}",
                        stable_result.err().unwrap_or_else(|| "成功".to_string()),
                        controller_result
                            .err()
                            .unwrap_or_else(|| "成功".to_string())
                    ),
                });
            }
            let _ = config::remove_file(&candidate, "清理候选配置");
            if !self.owned_core_ready().await? {
                return Err("Runtime 重载后 Service Core 未保持 Ready".to_string());
            }
            Ok(())
        }

        async fn enable_tun(
            &self,
            profile_id: String,
            _system_proxy_enabled: bool,
        ) -> Result<ServiceTunData, String> {
            let _transition = self.tun_transition.lock().await;
            if !is_admin() {
                return Err("MioProxy Service 没有管理员权限".to_string());
            }
            if let Some(message) = crate::tun::foreign_tun_conflict()? {
                return Err(message);
            }
            if profile_id.trim().is_empty() {
                return Err("启用 TUN 需要已下载的 Profile".to_string());
            }
            let current_status = self
                .tun
                .lock()
                .map_err(|_| "Service TUN 状态锁异常")?
                .status;
            if current_status == crate::tun::TunStatus::Running {
                if self.owned_core_ready().await?
                    && config::verify_controller_runtime(Some(true)).await.is_ok()
                {
                    return self.tun_data();
                }
                self.disable_tun_inner().await?;
                return Err(
                    "Service Mihomo 已退出，TUN 原始配置已恢复；请等待 Core 自动恢复后重试"
                        .to_string(),
                );
            }
            if !self.owned_core_ready().await? {
                return Err("Service Core 尚未 Ready".to_string());
            }
            if matches!(
                current_status,
                crate::tun::TunStatus::Starting | crate::tun::TunStatus::Stopping
            ) {
                return Err("Service TUN 正在切换，请稍候".to_string());
            }
            if current_status == crate::tun::TunStatus::Error && self.has_tun_recovery() {
                return Err("Service TUN 仍有待恢复状态，请先执行停止/恢复".to_string());
            }
            if config::active_runtime_value_at(&self.data_dir)?.is_none() {
                return Err("启用 TUN 前需要先应用一个 Profile".to_string());
            }
            if mihomo::api_get("/configs")
                .await
                .ok()
                .and_then(|value| value.get("tun").cloned())
                .and_then(|value| value.get("enable").and_then(Value::as_bool))
                == Some(true)
            {
                return Err("Mihomo 已经启用了 TUN，请先恢复后再开始托管会话".to_string());
            }
            let snapshot = crate::tun::capture_snapshot().await.ok();
            {
                let mut tun = self.tun.lock().map_err(|_| "Service TUN 状态锁异常")?;
                tun.status = crate::tun::TunStatus::Starting;
                tun.message = None;
                tun.profile_id = Some(profile_id.clone());
                tun.previous_override = None;
                tun.snapshot = snapshot;
            }
            if let Err(error) = self.write_tun_persisted() {
                if let Ok(mut tun) = self.tun.lock() {
                    *tun = ServiceTunState::default();
                }
                return Err(format!("保存 Service TUN 恢复状态失败：{error}"));
            }
            if let Err(error) = config::set_tun_enabled_at(&self.data_dir, true) {
                return self
                    .rollback_tun(&profile_id, format!("写入 TUN 配置失败：{error}"))
                    .await;
            }
            if let Err(error) = self.apply_active_runtime(true).await {
                return self
                    .rollback_tun(&profile_id, format!("加载 TUN 配置失败：{error}"))
                    .await;
            }
            if let Err(error) = crate::tun::wait_for_tun_ready().await {
                return self
                    .rollback_tun(&profile_id, format!("TUN 网卡启动失败：{error}"))
                    .await;
            }
            let baseline = crate::tun::capture_snapshot().await.ok();
            {
                let mut tun = self.tun.lock().map_err(|_| "Service TUN 状态锁异常")?;
                tun.status = crate::tun::TunStatus::Running;
                tun.message = None;
                tun.snapshot = baseline;
            }
            if let Err(error) = self.write_tun_persisted() {
                return self
                    .rollback_tun(
                        &profile_id,
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
            reason: String,
        ) -> Result<ServiceTunData, String> {
            let runtime_restore = config::set_tun_enabled_at(&self.data_dir, false);
            let recovery =
                if runtime_restore.is_ok() && self.owned_core_ready().await.unwrap_or(false) {
                    self.apply_active_runtime(false).await
                } else if runtime_restore.is_ok() {
                    config::restore_active_runtime_config_at(&self.data_dir).map(|_| ())
                } else {
                    runtime_restore
                };
            let recovery = recovery.and_then(|_| self.clear_tun_persisted());
            match recovery {
                Ok(()) => {
                    let mut tun = self.tun.lock().map_err(|_| "Service TUN 状态锁异常")?;
                    *tun = ServiceTunState {
                        status: crate::tun::TunStatus::Disabled,
                        message: Some(format!("{reason}；已恢复原始配置")),
                        ..ServiceTunState::default()
                    };
                    Err(reason)
                }
                Err(error) => {
                    let message = format!("{reason}；TUN 回滚也失败：{error}");
                    let mut tun = self.tun.lock().map_err(|_| "Service TUN 状态锁异常")?;
                    tun.status = crate::tun::TunStatus::Error;
                    tun.message = Some(message.clone());
                    tun.profile_id = Some(profile_id.to_string());
                    Err(message)
                }
            }
        }

        async fn disable_tun(&self) -> Result<ServiceTunData, String> {
            let _transition = self.tun_transition.lock().await;
            self.disable_tun_inner().await
        }

        async fn disable_tun_inner(&self) -> Result<ServiceTunData, String> {
            let persisted = self.read_tun_persisted()?;
            let (previous, profile_id, has_session) = {
                let in_memory = self.tun.lock().map_err(|_| "Service TUN 状态锁异常")?;
                let previous = normalize_previous_override(
                    persisted
                        .as_ref()
                        .map(|state| state.previous_override.clone())
                        .unwrap_or_else(|| in_memory.previous_override.clone()),
                );
                let profile_id = persisted
                    .as_ref()
                    .map(|state| state.profile_id.clone())
                    .or_else(|| in_memory.profile_id.clone());
                (
                    previous,
                    profile_id,
                    persisted.is_some() || in_memory.profile_id.is_some(),
                )
            };
            let restore_path = tun_runtime_restore_path(previous.as_deref());
            if !has_session {
                config::set_tun_enabled_at(&self.data_dir, false)?;
                if self.owned_core_ready().await? {
                    if config::active_runtime_value_at(&self.data_dir)?.is_some() {
                        self.apply_active_runtime(false).await?;
                    }
                } else {
                    let _ = config::restore_active_runtime_config_at(&self.data_dir)?;
                }
                if let Ok(mut tun) = self.tun.lock() {
                    *tun = ServiceTunState::default();
                }
                return self.tun_data();
            }
            if self.managed_core_pid()?.is_none() && mihomo::is_running().await {
                return Err(
                    "检测到非 Service 所有的 Mihomo，拒绝由 Service 修改其 TUN 状态".to_string(),
                );
            }
            {
                let mut tun = self.tun.lock().map_err(|_| "Service TUN 状态锁异常")?;
                tun.status = crate::tun::TunStatus::Stopping;
                tun.message = None;
            }
            if let TunRuntimeRestorePath::LegacyOverride(previous) = restore_path {
                if let Err(error) = config::restore_override_content_at(&self.data_dir, previous) {
                    let message = format!("迁移旧 TUN 会话的 Override 快照失败：{error}");
                    if let Ok(mut tun) = self.tun.lock() {
                        tun.status = crate::tun::TunStatus::Error;
                        tun.message = Some(message.clone());
                    }
                    return Err(message);
                }
            }
            if let Err(error) = config::set_tun_enabled_at(&self.data_dir, false) {
                let message = format!("写入 TUN 停止状态失败：{error}");
                if let Ok(mut tun) = self.tun.lock() {
                    tun.status = crate::tun::TunStatus::Error;
                    tun.message = Some(message.clone());
                }
                return Err(message);
            }
            let core_ready = self.owned_core_ready().await?;
            if self.managed_core_pid()?.is_some() && !core_ready {
                let message = "TUN 关闭失败：Service Core 未处于 Ready".to_string();
                if let Ok(mut tun) = self.tun.lock() {
                    tun.status = crate::tun::TunStatus::Error;
                    tun.message = Some(message.clone());
                }
                return Err(message);
            }
            let restore = match (restore_path, core_ready) {
                (TunRuntimeRestorePath::LegacyOverride(_), true) => {
                    match profile_id.as_deref() {
                        Some(profile_id) => {
                            // Legacy sessions wrote TUN into local-override.yaml. Rebuild
                            // their active base exactly once after restoring that snapshot.
                            self.apply_profile(profile_id).await.map(|_| ())
                        }
                        None => Err("旧 TUN 会话缺少 Profile".to_string()),
                    }
                }
                (TunRuntimeRestorePath::LegacyOverride(_), false) => match profile_id.as_deref() {
                    Some(profile_id) => (|| {
                        let built = config::build_value_at(&self.data_dir, profile_id)?;
                        let yaml = serde_yaml::to_string(&built.value)
                            .map_err(|error| format!("生成旧 TUN 恢复配置失败：{error}"))?;
                        config::commit_runtime_state_at(
                            &self.data_dir,
                            profile_id,
                            &built.base_value,
                            &yaml,
                        )
                    })(),
                    None => Err("旧 TUN 会话缺少 Profile".to_string()),
                },
                (TunRuntimeRestorePath::ActiveRuntime, true) => {
                    self.apply_active_runtime(false).await
                }
                (TunRuntimeRestorePath::ActiveRuntime, false) => {
                    config::restore_active_runtime_config_at(&self.data_dir).map(|_| ())
                }
            };
            if let Err(error) = restore {
                let message = format!("TUN 关闭失败：{error}");
                if let Ok(mut tun) = self.tun.lock() {
                    tun.status = crate::tun::TunStatus::Error;
                    tun.message = Some(message.clone());
                }
                return Err(message);
            }
            if core_ready {
                if let Err(error) = config::verify_controller_runtime(Some(false)).await {
                    let message = format!("TUN 关闭失败：Controller 回读验证失败：{error}");
                    if let Ok(mut tun) = self.tun.lock() {
                        tun.status = crate::tun::TunStatus::Error;
                        tun.message = Some(message.clone());
                    }
                    return Err(message);
                }
                if !self.owned_core_ready().await? {
                    let message = "TUN 关闭失败：Service Core 未保持 Ready".to_string();
                    if let Ok(mut tun) = self.tun.lock() {
                        tun.status = crate::tun::TunStatus::Error;
                        tun.message = Some(message.clone());
                    }
                    return Err(message);
                }
            }
            if let Err(error) = self.clear_tun_persisted() {
                let message = format!("清理 Service TUN 恢复状态失败：{error}");
                if let Ok(mut tun) = self.tun.lock() {
                    tun.status = crate::tun::TunStatus::Error;
                    tun.message = Some(message.clone());
                }
                return Err(message);
            }
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
            let restore_path = tun_runtime_restore_path(persisted.previous_override.as_deref());
            let legacy_restore = match restore_path {
                TunRuntimeRestorePath::LegacyOverride(previous) => {
                    config::restore_override_content_at(&self.data_dir, previous).and_then(|_| {
                        config::set_tun_enabled_at(&self.data_dir, false)?;
                        let built = config::build_value_at(&self.data_dir, &persisted.profile_id)?;
                        let yaml = serde_yaml::to_string(&built.value)
                            .map_err(|error| format!("生成旧 TUN 恢复配置失败：{error}"))?;
                        config::commit_runtime_state_at(
                            &self.data_dir,
                            &persisted.profile_id,
                            &built.base_value,
                            &yaml,
                        )
                    })
                }
                TunRuntimeRestorePath::ActiveRuntime => {
                    config::set_tun_enabled_at(&self.data_dir, false).and_then(|_| {
                        config::restore_active_runtime_config_at(&self.data_dir).map(|_| ())
                    })
                }
            };
            let result = legacy_restore;
            match result {
                Ok(()) => {
                    self.clear_tun_persisted()?;
                    let mut tun = self.tun.lock().map_err(|_| "Service TUN 状态锁异常")?;
                    *tun = ServiceTunState {
                        status: crate::tun::TunStatus::Disabled,
                        message: Some("Service 上次异常退出，已恢复 TUN 原始配置".to_string()),
                        ..ServiceTunState::default()
                    };
                    Ok(tun.message.clone())
                }
                Err(error) => {
                    let mut tun = self.tun.lock().map_err(|_| "Service TUN 状态锁异常")?;
                    tun.status = crate::tun::TunStatus::Error;
                    tun.message = Some(format!("Service TUN 启动恢复失败：{error}"));
                    tun.previous_override =
                        normalize_previous_override(persisted.previous_override);
                    tun.profile_id = Some(persisted.profile_id);
                    tun.snapshot = persisted.snapshot;
                    Ok(tun.message.clone())
                }
            }
        }

        async fn status(&self) -> Result<ServiceStatusData, String> {
            let core = self.core_status().await?;
            let running = core.running;
            let controller_ready = mihomo::is_running().await;
            self.refresh_child()?;
            let owns_core = self
                .child
                .lock()
                .map_err(|_| "Service Mihomo 状态锁异常")?
                .is_some();
            let tun = self.tun_data()?;
            Ok(ServiceStatusData {
                core,
                core_update: self.core_update_status()?,
                running,
                owns_core,
                ownership_conflict: controller_ready && !owns_core,
                admin: is_admin(),
                tun_status: tun.status,
                tun_message: tun.message,
                tun_profile_id: tun.profile_id,
                tun_snapshot: tun.snapshot,
                desired_core_running: self.desired_core_running()?,
                core_recovery_message: self.core_recovery_message()?,
            })
        }

        async fn handle(&self, command: ServiceCommand) -> Result<Value, String> {
            match command {
                ServiceCommand::Status => {
                    Ok(serde_json::to_value(self.status().await?).map_err(|e| e.to_string())?)
                }
                ServiceCommand::PortDiagnostics { port } => Ok(serde_json::to_value(
                    config::windows_tcp_listener_diagnostics(port, self.managed_core_pid()?)?,
                )
                .map_err(|e| e.to_string())?),
                ServiceCommand::Start => Ok(serde_json::to_value::<crate::mihomo::CoreStatus>(
                    self.start().await?,
                )
                .map_err(|e| e.to_string())?),
                ServiceCommand::Stop => Ok(serde_json::to_value::<crate::mihomo::CoreStatus>(
                    self.stop().await?,
                )
                .map_err(|e| e.to_string())?),
                ServiceCommand::Reload => self.reload().await,
                ServiceCommand::CoreCheck => Ok(
                    serde_json::to_value(self.core_check().await?).map_err(|e| e.to_string())?
                ),
                ServiceCommand::CoreInstall => {
                    Ok(serde_json::to_value(self.core_install().await?)
                        .map_err(|e| e.to_string())?)
                }
                ServiceCommand::ApplyProfile { profile_id } => {
                    let _transition = self.tun_transition.lock().await;
                    self.ensure_profile_apply_allowed()?;
                    let result = self.apply_profile(&profile_id).await?;
                    if let Err(error) = self.rebind_tun_profile(&profile_id) {
                        eprintln!("{error}");
                    }
                    Ok(serde_json::to_value(result).map_err(|e| e.to_string())?)
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
                #[cfg(feature = "validation-fault-injection")]
                ServiceCommand::ValidationCrashManagedCore => {
                    self.validation_crash_managed_core().await
                }
            }
        }

        async fn shutdown(&self) -> Result<(), String> {
            let _core_transition = self.core_transition.lock().await;
            let mut errors = Vec::new();
            // SCM shutdown/restart (including an application upgrade) must not
            // turn a Ready Core into a persisted user stop request.
            let _ = self.set_core_recovery_message(None);
            if self.has_tun_recovery() {
                if let Err(error) = self.disable_tun().await {
                    errors.push(format!("Service TUN 清理失败：{error}"));
                }
            }
            if let Some(mut child) = self
                .child
                .lock()
                .map_err(|_| "Service Mihomo 状态锁异常")?
                .take()
            {
                let managed_pid = child.id();
                if let Err(error) = child.kill() {
                    errors.push(format!("Service 停止 Mihomo 失败：{error}"));
                }
                if let Err(error) = child.wait() {
                    errors.push(format!("等待 Service Mihomo 退出失败：{error}"));
                }
                if let Err(error) = clear_service_core_owner_if_matches(&self.data_dir, managed_pid)
                {
                    errors.push(format!("清理 Service Core owner 失败：{error}"));
                }
            }
            if errors.is_empty() {
                Ok(())
            } else {
                Err(errors.join("；"))
            }
        }

        fn remember_tun_restore(&self, profile_id: Option<String>) -> Result<(), String> {
            if let Some(profile_id) = profile_id {
                *self
                    .pending_tun_profile
                    .lock()
                    .map_err(|_| "Service TUN 恢复 Profile 锁异常")? = Some(profile_id);
            }
            Ok(())
        }

        fn pending_tun_restore(&self) -> Result<Option<String>, String> {
            self.pending_tun_profile
                .lock()
                .map(|profile_id| profile_id.clone())
                .map_err(|_| "Service TUN 恢复 Profile 锁异常".to_string())
        }

        fn clear_pending_tun_restore(&self) -> Result<(), String> {
            *self
                .pending_tun_profile
                .lock()
                .map_err(|_| "Service TUN 恢复 Profile 锁异常")? = None;
            Ok(())
        }

        async fn restore_pending_tun_locked(&self) -> Result<(), String> {
            let Some(profile_id) = self.pending_tun_restore()? else {
                return Ok(());
            };
            let tun = self.tun_set(true, Some(profile_id), false).await?;
            if tun.status != "running" {
                return Err(format!(
                    "受管 Mihomo 已恢复，但 TUN 未恢复 Running（当前 {}）",
                    tun.status
                ));
            }
            self.clear_pending_tun_restore()
        }

        async fn disable_tun_for_core_recovery_locked(
            &self,
            profile_id: Option<String>,
        ) -> Result<(), String> {
            self.remember_tun_restore(profile_id)?;
            if self.has_tun_recovery() {
                let _transition = self.tun_transition.lock().await;
                self.disable_tun_inner().await?;
            }
            Ok(())
        }

        async fn monitor_core_once_locked(&self) {
            if !self.desired_core_running().unwrap_or(false) {
                return;
            }

            let had_child = self
                .child
                .lock()
                .map(|child| child.is_some())
                .unwrap_or(false);
            if let Err(error) = self.refresh_child() {
                let _ = self.set_core_recovery_message(Some(error));
                return;
            }
            let ready_probe = self.owned_core_ready().await;
            let child_exited = self.take_core_exit_pending().unwrap_or(false);
            if matches!(ready_probe, Ok(true)) {
                if let Err(error) = self.observe_core_ready() {
                    let _ = self.set_core_recovery_message(Some(error));
                    return;
                }
                if self.pending_tun_restore().ok().flatten().is_some() {
                    if let Err(error) = self.restore_pending_tun_locked().await {
                        let _ = self.set_core_recovery_message(Some(format!(
                            "Mihomo 已恢复，但 TUN 自动恢复失败：{error}"
                        )));
                    }
                }
                return;
            }

            let tun = self.tun_data().ok();
            let tun_profile_id = tun.as_ref().and_then(|tun| tun.profile_id.clone());
            let tun_needs_cleanup = tun
                .as_ref()
                .is_some_and(|tun| tun.status != "disabled" && self.has_tun_recovery());
            let failure_reason = match &ready_probe {
                Err(error) if had_child || child_exited => Some(error.clone()),
                Ok(false) if had_child || child_exited => Some(if child_exited {
                    "受管 Mihomo 进程异常退出，未能保持 Ready".to_string()
                } else {
                    "受管 Mihomo 未保持 Ready，自动恢复将退避".to_string()
                }),
                _ => None,
            };

            if let Some(error) = failure_reason {
                if self.owns_core().unwrap_or(false) {
                    if let Err(cleanup_error) = self.stop_owned_child_for_retry() {
                        let _ = self.set_core_recovery_message(Some(cleanup_error));
                        return;
                    }
                }
                if let Err(cleanup_error) = self
                    .disable_tun_for_core_recovery_locked(tun_profile_id)
                    .await
                {
                    let _ = self.set_core_recovery_message(Some(cleanup_error));
                    return;
                }
                let _ = self.record_core_recovery_failure(&error);
                return;
            }

            if let Err(error) = ready_probe {
                let _ = self.set_core_recovery_message(Some(error));
                return;
            }

            if tun_needs_cleanup {
                if let Err(error) = self
                    .disable_tun_for_core_recovery_locked(tun_profile_id)
                    .await
                {
                    let _ = self.set_core_recovery_message(Some(error));
                    return;
                }
            }

            match self.automatic_start_locked().await {
                Ok(Some(_)) | Ok(None) => {}
                Err(error) => eprintln!("Service Mihomo 自动恢复失败：{error}"),
            }
        }

        async fn monitor(self: Arc<Self>, mut shutdown: watch::Receiver<bool>) {
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
                let _transition = self.core_transition.lock().await;
                self.monitor_core_once_locked().await;
            }
        }
    }

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

    fn ensure_not_reparse(path: &Path) -> Result<(), String> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.to_string()),
        };
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!("拒绝写入 Reparse Point 路径：{}", path.display()));
        }
        Ok(())
    }

    fn replace_file(temp: &Path, path: &Path) -> Result<(), String> {
        let source = temp
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let target = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let moved = unsafe {
            MoveFileExW(
                source.as_ptr(),
                target.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if moved == 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        Ok(())
    }

    fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            ensure_not_reparse(parent)?;
        }
        ensure_not_reparse(path)?;

        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| format!("无法生成临时文件名：{}", path.display()))?;
        let parent = path
            .parent()
            .ok_or_else(|| format!("无法确定临时文件目录：{}", path.display()))?;
        let mut temp = None;
        for _ in 0..8 {
            let mut random = [0u8; 16];
            getrandom::fill(&mut random).map_err(|e| format!("生成临时文件名失败：{e}"))?;
            let suffix = random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            let candidate = parent.join(format!(".{file_name}.{suffix}.tmp"));
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)
            {
                Ok(mut file) => {
                    let result = file
                        .write_all(bytes)
                        .and_then(|_| file.flush())
                        .and_then(|_| file.sync_all());
                    if let Err(error) = result {
                        drop(file);
                        let _ = fs::remove_file(&candidate);
                        return Err(error.to_string());
                    }
                    if let Err(error) = ensure_not_reparse(&candidate) {
                        drop(file);
                        let _ = fs::remove_file(&candidate);
                        return Err(error);
                    }
                    temp = Some(candidate);
                    break;
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
        let temp = temp.ok_or_else(|| "无法创建唯一临时文件".to_string())?;
        if let Err(error) = replace_file(&temp, path) {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
        Ok(())
    }

    fn response_ok(request_id: u64, data: Value) -> ServiceResponse {
        ServiceResponse {
            request_id,
            protocol_version: SERVICE_PROTOCOL_VERSION,
            service_version: SERVICE_VERSION.to_string(),
            ok: true,
            error: None,
            data: Some(data),
        }
    }

    fn response_error(request_id: u64, error: String) -> ServiceResponse {
        ServiceResponse {
            request_id,
            protocol_version: SERVICE_PROTOCOL_VERSION,
            service_version: SERVICE_VERSION.to_string(),
            ok: false,
            error: Some(error),
            data: None,
        }
    }

    fn server_attributes(data_dir: &Path) -> Result<SECURITY_ATTRIBUTES, String> {
        #[cfg(test)]
        let _ = data_dir;
        #[cfg(test)]
        let sid = "AU".to_string();
        #[cfg(not(test))]
        let sid = {
            let sid_path = data_dir.join(USER_SID_FILE);
            let sid = config::read_text_file_at(&sid_path, "读取 Service 安装用户身份")?
                .ok_or_else(|| "读取 Service 安装用户身份失败：文件不存在".to_string())?
                .trim()
                .to_string();
            validate_sid(&sid)?
        };
        let sddl = format!("D:P(A;;GA;;;SY)(A;;GA;;;{sid})\0");
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

    fn create_server(first: bool, data_dir: &Path) -> Result<NamedPipeServer, String> {
        let mut options = ServerOptions::new();
        options
            .first_pipe_instance(first)
            .max_instances(1)
            .in_buffer_size(16 * 1024)
            .out_buffer_size(16 * 1024);
        let mut attributes = server_attributes(data_dir)?;
        let server = unsafe {
            options.create_with_security_attributes_raw(
                pipe_name(),
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

    const MAX_REQUEST_BYTES: usize = 64 * 1024;

    async fn read_request_line(server: &mut NamedPipeServer) -> Result<String, String> {
        let mut request = Vec::with_capacity(1024);
        let mut chunk = [0u8; 1024];
        loop {
            let read = tokio::time::timeout(Duration::from_secs(5), server.read(&mut chunk))
                .await
                .map_err(|_| "读取 Service 请求超时".to_string())?
                .map_err(|e| format!("读取 Service 请求失败：{e}"))?;
            if read == 0 {
                break;
            }
            let newline = chunk[..read].iter().position(|byte| *byte == b'\n');
            let take = newline.map_or(read, |index| index + 1);
            if request.len() + take > MAX_REQUEST_BYTES {
                return Err("Service 请求超过大小限制".to_string());
            }
            request.extend_from_slice(&chunk[..take]);
            if newline.is_some() {
                break;
            }
        }
        String::from_utf8(request).map_err(|e| format!("Service 请求不是 UTF-8：{e}"))
    }

    async fn handle_client(
        mut server: NamedPipeServer,
        runtime: &ServiceRuntime,
        expected_token: &str,
    ) -> Result<(), String> {
        let line = read_request_line(&mut server).await?;
        let request = match serde_json::from_str::<ServiceRequest>(&line) {
            Ok(request) => request,
            Err(error) => {
                let line =
                    serde_json::to_string(&response_error(0, format!("Service 请求无效：{error}")))
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
            response_error(
                request.request_id,
                format!(
                    "Service 协议版本不匹配：{SERVICE_PROTOCOL_VERSION} != {}",
                    request.protocol_version
                ),
            )
        } else if request.client_version != SERVICE_VERSION {
            response_error(
                request.request_id,
                format!(
                    "GUI 与 Service 版本不匹配：{SERVICE_VERSION} != {}",
                    request.client_version
                ),
            )
        } else if request.token != expected_token {
            response_error(request.request_id, "Service 令牌无效".to_string())
        } else {
            match runtime.handle(request.command).await {
                Ok(data) => response_ok(request.request_id, data),
                Err(error) => response_error(request.request_id, error),
            }
        };
        let line = serde_json::to_string(&response).map_err(|e| e.to_string())? + "\n";
        server
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("发送 Service 响应失败：{e}"))?;
        server.flush().await.map_err(|e| e.to_string())
    }

    async fn create_server_until_ready(
        first: bool,
        data_dir: &Path,
        shutdown: &mut watch::Receiver<bool>,
    ) -> Result<Option<NamedPipeServer>, String> {
        loop {
            match create_server(first, data_dir) {
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
        mihomo::initialize_secret(&data_dir)?;
        let expected_token = ensure_token(&data_dir)?;
        let runtime = Arc::new(ServiceRuntime::new(data_dir, mihomo_path)?);
        if let Err(error) = runtime.recover().await {
            runtime.set_recovery_error(error)?;
        }
        runtime.ensure_desired_core_ready().await;
        let monitor = tokio::spawn(runtime.clone().monitor(shutdown.clone()));
        let mut first = true;
        let shutdown_result = loop {
            let Some(server) =
                create_server_until_ready(first, &runtime.data_dir, &mut shutdown).await?
            else {
                break runtime.shutdown().await;
            };
            first = false;
            tokio::select! {
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        break runtime.shutdown().await;
                    }
                }
                connected = server.connect() => {
                    if connected.is_ok() {
                        let _ = handle_client(server, &runtime, &expected_token).await;
                    }
                }
            }
        };
        monitor.abort();
        shutdown_result
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

    /// Developer/validation helper. The normal product UI never calls this.
    pub fn port_diagnostics(port: u16) -> Result<Value, String> {
        serde_json::to_value(config::windows_tcp_listener_diagnostics(port, None)?)
            .map_err(|error| error.to_string())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{
            fs,
            time::{SystemTime, UNIX_EPOCH},
        };

        fn recovery_test_dir(label: &str) -> std::path::PathBuf {
            std::env::temp_dir().join(format!(
                "mioproxy-service-core-recovery-{label}-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ))
        }

        #[test]
        fn core_recovery_uses_bounded_backoff_then_suspends() {
            let mut state = CoreRecoveryState::default();

            state.record_failure(100, "first failure");
            assert_eq!(state.failure_count, 1);
            assert_eq!(state.next_retry_at, Some(115));
            assert_eq!(state.mode(114), CoreRecoveryMode::BackingOff);
            assert_eq!(state.retry_remaining_secs(114), Some(1));
            assert!(core_recovery_message(&state, 114)
                .unwrap()
                .contains("约 1 秒后重试"));
            assert_eq!(state.mode(115), CoreRecoveryMode::Active);

            state.record_failure(115, "second failure");
            assert_eq!(state.failure_count, 2);
            assert_eq!(state.next_retry_at, Some(145));

            state.record_failure(145, "third failure");
            assert_eq!(state.failure_count, 3);
            assert_eq!(state.next_retry_at, Some(205));

            state.record_failure(205, "fourth failure");
            assert_eq!(state.failure_count, CORE_RECOVERY_MAX_FAILURES);
            assert_eq!(state.mode(205), CoreRecoveryMode::Suspended);
            assert!(!state.can_attempt(205));
            assert_eq!(state.next_retry_at, None);
            assert!(core_recovery_message(&state, 205)
                .unwrap()
                .contains("自动恢复已暂停，请手动重试"));
        }

        #[test]
        fn core_recovery_budget_accounts_for_internal_start_candidates() {
            assert_eq!(CORE_RECOVERY_MAX_FAILURES * CORE_START_MAX_CANDIDATES, 16);
        }

        #[test]
        fn core_recovery_explicit_retry_or_stop_resets_a_suspended_policy() {
            let mut state = CoreRecoveryState::default();
            for (now, error) in [(100, "one"), (115, "two"), (145, "three"), (205, "four")] {
                state.record_failure(now, error);
            }
            assert_eq!(state.mode(205), CoreRecoveryMode::Suspended);

            state.reset();
            assert_eq!(state, CoreRecoveryState::default());
            assert_eq!(state.mode(205), CoreRecoveryMode::Active);
            assert!(state.can_attempt(205));
            assert_eq!(core_recovery_message(&state, 205), None);
        }

        #[test]
        fn core_recovery_resets_only_after_sustained_ready() {
            let mut state = CoreRecoveryState::default();
            state.record_failure(100, "startup failure");

            assert!(state.mark_ready(110));
            assert_eq!(state.failure_count, 1);
            assert_eq!(state.healthy_since, Some(110));
            assert_eq!(state.next_retry_at, None);
            assert_eq!(core_recovery_message(&state, 120), None);
            assert!(!state.mark_ready(169));
            assert_eq!(state.failure_count, 1);
            assert!(state.mark_ready(170));
            assert_eq!(state, CoreRecoveryState::default());
        }

        #[test]
        fn core_recovery_failure_window_expires_during_runtime() {
            let mut state = CoreRecoveryState::default();
            state.record_failure(100, "old failure");
            assert!(state.expired(100 + CORE_RECOVERY_FAILURE_WINDOW_SECS));

            state.record_failure(
                100 + CORE_RECOVERY_FAILURE_WINDOW_SECS,
                "new failure after window",
            );
            assert_eq!(state.failure_count, 1);
            assert_eq!(
                state.next_retry_at,
                Some(115 + CORE_RECOVERY_FAILURE_WINDOW_SECS)
            );
            assert_eq!(
                state.last_error.as_deref(),
                Some("new failure after window")
            );
        }

        #[test]
        fn core_recovery_persistence_is_versioned_and_resets_invalid_state() {
            let data_dir = recovery_test_dir("persistence");
            fs::create_dir_all(&data_dir).unwrap();

            let mut state = CoreRecoveryState::default();
            state.record_failure(100, "persisted failure");
            persist_core_recovery_state(&data_dir, &state).unwrap();
            let persisted = serde_json::from_slice::<PersistedCoreRecoveryState>(
                &fs::read(data_dir.join(CORE_RECOVERY_STATE_FILE)).unwrap(),
            )
            .unwrap();
            assert_eq!(persisted.format_version, CORE_RECOVERY_STATE_FORMAT_VERSION);

            let (loaded, should_clear) = read_core_recovery_state(&data_dir, 100).unwrap();
            assert!(!should_clear);
            assert_eq!(loaded, state);

            let (expired, should_clear) =
                read_core_recovery_state(&data_dir, 100 + CORE_RECOVERY_FAILURE_WINDOW_SECS)
                    .unwrap();
            assert!(should_clear);
            assert_eq!(expired, CoreRecoveryState::default());

            persist_core_recovery_state(&data_dir, &CoreRecoveryState::default()).unwrap();
            assert!(!data_dir.join(CORE_RECOVERY_STATE_FILE).exists());

            fs::write(data_dir.join(CORE_RECOVERY_STATE_FILE), b"not json").unwrap();
            assert!(read_core_recovery_state(&data_dir, 100).is_err());
            let _ = fs::remove_dir_all(data_dir);
        }

        #[test]
        fn core_recovery_persistence_normalizes_future_and_oversized_fields() {
            let persisted = PersistedCoreRecoveryState {
                format_version: CORE_RECOVERY_STATE_FORMAT_VERSION,
                failure_count: 1,
                last_failure_at: Some(200),
                next_retry_at: Some(215),
                healthy_since: None,
                suspended: false,
                last_error: Some("x".repeat(CORE_RECOVERY_ERROR_MAX_CHARS + 1)),
            };
            let (state, should_clear) = CoreRecoveryState::from_persisted(persisted, 100);
            assert!(should_clear);
            assert_eq!(state, CoreRecoveryState::default());

            let persisted = PersistedCoreRecoveryState {
                format_version: CORE_RECOVERY_STATE_FORMAT_VERSION,
                failure_count: 1,
                last_failure_at: Some(100),
                next_retry_at: Some(115),
                healthy_since: None,
                suspended: false,
                last_error: Some("x".repeat(CORE_RECOVERY_ERROR_MAX_CHARS + 1)),
            };
            let (state, should_clear) = CoreRecoveryState::from_persisted(persisted, 100);
            assert!(!should_clear);
            assert_eq!(
                state.last_error.as_deref().unwrap().chars().count(),
                CORE_RECOVERY_ERROR_MAX_CHARS
            );
        }

        #[tokio::test]
        async fn core_transition_serializes_recovery_attempts() {
            let data_dir = recovery_test_dir("transition");
            let runtime = std::sync::Arc::new(
                ServiceRuntime::new(data_dir.clone(), PathBuf::from("missing-mihomo.exe")).unwrap(),
            );
            let first = runtime.core_transition.lock().await;
            let waiting_runtime = std::sync::Arc::clone(&runtime);
            let mut waiter = tokio::spawn(async move {
                let _second = waiting_runtime.core_transition.lock().await;
            });

            assert!(tokio::time::timeout(Duration::from_millis(20), &mut waiter)
                .await
                .is_err());
            drop(first);
            tokio::time::timeout(Duration::from_secs(1), waiter)
                .await
                .unwrap()
                .unwrap();
            drop(runtime);
            let _ = fs::remove_dir_all(data_dir);
        }

        #[test]
        fn missing_core_state_defaults_to_ready() {
            let data_dir = std::env::temp_dir().join(format!(
                "mioproxy-service-core-state-test-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&data_dir).unwrap();
            assert!(read_desired_core_state(&data_dir).unwrap());
            let _ = fs::remove_dir_all(data_dir);
        }

        #[test]
        fn migrates_legacy_stopped_core_state_to_ready() {
            let data_dir = std::env::temp_dir().join(format!(
                "mioproxy-service-core-state-migration-test-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&data_dir).unwrap();
            fs::write(
                data_dir.join(CORE_STATE_FILE),
                r#"{"desiredRunning":false}"#,
            )
            .unwrap();
            assert!(read_desired_core_state(&data_dir).unwrap());
            let _ = fs::remove_dir_all(data_dir);
        }

        #[test]
        fn migrates_pre_shutdown_fix_stop_state_to_ready() {
            let data_dir = std::env::temp_dir().join(format!(
                "mioproxy-service-core-state-v1-test-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&data_dir).unwrap();
            fs::write(
                data_dir.join(CORE_STATE_FILE),
                r#"{"formatVersion":1,"desiredRunning":false}"#,
            )
            .unwrap();
            assert!(read_desired_core_state(&data_dir).unwrap());
            let _ = fs::remove_dir_all(data_dir);
        }

        #[test]
        fn keeps_versioned_advanced_stop_state() {
            let data_dir = std::env::temp_dir().join(format!(
                "mioproxy-service-core-state-advanced-stop-test-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&data_dir).unwrap();
            fs::write(
                data_dir.join(CORE_STATE_FILE),
                r#"{"formatVersion":2,"desiredRunning":false}"#,
            )
            .unwrap();
            assert!(!read_desired_core_state(&data_dir).unwrap());
            let _ = fs::remove_dir_all(data_dir);
        }

        #[test]
        fn service_core_owner_is_cleared_only_for_matching_pid() {
            let data_dir = std::env::temp_dir().join(format!(
                "mioproxy-service-core-owner-test-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&data_dir).unwrap();
            persist_service_core_owner(&data_dir, 4242).unwrap();
            assert_eq!(read_persisted_service_core_pid_at(&data_dir), Some(4242));
            clear_service_core_owner_if_matches(&data_dir, 4343).unwrap();
            assert_eq!(read_persisted_service_core_pid_at(&data_dir), Some(4242));
            clear_service_core_owner_if_matches(&data_dir, 4242).unwrap();
            assert_eq!(read_persisted_service_core_pid_at(&data_dir), None);
            let _ = fs::remove_dir_all(data_dir);
        }

        #[test]
        fn ordinary_ipc_can_fall_back_when_service_transport_is_unavailable() {
            for error in [
                "MioProxy Service IPC 暂时不可用，等待重新连接",
                "MioProxy Service 正在启动，等待 Named Pipe 就绪",
                "MioProxy Service 已运行但 Named Pipe 尚未就绪",
            ] {
                assert!(is_optional_ipc_transport_error(error));
            }
            assert!(!is_optional_ipc_transport_error(
                "MioProxy Service 版本不匹配：GUI=0.9.2，Service=0.9.0"
            ));
            assert!(!is_optional_ipc_transport_error("Service 令牌无效"));
        }

        #[test]
        fn scm_states_project_without_changing_service_state() {
            assert_eq!(project_scm_state(None), ServiceProjectionState::Stopped);
            assert_eq!(
                project_scm_state(Some(ServiceState::Stopped)),
                ServiceProjectionState::Stopped
            );
            assert_eq!(
                project_scm_state(Some(ServiceState::StopPending)),
                ServiceProjectionState::Stopped
            );
            assert_eq!(
                project_scm_state(Some(ServiceState::StartPending)),
                ServiceProjectionState::Starting
            );
            assert_eq!(
                project_scm_state(Some(ServiceState::ContinuePending)),
                ServiceProjectionState::Starting
            );
            assert_eq!(
                project_scm_state(Some(ServiceState::Running)),
                ServiceProjectionState::Running
            );
            assert_eq!(
                project_scm_state(Some(ServiceState::PausePending)),
                ServiceProjectionState::Error
            );
            assert_eq!(
                project_scm_state(Some(ServiceState::Paused)),
                ServiceProjectionState::Error
            );
        }

        #[test]
        fn ipc_errors_distinguish_reconnects_from_terminal_errors() {
            assert_eq!(
                scm_connectivity(Some(ServiceState::StartPending)),
                ServiceConnectivity::ScmStarting
            );
            assert_eq!(
                scm_connectivity(Some(ServiceState::Running)),
                ServiceConnectivity::Ready
            );
            assert_eq!(
                response_error_connectivity("Service 令牌无效"),
                ServiceConnectivity::AuthenticationFailure
            );
            assert_eq!(
                response_error_connectivity("Service 协议版本不匹配"),
                ServiceConnectivity::ProtocolFailure
            );
            assert_eq!(
                response_error_connectivity("MioProxy Service TUN 命令失败"),
                ServiceConnectivity::CommandFailure
            );
        }

        #[test]
        fn service_projection_state_serializes_as_lowercase() {
            assert_eq!(
                serde_json::to_value(ServiceProjectionState::Reconnecting).unwrap(),
                "reconnecting"
            );
        }

        #[test]
        fn legacy_service_tun_state_migrates_optional_recovery_fields() {
            let state = serde_json::from_str::<PersistedServiceTunState>(
                r#"{"previousOverride":"legacy override","profileId":"profile-1"}"#,
            )
            .unwrap();
            assert_eq!(state.previous_override.as_deref(), Some("legacy override"));
            assert_eq!(state.profile_id, "profile-1");
            assert!(state.snapshot.is_none());

            let current =
                serde_json::from_str::<PersistedServiceTunState>(r#"{"profileId":"profile-2"}"#)
                    .unwrap();
            assert!(current.previous_override.is_none());
            assert!(current.snapshot.is_none());
        }

        #[test]
        fn empty_previous_override_marker_migrates_to_active_runtime() {
            for previous_override in ["", "  \r\n\t"] {
                let content = serde_json::json!({
                    "previousOverride": previous_override,
                    "profileId": "profile-1",
                });
                let state = serde_json::from_value::<PersistedServiceTunState>(content).unwrap();

                assert!(state.previous_override.is_none());
                assert_eq!(
                    tun_runtime_restore_path(state.previous_override.as_deref()),
                    TunRuntimeRestorePath::ActiveRuntime
                );
            }
        }

        #[test]
        fn non_empty_previous_override_keeps_legacy_restore_path() {
            let previous_override = "rules:\n  - MATCH,DIRECT\n";
            let state = serde_json::from_value::<PersistedServiceTunState>(serde_json::json!({
                "previousOverride": previous_override,
                "profileId": "profile-1",
            }))
            .unwrap();

            assert_eq!(state.previous_override.as_deref(), Some(previous_override));
            assert_eq!(
                tun_runtime_restore_path(state.previous_override.as_deref()),
                TunRuntimeRestorePath::LegacyOverride(previous_override)
            );
        }

        #[test]
        fn controller_reload_diagnostics_distinguish_rejection_from_communication() {
            assert_eq!(
                controller_reload_diagnostic_stage(
                    "Mihomo Controller 拒绝请求（HTTP 400 Bad Request）：invalid config"
                ),
                "controller-reload"
            );
            for error in [
                "Mihomo Controller 请求构建失败：invalid URL",
                "Mihomo Controller 通信失败：connection refused",
                "读取 Mihomo Controller 响应失败：connection reset",
                "解析 Mihomo Controller 响应失败：invalid JSON",
            ] {
                assert_eq!(
                    controller_reload_diagnostic_stage(error),
                    "controller-communication"
                );
            }
        }

        #[test]
        fn serializes_service_command_fields_in_camel_case() {
            let value = serde_json::to_value(ServiceCommand::TunSetEnabled {
                enabled: true,
                profile_id: Some("profile-1".to_string()),
                system_proxy_enabled: false,
            })
            .unwrap();
            assert_eq!(value["command"], "tunSetEnabled");
            assert_eq!(value["profileId"], "profile-1");
            assert_eq!(value["systemProxyEnabled"], false);
            assert!(value.get("profile_id").is_none());
            assert!(value.get("system_proxy_enabled").is_none());
        }

        #[test]
        fn serializes_port_diagnostics_as_a_non_ui_service_command() {
            let value =
                serde_json::to_value(ServiceCommand::PortDiagnostics { port: 7890 }).unwrap();
            assert_eq!(value["command"], "portDiagnostics");
            assert_eq!(value["port"], 7890);
        }

        #[cfg(feature = "validation-fault-injection")]
        #[test]
        fn serializes_validation_fault_injection_command() {
            let value = serde_json::to_value(ServiceCommand::ValidationCrashManagedCore).unwrap();
            assert_eq!(value["command"], "validationCrashManagedCore");
        }

        #[tokio::test]
        async fn named_pipe_status_round_trip() {
            let data_dir = std::env::temp_dir().join(format!(
                "mioproxy-service-test-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&data_dir).unwrap();
            fs::write(
                data_dir.join(CORE_STATE_FILE),
                format!(
                    r#"{{"formatVersion":{CORE_STATE_FORMAT_VERSION},"desiredRunning":false}}"#
                ),
            )
            .unwrap();
            let test_pipe = format!(
                r"\\.\pipe\MioProxyServiceTest-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            fs::create_dir_all(&data_dir).unwrap();
            let stopped_core = serde_json::to_vec(&PersistedCoreState {
                format_version: CORE_STATE_FORMAT_VERSION,
                desired_running: false,
            })
            .unwrap();
            fs::write(data_dir.join(CORE_STATE_FILE), stopped_core).unwrap();
            std::env::set_var("MIOPROXY_TEST_PIPE_NAME", &test_pipe);
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
                    if let Ok(next) = ClientOptions::new().open(&test_pipe) {
                        client = Some((next, token));
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            if client.is_none() && daemon.is_finished() {
                panic!(
                    "Service daemon exited before pipe readiness: {:?}",
                    daemon.await
                );
            }
            let (mut client, token) = client.expect("Service named pipe did not become ready");
            let request = ServiceRequest {
                request_id: 1,
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
            assert_eq!(response.request_id, 1);
            assert_eq!(response.protocol_version, SERVICE_PROTOCOL_VERSION);
            let status: ServiceStatusData = serde_json::from_value(response.data.unwrap()).unwrap();
            assert!(!status.running);
            assert!(!status.owns_core);
            drop(reader);

            let mut mismatch_client = None;
            for _ in 0..50 {
                if let Ok(next) = ClientOptions::new().open(&test_pipe) {
                    mismatch_client = Some(next);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let mut mismatch_client =
                mismatch_client.expect("Service did not accept a second client");
            let mismatch_request = ServiceRequest {
                request_id: 2,
                protocol_version: SERVICE_PROTOCOL_VERSION + 1,
                client_version: SERVICE_VERSION.to_string(),
                token: token.trim().to_string(),
                command: ServiceCommand::Status,
            };
            mismatch_client
                .write_all((serde_json::to_string(&mismatch_request).unwrap() + "\n").as_bytes())
                .await
                .unwrap();
            mismatch_client.flush().await.unwrap();
            let mut mismatch_reader = BufReader::new(mismatch_client);
            let mut mismatch_line = String::new();
            mismatch_reader.read_line(&mut mismatch_line).await.unwrap();
            let mismatch_response: ServiceResponse = serde_json::from_str(&mismatch_line).unwrap();
            assert!(!mismatch_response.ok);
            assert!(mismatch_response
                .error
                .as_deref()
                .is_some_and(|error| error.contains("协议版本不匹配")));

            let mut version_client = None;
            for _ in 0..50 {
                if let Ok(next) = ClientOptions::new().open(&test_pipe) {
                    version_client = Some(next);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let mut version_client =
                version_client.expect("Service did not accept a version mismatch client");
            let version_request = ServiceRequest {
                request_id: 3,
                protocol_version: SERVICE_PROTOCOL_VERSION,
                client_version: "0.7.0".to_string(),
                token: token.trim().to_string(),
                command: ServiceCommand::Status,
            };
            version_client
                .write_all((serde_json::to_string(&version_request).unwrap() + "\n").as_bytes())
                .await
                .unwrap();
            version_client.flush().await.unwrap();
            let mut version_reader = BufReader::new(version_client);
            let mut version_line = String::new();
            version_reader.read_line(&mut version_line).await.unwrap();
            let version_response: ServiceResponse = serde_json::from_str(&version_line).unwrap();
            assert!(!version_response.ok);
            assert!(version_response
                .error
                .as_deref()
                .is_some_and(|error| error.contains("GUI 与 Service 版本不匹配")));

            let mut token_client = None;
            for _ in 0..50 {
                if let Ok(next) = ClientOptions::new().open(&test_pipe) {
                    token_client = Some(next);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let mut token_client =
                token_client.expect("Service did not accept an invalid token client");
            let token_request = ServiceRequest {
                request_id: 4,
                protocol_version: SERVICE_PROTOCOL_VERSION,
                client_version: SERVICE_VERSION.to_string(),
                token: "invalid-service-token".to_string(),
                command: ServiceCommand::Status,
            };
            token_client
                .write_all((serde_json::to_string(&token_request).unwrap() + "\n").as_bytes())
                .await
                .unwrap();
            token_client.flush().await.unwrap();
            let mut token_reader = BufReader::new(token_client);
            let mut token_line = String::new();
            token_reader.read_line(&mut token_line).await.unwrap();
            let token_response: ServiceResponse = serde_json::from_str(&token_line).unwrap();
            assert!(!token_response.ok);
            assert!(token_response
                .error
                .as_deref()
                .is_some_and(|error| error.contains("Service 令牌无效")));

            let _ = sender.send(true);
            daemon.await.unwrap().unwrap();
            std::env::remove_var("MIOPROXY_TEST_PIPE_NAME");
            let _ = fs::remove_dir_all(data_dir);
        }
    }
}

#[cfg(windows)]
pub use windows_impl::{
    ensure_install_token, ensure_install_user_sid, port_diagnostics, run_service_console,
    run_service_daemon,
};

#[cfg(windows)]
pub(crate) use windows_impl::{
    persisted_managed_core_pid, prepare_for_update, request_apply_profile, request_core,
    request_core_update, request_reload, request_service_status, request_tun,
    restore_for_lifecycle, resume_after_update_failure, service_tun_status,
    verify_stopped_for_update,
};

#[cfg(not(windows))]
pub(crate) fn persisted_managed_core_pid(_app: &AppHandle) -> Option<u32> {
    None
}

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
pub(crate) async fn request_core_update(
    _app: &AppHandle,
    _command: ServiceCommand,
) -> Result<Option<crate::core_update::CoreUpdateStatus>, String> {
    Ok(None)
}

#[cfg(not(windows))]
pub(crate) async fn request_service_status(
    _app: &AppHandle,
) -> Result<Option<ServiceStatusData>, String> {
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
pub(crate) async fn restore_for_lifecycle(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
pub(crate) async fn prepare_for_update(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
pub(crate) async fn resume_after_update_failure(
    _app: &AppHandle,
    _should_restart: bool,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn verify_stopped_for_update() -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn service_status_command(_app: AppHandle) -> Result<ServiceConnectionStatus, String> {
    Ok(ServiceConnectionStatus::disconnected(
        ServiceProjectionState::Stopped,
        None,
        false,
    ))
}

#[cfg(windows)]
#[tauri::command]
pub async fn service_status_command(app: AppHandle) -> Result<ServiceConnectionStatus, String> {
    windows_impl::service_status(app).await
}

#[cfg(all(windows, feature = "validation-fault-injection"))]
#[tauri::command]
pub async fn validation_crash_managed_core(app: AppHandle) -> Result<Value, String> {
    windows_impl::validation_crash_managed_core(app).await
}

#[cfg(all(not(windows), feature = "validation-fault-injection"))]
#[tauri::command]
pub async fn validation_crash_managed_core(_app: AppHandle) -> Result<Value, String> {
    Err("受管 Mihomo 故障注入仅支持 Windows Service 验收构建".to_string())
}
