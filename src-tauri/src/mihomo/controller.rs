use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

#[cfg(windows)]
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::sync::Mutex as AsyncMutex;

use super::{logs, traffic};

// Keep the controller in MioProxy's own localhost namespace. 7890/9090 are
// common defaults used by other Mihomo clients and are not identity markers.
pub(crate) const CONTROLLER: &str = "127.0.0.1:19090";
const CONTROLLER_SECRET_FILE: &str = "controller-secret";
const DEFAULT_DELAY_URL: &str = "https://www.gstatic.com/generate_204";
const DELAY_TIMEOUT_MS: u64 = 5_000;
const DELAY_OUTER_TIMEOUT_SECS: u64 = 7;
static CONTROLLER_SECRET: OnceLock<String> = OnceLock::new();
// Keep fallback-core startup and termination recovery in one lifecycle critical
// section. In particular, `child` must not be cleared until TUN rollback is done.
static CORE_LIFECYCLE_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyEntryKind {
    Ordinary,
    Provider,
    Group,
    Builtin,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyDelayRequest {
    pub group: String,
    pub proxy: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub test_url: Option<String>,
    #[serde(default)]
    pub expected_status: Option<String>,
    #[serde(default)]
    pub kind: Option<ProxyEntryKind>,
}

#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

#[cfg(windows)]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

fn read_existing_secret(path: &Path) -> Result<Option<String>, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取 Mihomo Controller 令牌失败：{error}")),
    };
    #[cfg(windows)]
    {
        let metadata = file
            .metadata()
            .map_err(|e| format!("检查 Mihomo Controller 令牌失败：{e}"))?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("拒绝读取 Reparse Point 形式的 Mihomo Controller 令牌".to_string());
        }
    }
    let mut value = String::new();
    file.read_to_string(&mut value)
        .map_err(|e| format!("读取 Mihomo Controller 令牌失败：{e}"))?;
    let value = value.trim().to_string();
    if value.is_empty() {
        Ok(None)
    } else {
        Ok(Some(value))
    }
}

pub(crate) fn initialize_secret(data_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(data_dir).map_err(|e| format!("创建 Mihomo 数据目录失败：{e}"))?;
    let path = data_dir.join(CONTROLLER_SECRET_FILE);
    let secret = match read_existing_secret(&path)? {
        Some(secret) => secret,
        None => {
            let mut bytes = [0u8; 32];
            getrandom::fill(&mut bytes)
                .map_err(|e| format!("生成 Mihomo Controller 令牌失败：{e}"))?;
            let candidate = bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(mut file) => {
                    if let Err(error) = file
                        .write_all(candidate.as_bytes())
                        .and_then(|_| file.flush())
                        .and_then(|_| file.sync_all())
                    {
                        drop(file);
                        let cleanup =
                            crate::config::remove_file(&path, "清理不完整 Mihomo Controller 令牌");
                        return Err(match cleanup {
                            Ok(()) => format!("保存 Mihomo Controller 令牌失败：{error}"),
                            Err(cleanup_error) => format!(
                                "保存 Mihomo Controller 令牌失败：{error}；清理不完整令牌文件失败：{cleanup_error}"
                            ),
                        });
                    }
                    candidate
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                    let mut winner = None;
                    for _ in 0..100 {
                        winner = read_existing_secret(&path)?;
                        if winner.is_some() {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    winner
                        .ok_or_else(|| "读取并发初始化的 Mihomo Controller 令牌失败".to_string())?
                }
                Err(error) => {
                    return Err(format!("创建 Mihomo Controller 令牌文件失败：{error}"));
                }
            }
        }
    };
    if let Some(current) = CONTROLLER_SECRET.get() {
        if current != &secret {
            return Err("MioProxy 已使用另一份 Mihomo Controller 令牌初始化".to_string());
        }
        return Ok(());
    }
    let config_path = data_dir.join("config.yaml");
    if let Some(content) = crate::config::read_text_file_at(&config_path, "读取 Mihomo 配置")? {
        if let Ok(mut value) = serde_yaml::from_str::<serde_yaml::Value>(&content) {
            if let Some(map) = value.as_mapping_mut() {
                map.insert(
                    serde_yaml::Value::String("secret".to_string()),
                    serde_yaml::Value::String(secret.clone()),
                );
                if let Ok(yaml) = serde_yaml::to_string(&value) {
                    crate::config::write_atomic(&config_path, yaml.as_bytes())
                        .map_err(|e| format!("更新 Mihomo Controller 令牌失败：{e}"))?;
                }
            }
        }
    }
    CONTROLLER_SECRET
        .set(secret)
        .map_err(|_| "初始化 Mihomo Controller 令牌失败".to_string())
}

pub(crate) fn secret() -> &'static str {
    CONTROLLER_SECRET.get().map(String::as_str).unwrap_or("")
}

pub struct CoreState {
    pub child: Mutex<Option<CommandChild>>,
    pub stop_requested: AtomicBool,
    ready_observed: AtomicBool,
    last_error: Mutex<Option<String>>,
}

impl Default for CoreState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            stop_requested: AtomicBool::new(false),
            ready_observed: AtomicBool::new(false),
            last_error: Mutex::new(None),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CoreUserState {
    #[default]
    Stopped,
    Starting,
    Ready,
    Error,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    #[serde(default)]
    pub state: CoreUserState,
    pub running: bool,
    pub controller: String,
    pub config_path: String,
    pub mixed_port: u16,
    pub mode: String,
    #[serde(default)]
    pub recovery_message: Option<String>,
}

#[derive(Deserialize)]
struct RuntimeConfig {
    #[serde(rename = "mixed-port")]
    mixed_port: Option<u16>,
    mode: Option<String>,
}

#[derive(Deserialize)]
struct RuntimeProxyGroup {
    name: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(rename = "expected-status", default)]
    expected_status: Option<serde_yaml::Value>,
    #[serde(default)]
    proxies: Vec<String>,
    #[serde(rename = "use", default)]
    use_providers: Vec<String>,
    #[serde(rename = "include-all", default)]
    include_all: bool,
    #[serde(rename = "include-all-proxies", default)]
    include_all_proxies: bool,
    #[serde(rename = "include-all-providers", default)]
    include_all_providers: bool,
}

#[derive(Deserialize, Default)]
struct RuntimeProxyGroupConfig {
    #[serde(rename = "proxy-groups", default)]
    proxy_groups: Vec<RuntimeProxyGroup>,
    #[serde(rename = "proxy-providers", default)]
    proxy_providers: BTreeMap<String, serde_yaml::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeProxyMemberContext {
    kind: ProxyEntryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_candidates: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_resolution: Option<&'static str>,
}

pub(crate) fn runtime_paths(
    app: &AppHandle,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let config = dir.join("config.yaml");
    Ok((dir, config))
}

fn ensure_default_config(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let (dir, config) = runtime_paths(app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    if crate::config::read_text_file_at(&config, "读取 Mihomo 配置")?.is_none() {
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
            controller = CONTROLLER,
            secret = secret(),
        );
        crate::config::write_atomic(&config, yaml.as_bytes())?;
    }

    Ok(config)
}

async fn validate_gui_config(
    app: &AppHandle,
    data_dir: &Path,
    config: &Path,
) -> Result<(), String> {
    let data_dir = crate::config::mihomo_path_string(data_dir);
    let config = crate::config::mihomo_path_string(config);
    let output = app
        .shell()
        .sidecar("mihomo")
        .map_err(|error| format!("找不到 Mihomo sidecar：{error}"))?
        .args(["-t", "-d"])
        .arg(data_dir)
        .args(["-f"])
        .arg(config)
        .output()
        .await
        .map_err(|error| format!("执行 Mihomo 配置校验失败：{error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(format!(
        "Mihomo 配置校验失败：{}",
        if stderr.is_empty() { stdout } else { stderr }
    ))
}

pub(crate) async fn api_get(path: &str) -> Result<Value, String> {
    api_get_with_timeout(path, Duration::from_secs(2)).await
}

async fn api_get_with_timeout(path: &str, timeout: Duration) -> Result<Value, String> {
    api_get_with_timeout_at(&format!("http://{CONTROLLER}"), path, timeout, secret()).await
}

async fn api_get_with_timeout_at(
    base_url: &str,
    path: &str,
    timeout: Duration,
    bearer: &str,
) -> Result<Value, String> {
    let url = format!("{base_url}{path}");
    Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?
        .get(url)
        .bearer_auth(bearer)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json::<Value>()
        .await
        .map_err(|e| e.to_string())
}

async fn api_put_with_secret(path: &str, payload: Value, bearer: &str) -> Result<Value, String> {
    let url = format!("http://{CONTROLLER}{path}");
    let client = Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| {
            format!(
                "Mihomo Controller 请求构建失败：{}",
                logs::redact_controller_response(&error.to_string())
            )
        })?;
    let request = client
        .put(url)
        .bearer_auth(bearer)
        .json(&payload)
        .build()
        .map_err(|error| {
            format!(
                "Mihomo Controller 请求构建失败：{}",
                logs::redact_controller_response(&error.to_string())
            )
        })?;
    let response = client.execute(request).await.map_err(|error| {
        format!(
            "Mihomo Controller 通信失败：{}",
            logs::redact_controller_response(&error.to_string())
        )
    })?;
    let status = response.status();
    let body = response.text().await.map_err(|error| {
        format!(
            "读取 Mihomo Controller 响应失败：{}",
            logs::redact_controller_response(&error.to_string())
        )
    })?;
    if !status.is_success() {
        let reason = status.canonical_reason().unwrap_or("Unknown Status");
        let safe_body = logs::redact_controller_response(&body);
        let detail = if safe_body.trim().is_empty() {
            "响应体为空"
        } else {
            safe_body.trim()
        };
        return Err(format!(
            "Mihomo Controller 拒绝请求（HTTP {} {}）：{detail}",
            status.as_u16(),
            reason
        ));
    }
    if body.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&body).map_err(|error| {
        format!(
            "解析 Mihomo Controller 响应失败：{}；响应：{}",
            logs::redact_controller_response(&error.to_string()),
            logs::redact_controller_response(&body)
        )
    })
}

pub(crate) async fn api_put(path: &str, payload: Value) -> Result<Value, String> {
    api_put_with_secret(path, payload, secret()).await
}

pub(crate) async fn api_delete(path: &str) -> Result<Value, String> {
    let url = format!("http://{CONTROLLER}{path}");
    let response = Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?
        .delete(url)
        .bearer_auth(secret())
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let body = response.text().await.map_err(|e| e.to_string())?;
    if body.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

fn effective_delay_url(url: Option<&str>) -> String {
    url.map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_DELAY_URL)
        .to_string()
}

fn delay_request_path(request: &ProxyDelayRequest) -> Result<String, String> {
    if request.group.trim().is_empty() {
        return Err("延迟测试请求缺少代理组上下文".to_string());
    }
    if request.proxy.trim().is_empty() {
        return Err("延迟测试请求缺少代理节点".to_string());
    }

    let proxy = encode_path_segment(&request.proxy);
    let provider_allowed = !matches!(
        request.kind,
        Some(ProxyEntryKind::Group) | Some(ProxyEntryKind::Builtin)
    );
    let endpoint = request
        .provider
        .as_deref()
        .map(str::trim)
        .filter(|value| provider_allowed && !value.is_empty())
        .map(|provider| {
            format!(
                "/providers/proxies/{}/{}/healthcheck",
                encode_path_segment(provider),
                proxy,
            )
        })
        .unwrap_or_else(|| format!("/proxies/{proxy}/delay"));

    let test_url = effective_delay_url(request.test_url.as_deref());
    let mut path = format!(
        "{endpoint}?url={}&timeout={DELAY_TIMEOUT_MS}",
        encode_path_segment(&test_url),
    );
    if let Some(expected_status) = request
        .expected_status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        path.push_str("&expected=");
        path.push_str(&encode_path_segment(expected_status));
    }
    Ok(path)
}

pub(crate) fn encode_path_segment(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push(HEX[(byte >> 4) as usize] as char);
            encoded.push(HEX[(byte & 0x0F) as usize] as char);
        }
    }
    encoded
}

fn required_listener_ready(
    listeners: &[crate::config::TcpListenerDiagnostic],
    mixed_port: u16,
    managed_pid: u32,
) -> bool {
    listeners.iter().any(|listener| {
        listener.owner == crate::config::ListenerOwner::MioProxyManaged
            && listener.owning_pid == Some(managed_pid)
            && listener.address_family == "ipv4"
            && matches!(listener.local_address.as_str(), "127.0.0.1" | "0.0.0.0")
            && listener.local_port == mixed_port
            && listener.state == "listen"
    })
}

fn all_ready_signals(
    has_managed_pid: bool,
    version_authenticated: bool,
    proxies_authenticated: bool,
    required_listener: bool,
) -> bool {
    has_managed_pid && version_authenticated && proxies_authenticated && required_listener
}

async fn authenticated_controller_ready() -> bool {
    let (version, proxies) = tokio::join!(api_get("/version"), api_get("/proxies"));
    version.is_ok() && proxies.is_ok()
}

pub(crate) async fn core_ready_for_pid(mixed_port: u16, managed_pid: u32) -> Result<bool, String> {
    let (version, proxies) = tokio::join!(api_get("/version"), api_get("/proxies"));
    let version_authenticated = version.is_ok();
    let proxies_authenticated = proxies.is_ok();
    if !version_authenticated || !proxies_authenticated {
        return Ok(false);
    }
    let listeners = crate::config::windows_tcp_listener_diagnostics(mixed_port, Some(managed_pid))?;
    Ok(all_ready_signals(
        true,
        version_authenticated,
        proxies_authenticated,
        required_listener_ready(&listeners, mixed_port, managed_pid),
    ))
}

pub(crate) async fn is_running() -> bool {
    authenticated_controller_ready().await
}

pub(crate) fn owns_core<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<CoreState>()
        .and_then(|state| state.child.lock().ok().map(|child| child.is_some()))
        .unwrap_or(false)
}

fn managed_pid(state: &CoreState) -> Result<Option<u32>, String> {
    state
        .child
        .lock()
        .map(|child| child.as_ref().map(CommandChild::pid))
        .map_err(|_| "CoreState 锁异常".to_string())
}

fn take_managed_child_if_pid(
    state: &CoreState,
    expected_pid: u32,
) -> Result<Option<CommandChild>, String> {
    let mut child = state.child.lock().map_err(|_| "CoreState 锁异常")?;
    if child
        .as_ref()
        .is_some_and(|managed| managed.pid() == expected_pid)
    {
        Ok(child.take())
    } else {
        Ok(None)
    }
}

fn stop_child_after_failed_start(state: &CoreState, expected_pid: u32) -> Result<(), String> {
    state.stop_requested.store(true, Ordering::SeqCst);
    if let Some(child) = take_managed_child_if_pid(state, expected_pid)? {
        let _ = child.kill();
    }
    Ok(())
}

fn classify_user_state(
    managed_pid: Option<u32>,
    ready: bool,
    recovery_message: Option<&str>,
) -> CoreUserState {
    if managed_pid.is_some() && ready {
        CoreUserState::Ready
    } else if recovery_message.is_some() {
        CoreUserState::Error
    } else if managed_pid.is_some() {
        CoreUserState::Starting
    } else {
        CoreUserState::Stopped
    }
}

fn gui_status_is_authoritative(state: CoreUserState, has_managed_child: bool) -> bool {
    has_managed_child || matches!(state, CoreUserState::Ready | CoreUserState::Starting)
}

fn set_last_error(state: &CoreState, error: Option<String>) -> Result<(), String> {
    *state
        .last_error
        .lock()
        .map_err(|_| "CoreState 锁异常".to_string())? = error;
    Ok(())
}

fn record_start_result<T>(state: &CoreState, result: Result<T, String>) -> Result<T, String> {
    result.map_err(|error| match set_last_error(state, Some(error.clone())) {
        Ok(()) => error,
        Err(state_error) => format!("{error}；记录 Core Error 失败：{state_error}"),
    })
}

fn last_error(state: &CoreState) -> Result<Option<String>, String> {
    state
        .last_error
        .lock()
        .map(|error| error.clone())
        .map_err(|_| "CoreState 锁异常".to_string())
}

async fn persisted_service_core_pid_if_ready(app: &AppHandle) -> Result<Option<u32>, String> {
    let Some(pid) = crate::service::persisted_managed_core_pid(app) else {
        return Ok(None);
    };
    if core_ready_for_pid(mixed_port(app)?, pid).await? {
        Ok(Some(pid))
    } else {
        Ok(None)
    }
}

pub(crate) async fn ensure_managed_core(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<CoreState>();
    if let Some(pid) = managed_pid(state.inner())? {
        if core_ready_for_pid(mixed_port(app)?, pid).await? {
            return Ok(());
        }
    }
    if let Some(status) = crate::service::request_service_status(app).await? {
        if status.owns_core && status.core.running {
            return Ok(());
        }
        return Err("当前 Mihomo 未由 MioProxy 管理，拒绝执行控制操作".to_string());
    }
    if persisted_service_core_pid_if_ready(app).await?.is_some() {
        return Ok(());
    }
    if is_running().await {
        return Err("检测到非 MioProxy 管理的 Mihomo，拒绝执行控制操作".to_string());
    }
    Err("Mihomo 尚未启动".to_string())
}

pub(crate) fn mixed_port(app: &AppHandle) -> Result<u16, String> {
    let (_, config) = runtime_paths(app)?;
    let Some(content) = crate::config::read_text_file_at(&config, "读取 Mihomo 配置")? else {
        return Ok(7890);
    };
    let runtime = serde_yaml::from_str::<RuntimeConfig>(&content)
        .map_err(|e| format!("读取 Mihomo mixed-port 失败：{e}"))?;
    Ok(runtime.mixed_port.unwrap_or(7890))
}

fn mode(app: &AppHandle) -> Result<String, String> {
    let (_, config) = runtime_paths(app)?;
    let Some(content) = crate::config::read_text_file_at(&config, "读取 Mihomo 配置")? else {
        return Ok("rule".to_string());
    };
    let runtime = serde_yaml::from_str::<RuntimeConfig>(&content)
        .map_err(|e| format!("读取 Mihomo mode 失败：{e}"))?;
    Ok(runtime.mode.unwrap_or_else(|| "rule".to_string()))
}

fn status_for(
    app: &AppHandle,
    state: CoreUserState,
    recovery_message: Option<String>,
) -> Result<CoreStatus, String> {
    let (_, config) = runtime_paths(app)?;
    Ok(CoreStatus {
        state,
        running: state == CoreUserState::Ready,
        controller: CONTROLLER.to_string(),
        config_path: crate::config::mihomo_path_string(&config),
        mixed_port: mixed_port(app)?,
        mode: mode(app)?,
        recovery_message,
    })
}

async fn gui_owned_status(app: &AppHandle, state: &CoreState) -> Result<CoreStatus, String> {
    let pid = managed_pid(state)?;
    let mut probe_error = None;
    let ready = if let Some(pid) = pid {
        match core_ready_for_pid(mixed_port(app)?, pid).await {
            Ok(ready) => ready,
            Err(error) => {
                probe_error = Some(format!("检查 Mihomo Ready 状态失败：{error}"));
                false
            }
        }
    } else {
        false
    };
    let recovery_message = if ready {
        state.ready_observed.store(true, Ordering::SeqCst);
        None
    } else {
        probe_error.or(last_error(state)?).or_else(|| {
            (pid.is_some() && state.ready_observed.load(Ordering::SeqCst))
                .then(|| "Mihomo 已失去 Ready 状态".to_string())
        })
    };
    let user_state = classify_user_state(pid, ready, recovery_message.as_deref());
    status_for(app, user_state, recovery_message)
}

#[tauri::command]
pub async fn mihomo_start(
    app: AppHandle,
    state: State<'_, CoreState>,
) -> Result<CoreStatus, String> {
    crate::ensure_mutations_allowed(&app)?;
    let _lifecycle = CORE_LIFECYCLE_LOCK.lock().await;
    if let Some(status) =
        crate::service::request_core(&app, crate::service::ServiceCommand::Start).await?
    {
        crate::diagnostics::record_event(&app, "info", "mihomo", "Service Mihomo start requested");
        traffic::start(&app);
        logs::start(&app);
        crate::tray::update_current_node(&app).await;
        return Ok(status);
    }
    start_gui_owned(&app, state.inner()).await
}

pub(crate) async fn start_owned_for_lifecycle(app: &AppHandle) -> Result<CoreStatus, String> {
    let _lifecycle = CORE_LIFECYCLE_LOCK.lock().await;
    let state = app.state::<CoreState>();
    start_gui_owned(app, state.inner()).await
}

async fn start_gui_owned(app: &AppHandle, state: &CoreState) -> Result<CoreStatus, String> {
    let existing_status = gui_owned_status(app, state).await?;
    if existing_status.state == CoreUserState::Ready {
        set_last_error(state, None)?;
        traffic::start(app);
        logs::start(app);
        crate::tray::update_current_node(app).await;
        if let Ok(proxy_status) = crate::system_proxy::status(app).await {
            crate::tray::update_proxy_label(app, proxy_status.enabled, proxy_status.core_running);
        }
        return Ok(existing_status);
    }

    // A terminated sidecar can stop answering before its event handler has
    // restored the stable (non-TUN) configuration. Do not start a replacement
    // from that transient state; once recovery finishes the handler clears the
    // child and a retry can safely load config.yaml.
    if state
        .child
        .lock()
        .map_err(|_| "CoreState 锁异常")?
        .is_some()
    {
        return Err("Mihomo 正在执行退出恢复，请稍后重试".to_string());
    }

    if persisted_service_core_pid_if_ready(app).await?.is_some() {
        traffic::start(app);
        logs::start(app);
        crate::tray::update_current_node(app).await;
        if let Ok(proxy_status) = crate::system_proxy::status(app).await {
            crate::tray::update_proxy_label(app, proxy_status.enabled, proxy_status.core_running);
        }
        return status_for(app, CoreUserState::Ready, None);
    }

    if is_running().await {
        return Err("检测到非 MioProxy 管理的 Mihomo，拒绝接管或复用".to_string());
    }

    set_last_error(state, None)?;
    let prepared = (|| {
        let (dir, _) = runtime_paths(app)?;
        let _ = crate::config::restore_active_runtime_config_at(&dir)?;
        let config = ensure_default_config(app)?;
        crate::config::clear_actual_runtime_mixed_port_at(&dir)?;
        let mixed_port =
            crate::config::prepare_runtime_resources_at(&config, CONTROLLER, secret())?;
        Ok::<_, String>((dir, config, mixed_port))
    })();
    let (dir, config, mixed_port) = record_start_result(state, prepared)?;
    let bundled_geodata_dirs = crate::config::bundled_geodata_dirs(app);
    crate::geodata::ensure_for_candidate(&dir, &config, &bundled_geodata_dirs)
        .await
        .map_err(|error| {
            format!(
                "Mihomo 启动前 geodata 准备失败（{}）：{error}",
                crate::geodata::validation_category(&error)
            )
        })?;
    if let Err(error) = validate_gui_config(app, &dir, &config).await {
        if crate::geodata::is_geodata_error(&error) {
            let replacement = crate::geodata::replace_after_validation_failure(
                &dir,
                &config,
                &bundled_geodata_dirs,
            )
            .await
            .map_err(|repair| {
                format!(
                    "Mihomo 启动前配置校验失败（{}），geodata 修复失败：{repair}",
                    crate::geodata::validation_category(&error)
                )
            })?;
            if let Err(retry_error) = validate_gui_config(app, &dir, &config).await {
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
    let command = record_start_result(
        state,
        app.shell()
            .sidecar("mihomo")
            .map_err(|e| format!("找不到 Mihomo sidecar：{e}。请先运行 npm run mihomo:setup")),
    )?
    .args(vec![
        "-d".to_string(),
        crate::config::mihomo_path_string(&dir),
        "-f".to_string(),
        crate::config::mihomo_path_string(&config),
    ]);

    let (mut rx, child) = record_start_result(
        state,
        command.spawn().map_err(|e| format!("Mihomo 启动失败：{e}")),
    )?;
    let spawned_pid = child.pid();
    state.stop_requested.store(false, Ordering::SeqCst);
    state.ready_observed.store(false, Ordering::SeqCst);
    *state.child.lock().map_err(|_| "CoreState 锁异常")? = Some(child);
    crate::diagnostics::record_event(app, "info", "mihomo", "GUI Mihomo started");

    let exited_before_ready = Arc::new(AtomicBool::new(false));
    let exit_signal = Arc::clone(&exited_before_ready);
    let emitter = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let _ = emitter.emit("mihomo-log", String::from_utf8_lossy(&bytes).to_string());
                }
                CommandEvent::Stderr(bytes) => {
                    let _ = emitter.emit("mihomo-log", String::from_utf8_lossy(&bytes).to_string());
                }
                CommandEvent::Terminated(payload) => {
                    exit_signal.store(true, Ordering::SeqCst);
                    let _lifecycle = CORE_LIFECYCLE_LOCK.lock().await;
                    traffic::stop(&emitter);
                    logs::stop(&emitter);
                    crate::system_proxy::restore_after_core_exit(&emitter).await;
                    // Keep the child marker set until rollback is complete so a
                    // concurrent start cannot load the still-TUN-enabled config.
                    crate::tun::on_mihomo_exit(&emitter).await;
                    if let Ok((data_dir, _)) = runtime_paths(&emitter) {
                        let _ = crate::config::clear_actual_runtime_mixed_port_at(&data_dir);
                    }
                    if let Ok(mut child) = emitter.state::<CoreState>().child.lock() {
                        *child = None;
                    }
                    emitter
                        .state::<CoreState>()
                        .ready_observed
                        .store(false, Ordering::SeqCst);
                    crate::tray::update_current_node(&emitter).await;
                    let stop_requested = emitter
                        .state::<CoreState>()
                        .stop_requested
                        .swap(false, Ordering::SeqCst);
                    let abnormal =
                        payload.code.is_some_and(|code| code != 0) || payload.signal.is_some();
                    if !stop_requested && abnormal {
                        let _ = set_last_error(
                            emitter.state::<CoreState>().inner(),
                            Some("Mihomo 异常退出".to_string()),
                        );
                        crate::diagnostics::record_event(
                            &emitter,
                            "error",
                            "mihomo",
                            "Mihomo exited abnormally",
                        );
                        let _ = emitter.emit("mihomo-crashed", ());
                    } else {
                        if !abnormal {
                            let _ = set_last_error(emitter.state::<CoreState>().inner(), None);
                        }
                        crate::diagnostics::record_event(
                            &emitter,
                            "info",
                            "mihomo",
                            "Mihomo stopped",
                        );
                    }
                    let _ = emitter.emit("mihomo-stopped", ());
                }
                _ => {}
            }
        }
    });

    let mut readiness_error = None;
    let mut terminated_early = false;
    for _ in 0..50 {
        match core_ready_for_pid(mixed_port, spawned_pid).await {
            Ok(true) => {
                if exited_before_ready.load(Ordering::SeqCst) {
                    terminated_early = true;
                    break;
                }
                if let Err(error) =
                    crate::config::commit_actual_runtime_mixed_port_at(&dir, mixed_port)
                {
                    stop_child_after_failed_start(state, spawned_pid)?;
                    let error = format!("保存 Mihomo Ready 监听状态失败：{error}");
                    set_last_error(state, Some(error.clone()))?;
                    let _ = app.emit("mihomo-crashed", ());
                    return Err(error);
                }
                state.ready_observed.store(true, Ordering::SeqCst);
                traffic::start(app);
                logs::start(app);
                crate::tray::update_current_node(app).await;
                if let Ok(proxy_status) = crate::system_proxy::status(app).await {
                    crate::tray::update_proxy_label(
                        app,
                        proxy_status.enabled,
                        proxy_status.core_running,
                    );
                }
                return status_for(app, CoreUserState::Ready, None);
            }
            Ok(false) => {}
            Err(error) => readiness_error = Some(error),
        }
        if exited_before_ready.load(Ordering::SeqCst) {
            terminated_early = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    stop_child_after_failed_start(state, spawned_pid)?;
    let error = if terminated_early {
        format!("Mihomo 在达到 Ready 前退出（PID {spawned_pid}）")
    } else {
        readiness_error.map_or_else(
            || format!("Mihomo 未能在 10 秒内达到 Ready（PID {spawned_pid}）"),
            |reason| format!("Mihomo 未能在 10 秒内达到 Ready：{reason}"),
        )
    };
    set_last_error(state, Some(error.clone()))?;
    crate::diagnostics::record_event(app, "error", "mihomo", &error);
    let _ = app.emit("mihomo-crashed", ());
    Err(error)
}

#[tauri::command]
pub async fn mihomo_stop(
    app: AppHandle,
    state: State<'_, CoreState>,
) -> Result<CoreStatus, String> {
    crate::ensure_mutations_allowed(&app)?;
    if !owns_core(&app) {
        if let Some(status) =
            crate::service::request_core(&app, crate::service::ServiceCommand::Stop).await?
        {
            crate::diagnostics::record_event(
                &app,
                "info",
                "mihomo",
                "Service Mihomo stop requested",
            );
            traffic::stop(&app);
            logs::stop(&app);
            crate::system_proxy::restore_for_lifecycle(&app).await?;
            crate::tray::update_current_node(&app).await;
            return Ok(status);
        }
        if is_running().await {
            crate::diagnostics::record_event(
                &app,
                "warn",
                "mihomo",
                "Refused to stop an external Mihomo process",
            );
            return Err("当前 Mihomo 不是 MioProxy 管理，拒绝停止外部进程".to_string());
        }
    }
    traffic::stop(&app);
    logs::stop(&app);
    crate::tun::restore_for_lifecycle(&app, &app.state::<crate::tun::TunState>()).await?;
    state.stop_requested.store(true, Ordering::SeqCst);
    if let Some(child) = state.child.lock().map_err(|_| "CoreState 锁异常")?.take() {
        child.kill().map_err(|e| format!("停止 Mihomo 失败：{e}"))?;
    }
    set_last_error(state.inner(), None)?;
    state.ready_observed.store(false, Ordering::SeqCst);
    if let Ok((data_dir, _)) = runtime_paths(&app) {
        let _ = crate::config::clear_actual_runtime_mixed_port_at(&data_dir);
    }
    crate::diagnostics::record_event(&app, "info", "mihomo", "GUI Mihomo stop requested");
    crate::system_proxy::restore_for_lifecycle(&app).await?;
    crate::tray::update_current_node(&app).await;
    status_for(&app, CoreUserState::Stopped, None)
}

pub(crate) async fn stop_owned_for_update(app: &AppHandle) -> Result<(), String> {
    let _lifecycle = CORE_LIFECYCLE_LOCK.lock().await;
    if !owns_core(app) {
        return Ok(());
    }
    traffic::stop(app);
    logs::stop(app);
    crate::tun::restore_for_lifecycle(app, &app.state::<crate::tun::TunState>()).await?;
    let state = app.state::<CoreState>();
    state.stop_requested.store(true, Ordering::SeqCst);
    if let Some(child) = state.child.lock().map_err(|_| "CoreState 锁异常")?.take() {
        child
            .kill()
            .map_err(|error| format!("停止 GUI 管理的 Mihomo 失败：{error}"))?;
    }
    set_last_error(state.inner(), None)?;
    state.ready_observed.store(false, Ordering::SeqCst);
    for _ in 0..50 {
        if !is_running().await && !owns_core(app) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("GUI 管理的 Mihomo 未能在 5 秒内停止，拒绝更新".to_string())
}

#[tauri::command]
pub async fn mihomo_status(app: AppHandle) -> Result<CoreStatus, String> {
    let state = app.state::<CoreState>();
    let has_gui_child = managed_pid(state.inner())?.is_some();
    let gui_status = gui_owned_status(&app, state.inner()).await?;
    if gui_status_is_authoritative(gui_status.state, has_gui_child) {
        return Ok(gui_status);
    }
    if let Some(status) = crate::service::request_service_status(&app).await? {
        if !status.core.running && !status.owns_core {
            crate::system_proxy::restore_after_core_exit(&app).await;
        }
        return Ok(status.core);
    }
    if gui_status.state != CoreUserState::Ready
        && persisted_service_core_pid_if_ready(&app).await?.is_some()
    {
        return status_for(&app, CoreUserState::Ready, None);
    }
    Ok(gui_status)
}

#[tauri::command]
pub async fn mihomo_version() -> Result<Value, String> {
    api_get("/version").await
}

fn expected_status_string(value: &serde_yaml::Value) -> Option<String> {
    match value {
        serde_yaml::Value::String(value) => Some(value.clone()),
        serde_yaml::Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn proxy_entries_mut(value: &mut Value) -> Option<&mut serde_json::Map<String, Value>> {
    if value.get("proxies").and_then(Value::as_object).is_some() {
        value.get_mut("proxies").and_then(Value::as_object_mut)
    } else {
        value.as_object_mut()
    }
}

fn provider_entries(value: &Value) -> Option<&serde_json::Map<String, Value>> {
    value
        .get("providers")
        .and_then(Value::as_object)
        .or_else(|| value.as_object())
}

fn provider_contains_node(provider: &Value, node: &str) -> bool {
    provider
        .get("proxies")
        .and_then(Value::as_array)
        .is_some_and(|nodes| {
            nodes.iter().any(|entry| {
                entry
                    .get("name")
                    .and_then(Value::as_str)
                    .or_else(|| entry.as_str())
                    == Some(node)
            })
        })
}

fn is_actual_proxy_provider(provider: &Value) -> bool {
    matches!(
        provider.get("vehicleType").and_then(Value::as_str),
        Some("HTTP" | "File" | "Inline")
    )
}

fn explicit_provider_hint(entry: Option<&Value>) -> Option<String> {
    ["provider-name", "providerName"]
        .into_iter()
        .find_map(|key| {
            entry
                .and_then(|value| value.get(key))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
}

fn is_proxy_group_type(entry: Option<&Value>) -> bool {
    matches!(
        entry
            .and_then(|value| value.get("type"))
            .and_then(Value::as_str),
        Some(
            "Selector"
                | "URLTest"
                | "Fallback"
                | "LoadBalance"
                | "Relay"
                | "Smart"
                | "Random"
                | "Script"
        )
    )
}

fn proxy_entry_kind(entry: Option<&Value>) -> ProxyEntryKind {
    if is_proxy_group_type(entry) {
        return ProxyEntryKind::Group;
    }
    if matches!(
        entry
            .and_then(|value| value.get("type"))
            .and_then(Value::as_str),
        Some("Direct" | "Reject" | "RejectDrop" | "Pass" | "PassRule" | "Compatible")
    ) {
        return ProxyEntryKind::Builtin;
    }
    ProxyEntryKind::Ordinary
}

fn provider_source_names(
    group: &RuntimeProxyGroup,
    config: &RuntimeProxyGroupConfig,
    providers: &serde_json::Map<String, Value>,
) -> BTreeSet<String> {
    let mut sources = BTreeSet::new();
    for provider in &group.use_providers {
        if providers
            .get(provider)
            .is_some_and(is_actual_proxy_provider)
        {
            sources.insert(provider.clone());
        }
    }
    if group.include_all || group.include_all_providers {
        for provider in config.proxy_providers.keys() {
            if providers
                .get(provider)
                .is_some_and(is_actual_proxy_provider)
            {
                sources.insert(provider.clone());
            }
        }
    }
    sources
}

fn runtime_proxy_member_context(
    group: Option<&RuntimeProxyGroup>,
    config: Option<&RuntimeProxyGroupConfig>,
    provider_data: Option<&Value>,
    node: &str,
    node_entry: Option<&Value>,
) -> RuntimeProxyMemberContext {
    let kind = proxy_entry_kind(node_entry);
    if matches!(kind, ProxyEntryKind::Group | ProxyEntryKind::Builtin) {
        return RuntimeProxyMemberContext {
            kind,
            provider: None,
            provider_candidates: None,
            provider_resolution: None,
        };
    }

    let providers = provider_data.and_then(provider_entries);
    if let Some(hint) = explicit_provider_hint(node_entry) {
        if providers
            .and_then(|entries| entries.get(&hint))
            .is_some_and(|provider| {
                is_actual_proxy_provider(provider) && provider_contains_node(provider, node)
            })
        {
            return RuntimeProxyMemberContext {
                kind: ProxyEntryKind::Provider,
                provider: Some(hint),
                provider_candidates: None,
                provider_resolution: Some("resolved"),
            };
        }
        if providers.is_none() {
            return RuntimeProxyMemberContext {
                kind: ProxyEntryKind::Ordinary,
                provider: None,
                provider_candidates: None,
                provider_resolution: Some("unresolved"),
            };
        }
    }

    let Some(group) = group else {
        return RuntimeProxyMemberContext {
            kind: ProxyEntryKind::Ordinary,
            provider: None,
            provider_candidates: None,
            provider_resolution: None,
        };
    };
    let has_provider_sources =
        !group.use_providers.is_empty() || group.include_all || group.include_all_providers;
    let has_only_all_proxy_source = group.include_all_proxies && !has_provider_sources;
    if !has_provider_sources || has_only_all_proxy_source {
        return RuntimeProxyMemberContext {
            kind: ProxyEntryKind::Ordinary,
            provider: None,
            provider_candidates: None,
            provider_resolution: None,
        };
    }

    let Some(config) = config else {
        return RuntimeProxyMemberContext {
            kind: ProxyEntryKind::Ordinary,
            provider: None,
            provider_candidates: None,
            provider_resolution: Some("unresolved"),
        };
    };
    let Some(providers) = providers else {
        return RuntimeProxyMemberContext {
            kind: ProxyEntryKind::Ordinary,
            provider: None,
            provider_candidates: None,
            provider_resolution: Some("unresolved"),
        };
    };

    let sources = provider_source_names(group, config, providers);
    let candidates = sources
        .into_iter()
        .filter(|provider| {
            providers.get(provider).is_some_and(|entry| {
                is_actual_proxy_provider(entry) && provider_contains_node(entry, node)
            })
        })
        .collect::<Vec<_>>();
    let explicit_proxy_member = group.proxies.iter().any(|member| member == node);

    match candidates.as_slice() {
        [provider] if !explicit_proxy_member => RuntimeProxyMemberContext {
            kind: ProxyEntryKind::Provider,
            provider: Some(provider.clone()),
            provider_candidates: None,
            provider_resolution: Some("resolved"),
        },
        [] => RuntimeProxyMemberContext {
            kind: ProxyEntryKind::Ordinary,
            provider: None,
            provider_candidates: None,
            provider_resolution: None,
        },
        _ => RuntimeProxyMemberContext {
            kind: ProxyEntryKind::Ordinary,
            provider: None,
            provider_candidates: Some(candidates),
            provider_resolution: Some("ambiguous"),
        },
    }
}

fn merge_runtime_proxy_group_context_from_config(
    proxies: &mut Value,
    config: &RuntimeProxyGroupConfig,
    provider_data: Option<&Value>,
) {
    let Some(groups) = proxy_entries_mut(proxies) else {
        return;
    };
    let group_names = groups.keys().cloned().collect::<Vec<_>>();

    for group_name in group_names {
        let runtime_group = config
            .proxy_groups
            .iter()
            .find(|group| group.name == group_name);
        let member_names = groups
            .get(&group_name)
            .and_then(|entry| entry.get("all"))
            .and_then(Value::as_array)
            .map(|members| {
                members
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>()
            });

        let member_contexts = member_names.map(|members| {
            members
                .into_iter()
                .map(|node| {
                    let node_entry = groups.get(&node);
                    let context = runtime_proxy_member_context(
                        runtime_group,
                        Some(config),
                        provider_data,
                        &node,
                        node_entry,
                    );
                    (
                        node,
                        serde_json::to_value(context).expect("latency member context serializes"),
                    )
                })
                .collect::<serde_json::Map<_, _>>()
        });

        let Some(entry) = groups.get_mut(&group_name).and_then(Value::as_object_mut) else {
            continue;
        };
        if let Some(group) = runtime_group {
            if let Some(url) = group.url.as_ref().filter(|value| !value.trim().is_empty()) {
                entry.insert("testUrl".to_string(), Value::String(url.clone()));
            }
            if let Some(expected_status) = group
                .expected_status
                .as_ref()
                .and_then(expected_status_string)
            {
                entry.insert("expectedStatus".to_string(), Value::String(expected_status));
            }
        }
        if let Some(member_contexts) = member_contexts {
            entry.insert("memberContexts".to_string(), Value::Object(member_contexts));
        }
    }
}

#[cfg(test)]
fn merge_runtime_proxy_group_context(proxies: &mut Value, yaml: &str) {
    let Ok(config) = serde_yaml::from_str::<RuntimeProxyGroupConfig>(yaml) else {
        return;
    };
    merge_runtime_proxy_group_context_from_config(proxies, &config, None);
}

async fn authoritative_runtime_config(app: &AppHandle) -> Option<String> {
    let service_path = crate::service::request_service_status(app)
        .await
        .ok()
        .flatten()
        .and_then(|status| {
            let path = PathBuf::from(status.core.config_path.trim());
            (!path.as_os_str().is_empty() && path.is_absolute()).then_some(path)
        });
    let path = match service_path {
        Some(path) => path,
        None => runtime_paths(app).ok()?.1,
    };
    crate::config::read_text_file_at(&path, "读取 Mihomo Runtime 配置")
        .ok()
        .flatten()
}

#[tauri::command]
pub async fn mihomo_proxies(app: AppHandle) -> Result<Value, String> {
    let mut proxies = api_get("/proxies").await?;
    let provider_data = api_get("/providers/proxies").await.ok();
    let runtime_config = authoritative_runtime_config(&app)
        .await
        .and_then(|yaml| serde_yaml::from_str::<RuntimeProxyGroupConfig>(&yaml).ok());
    if let Some(config) = runtime_config.as_ref() {
        merge_runtime_proxy_group_context_from_config(&mut proxies, config, provider_data.as_ref());
    } else {
        // Keep the raw /proxies response renderable when the generated Runtime
        // is missing or stale. Explicit provider hints are still accepted only
        // after validation against /providers/proxies; no name-only identity is
        // fabricated from an unavailable Runtime source.
        let empty_config = RuntimeProxyGroupConfig::default();
        merge_runtime_proxy_group_context_from_config(
            &mut proxies,
            &empty_config,
            provider_data.as_ref(),
        );
    }
    Ok(proxies)
}

#[tauri::command]
pub async fn mihomo_rules() -> Result<Value, String> {
    api_get("/rules").await
}

#[tauri::command]
pub async fn mihomo_rule_providers() -> Result<Value, String> {
    api_get("/providers/rules").await
}

#[tauri::command]
pub async fn mihomo_rule_provider_update(app: AppHandle, name: String) -> Result<Value, String> {
    ensure_managed_core(&app).await?;
    api_put(
        &format!("/providers/rules/{}", encode_path_segment(&name)),
        Value::Null,
    )
    .await
}

fn selected_node_from_snapshot(value: &Value) -> Option<String> {
    let groups = value
        .get("proxies")
        .and_then(Value::as_object)
        .or_else(|| value.as_object())?;
    groups
        .get("PROXY")
        .and_then(|group| group.get("now"))
        .and_then(Value::as_str)
        .or_else(|| {
            groups
                .values()
                .find_map(|group| group.get("now").and_then(Value::as_str))
        })
        .map(ToOwned::to_owned)
}

pub async fn current_node() -> Option<String> {
    api_get("/proxies")
        .await
        .ok()
        .and_then(|value| selected_node_from_snapshot(&value))
}

#[tauri::command]
pub async fn mihomo_reload(app: AppHandle) -> Result<Value, String> {
    if let Some(result) = crate::service::request_reload(&app).await? {
        return Ok(result);
    }
    let (_, config) = runtime_paths(&app)?;
    if crate::config::read_text_file_at(&config, "读取 Mihomo 配置")?.is_none() {
        return Err("运行配置不存在，请等待 Core Ready".to_string());
    }
    ensure_managed_core(&app).await?;
    api_put(
        "/configs?force=true",
        serde_json::json!({ "path": crate::config::mihomo_path_string(&config) }),
    )
    .await
}

#[tauri::command]
pub async fn mihomo_select_proxy(
    app: AppHandle,
    group: String,
    proxy: String,
) -> Result<Value, String> {
    ensure_managed_core(&app).await?;
    let result = api_put(
        &format!("/proxies/{}", encode_path_segment(&group)),
        serde_json::json!({ "name": proxy }),
    )
    .await;
    if result.is_ok() {
        crate::tray::update_current_node(&app).await;
    }
    result
}

#[tauri::command]
pub async fn mihomo_proxy_delay(request: ProxyDelayRequest) -> Result<Value, String> {
    let path = delay_request_path(&request)?;
    api_get_with_timeout(&path, Duration::from_secs(DELAY_OUTER_TIMEOUT_SECS)).await
}

#[cfg(test)]
mod tests {
    use super::{
        all_ready_signals, api_get_with_timeout_at, classify_user_state, delay_request_path,
        effective_delay_url, encode_path_segment, expected_status_string,
        gui_status_is_authoritative, is_actual_proxy_provider, merge_runtime_proxy_group_context,
        merge_runtime_proxy_group_context_from_config, required_listener_ready,
        runtime_proxy_member_context, selected_node_from_snapshot, CoreStatus, CoreUserState,
        ProxyDelayRequest, ProxyEntryKind, RuntimeProxyGroupConfig, DEFAULT_DELAY_URL,
        DELAY_OUTER_TIMEOUT_SECS, DELAY_TIMEOUT_MS,
    };
    use crate::config::{ListenerOwner, TcpListenerDiagnostic};
    use serde_json::Value;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn listener(
        address_family: &str,
        local_address: &str,
        local_port: u16,
        owning_pid: Option<u32>,
        owner: ListenerOwner,
    ) -> TcpListenerDiagnostic {
        TcpListenerDiagnostic {
            address_family: address_family.to_string(),
            local_address: local_address.to_string(),
            local_port,
            state: "listen".to_string(),
            owning_pid,
            owner,
        }
    }

    fn delay_request(
        proxy: &str,
        provider: Option<&str>,
        test_url: Option<&str>,
        kind: Option<ProxyEntryKind>,
    ) -> ProxyDelayRequest {
        ProxyDelayRequest {
            group: "PROXY".to_string(),
            proxy: proxy.to_string(),
            provider: provider.map(ToOwned::to_owned),
            test_url: test_url.map(ToOwned::to_owned),
            expected_status: None,
            kind,
        }
    }

    #[test]
    fn user_state_requires_every_ready_signal() {
        assert_eq!(
            classify_user_state(Some(42), true, None),
            CoreUserState::Ready
        );
        assert_eq!(
            classify_user_state(Some(42), false, None),
            CoreUserState::Starting
        );
        assert_eq!(
            classify_user_state(None, true, None),
            CoreUserState::Stopped
        );
        assert_eq!(
            classify_user_state(None, false, None),
            CoreUserState::Stopped
        );
        assert_eq!(
            classify_user_state(Some(42), false, Some("health failed")),
            CoreUserState::Error
        );
        assert_eq!(
            classify_user_state(None, false, Some("start failed")),
            CoreUserState::Error
        );
    }

    #[test]
    fn ready_requires_pid_both_authenticated_endpoints_and_listener() {
        assert!(all_ready_signals(true, true, true, true));
        assert!(!all_ready_signals(false, true, true, true));
        assert!(!all_ready_signals(true, false, true, true));
        assert!(!all_ready_signals(true, true, false, true));
        assert!(!all_ready_signals(true, true, true, false));
    }

    #[test]
    fn gui_child_status_wins_over_a_recovered_non_owner_service() {
        assert!(gui_status_is_authoritative(CoreUserState::Ready, false));
        assert!(gui_status_is_authoritative(CoreUserState::Starting, false));
        assert!(gui_status_is_authoritative(CoreUserState::Error, true));
        assert!(!gui_status_is_authoritative(CoreUserState::Stopped, false));
        assert!(!gui_status_is_authoritative(CoreUserState::Error, false));
    }

    #[test]
    fn ready_listener_must_be_owned_ipv4_loopback_or_wildcard() {
        let loopback = listener(
            "ipv4",
            "127.0.0.1",
            7890,
            Some(42),
            ListenerOwner::MioProxyManaged,
        );
        let wildcard = listener(
            "ipv4",
            "0.0.0.0",
            7890,
            Some(42),
            ListenerOwner::MioProxyManaged,
        );
        assert!(required_listener_ready(&[loopback], 7890, 42));
        assert!(required_listener_ready(&[wildcard], 7890, 42));
    }

    #[test]
    fn ipv6_only_external_or_wrong_listener_never_counts_as_ready() {
        let listeners = [
            listener(
                "ipv6",
                "::1",
                7890,
                Some(42),
                ListenerOwner::MioProxyManaged,
            ),
            listener("ipv4", "127.0.0.1", 7890, Some(43), ListenerOwner::External),
            listener(
                "ipv4",
                "192.0.2.1",
                7890,
                Some(42),
                ListenerOwner::MioProxyManaged,
            ),
            listener(
                "ipv4",
                "127.0.0.1",
                7891,
                Some(42),
                ListenerOwner::MioProxyManaged,
            ),
        ];
        assert!(!required_listener_ready(&listeners, 7890, 42));
    }

    #[test]
    fn core_status_serializes_the_four_lowercase_states() {
        for (state, expected) in [
            (CoreUserState::Stopped, "stopped"),
            (CoreUserState::Starting, "starting"),
            (CoreUserState::Ready, "ready"),
            (CoreUserState::Error, "error"),
        ] {
            let status = CoreStatus {
                state,
                running: state == CoreUserState::Ready,
                controller: "127.0.0.1:19090".to_string(),
                config_path: "config.yaml".to_string(),
                mixed_port: 7890,
                mode: "rule".to_string(),
                recovery_message: None,
            };
            let value = serde_json::to_value(status).unwrap();
            assert_eq!(value["state"], expected);
            assert_eq!(value["running"], state == CoreUserState::Ready);
        }
    }

    #[test]
    fn selected_node_prefers_proxy_group() {
        let snapshot = serde_json::json!({
            "proxies": {
                "AUTO": { "now": "auto-node" },
                "PROXY": { "now": "selected-node" }
            }
        });
        assert_eq!(
            selected_node_from_snapshot(&snapshot).as_deref(),
            Some("selected-node")
        );
    }

    #[test]
    fn selected_node_falls_back_to_first_group_with_now() {
        let nested = serde_json::json!({
            "proxies": {
                "DIRECT": { "type": "Direct" },
                "PROXY": { "type": "Selector" },
                "PRIMARY": { "now": "profile-node" }
            }
        });
        let legacy_root = serde_json::json!({
            "PRIMARY": { "now": "legacy-node" }
        });
        assert_eq!(
            selected_node_from_snapshot(&nested).as_deref(),
            Some("profile-node")
        );
        assert_eq!(
            selected_node_from_snapshot(&legacy_root).as_deref(),
            Some("legacy-node")
        );
    }

    #[test]
    fn ordinary_delay_path_uses_proxy_endpoint_and_keeps_mihomo_timeout() {
        let mut request = delay_request(
            "ordinary node",
            None,
            Some("https://example.test/ping?a=b&c=d"),
            Some(ProxyEntryKind::Ordinary),
        );
        request.expected_status = Some("204".to_string());
        let path = delay_request_path(&request).expect("ordinary delay path");

        assert!(path.starts_with("/proxies/ordinary%20node/delay?"));
        assert!(path.contains("url=https%3A%2F%2Fexample.test%2Fping%3Fa%3Db%26c%3Dd"));
        assert!(path.contains("timeout=5000"));
        assert!(path.ends_with("&expected=204"));
    }

    #[test]
    fn provider_delay_path_encodes_provider_and_proxy_as_independent_segments() {
        let provider = "提供 者/alpha?beta";
        let proxy = "节点 /alpha?beta";
        let path = delay_request_path(&delay_request(
            proxy,
            Some(provider),
            None,
            Some(ProxyEntryKind::Provider),
        ))
        .expect("provider delay path");
        let expected_prefix = format!(
            "/providers/proxies/{}/{}/healthcheck?",
            encode_path_segment(provider),
            encode_path_segment(proxy),
        );

        assert!(path.starts_with(&expected_prefix));
        assert!(!path.contains("/alpha?beta"));
        assert!(path.contains("timeout=5000"));
    }

    #[test]
    fn group_and_builtin_entries_do_not_use_provider_healthcheck_even_with_stale_metadata() {
        for kind in [ProxyEntryKind::Group, ProxyEntryKind::Builtin] {
            let path = delay_request_path(&delay_request(
                "nested entry",
                Some("provider-that-must-not-be-used"),
                None,
                Some(kind),
            ))
            .expect("ordinary nested/builtin delay path");
            assert!(path.starts_with("/proxies/nested%20entry/delay?"));
        }
    }

    #[test]
    fn delay_url_falls_back_to_https_gstatic() {
        assert_eq!(effective_delay_url(None), DEFAULT_DELAY_URL);
        assert_eq!(effective_delay_url(Some("")), DEFAULT_DELAY_URL);
        assert_eq!(effective_delay_url(Some("  ")), DEFAULT_DELAY_URL);
        assert_eq!(
            effective_delay_url(Some(" https://delay.example.test/204 ")),
            "https://delay.example.test/204"
        );
    }

    #[test]
    fn runtime_proxy_group_config_is_exposed_as_latency_context() {
        let mut proxies = serde_json::json!({
            "proxies": {
                "AUTO": { "type": "URLTest", "history": [] },
                "PROXY": { "type": "Selector", "history": [] }
            }
        });
        merge_runtime_proxy_group_context(
            &mut proxies,
            r#"
proxy-groups:
  - name: AUTO
    type: url-test
    url: https://group.example.test/204
    expected-status: 204
  - name: PROXY
    type: select
"#,
        );

        assert_eq!(
            proxies["proxies"]["AUTO"]["testUrl"],
            "https://group.example.test/204"
        );
        assert_eq!(proxies["proxies"]["AUTO"]["expectedStatus"], "204");
        assert!(proxies["proxies"]["PROXY"].get("testUrl").is_none());
        assert_eq!(
            expected_status_string(&serde_yaml::Value::Number(204.into())),
            Some("204".to_string())
        );
    }

    fn provider_group_fixture() -> (Value, RuntimeProxyGroupConfig, Value) {
        let proxies = serde_json::json!({
            "proxies": {
                "PROXY": {
                    "type": "Selector",
                    "all": ["HK-1", "DIRECT"],
                    "history": []
                },
                "HK-1": {"type": "Vless", "provider-name": ""},
                "DIRECT": {"type": "Direct"}
            }
        });
        let config = serde_yaml::from_str::<RuntimeProxyGroupConfig>(
            r#"
proxy-providers:
  PROXY:
    type: http
proxy-groups:
  - name: PROXY
    type: select
    use: [PROXY]
    proxies: [DIRECT]
"#,
        )
        .expect("provider group config");
        let providers = serde_json::json!({
            "providers": {
                "PROXY": {
                    "vehicleType": "HTTP",
                    "proxies": [{"name": "HK-1"}]
                },
                "default": {
                    "vehicleType": "Compatible",
                    "proxies": [{"name": "HK-1"}]
                }
            }
        });
        (proxies, config, providers)
    }

    #[test]
    fn actual_proxy_provider_vehicle_types_are_whitelisted() {
        for vehicle_type in ["HTTP", "File", "Inline"] {
            let provider = serde_json::json!({"vehicleType": vehicle_type});
            assert!(is_actual_proxy_provider(&provider), "{vehicle_type}");
        }
    }

    #[test]
    fn synthetic_missing_and_unknown_vehicle_types_are_not_actual_providers() {
        for provider in [
            serde_json::json!({"vehicleType": "Compatible"}),
            serde_json::json!({}),
            serde_json::json!({"vehicleType": "Other"}),
        ] {
            assert!(!is_actual_proxy_provider(&provider));
        }
    }

    #[test]
    fn empty_provider_name_resolves_from_group_use_source() {
        let (mut proxies, config, providers) = provider_group_fixture();
        merge_runtime_proxy_group_context_from_config(&mut proxies, &config, Some(&providers));

        assert_eq!(
            proxies["proxies"]["PROXY"]["memberContexts"]["HK-1"]["kind"],
            "provider"
        );
        assert_eq!(
            proxies["proxies"]["PROXY"]["memberContexts"]["HK-1"]["provider"],
            "PROXY"
        );
        assert_eq!(
            proxies["proxies"]["PROXY"]["memberContexts"]["HK-1"]["providerResolution"],
            "resolved"
        );
    }

    #[test]
    fn duplicate_provider_membership_does_not_override_group_use_source() {
        let (mut proxies, config, providers) = provider_group_fixture();
        merge_runtime_proxy_group_context_from_config(&mut proxies, &config, Some(&providers));

        let context = &proxies["proxies"]["PROXY"]["memberContexts"]["HK-1"];
        assert_eq!(context["provider"], "PROXY");
        assert_ne!(context["provider"], "default");
        assert_eq!(context["providerCandidates"], Value::Null);
    }

    #[test]
    fn explicit_provider_hints_require_an_actual_provider_vehicle_type() {
        let compatible_providers = serde_json::json!({
            "providers": {
                "default": {
                    "vehicleType": "Compatible",
                    "proxies": [{"name": "same node"}]
                }
            }
        });
        let compatible_node = serde_json::json!({
            "type": "Vless",
            "provider-name": "default"
        });
        let compatible_context = runtime_proxy_member_context(
            None,
            None,
            Some(&compatible_providers),
            "same node",
            Some(&compatible_node),
        );
        assert_eq!(compatible_context.kind, ProxyEntryKind::Ordinary);
        assert_eq!(compatible_context.provider, None);

        let actual_providers = serde_json::json!({
            "providers": {
                "provider-a": {
                    "vehicleType": "HTTP",
                    "proxies": [{"name": "same node"}]
                }
            }
        });
        let actual_node = serde_json::json!({
            "type": "Vless",
            "providerName": "provider-a"
        });
        let actual_context = runtime_proxy_member_context(
            None,
            None,
            Some(&actual_providers),
            "same node",
            Some(&actual_node),
        );
        assert_eq!(actual_context.kind, ProxyEntryKind::Provider);
        assert_eq!(actual_context.provider.as_deref(), Some("provider-a"));
    }

    #[test]
    fn compatible_only_node_uses_the_ordinary_delay_endpoint() {
        let config = serde_yaml::from_str::<RuntimeProxyGroupConfig>(
            r#"
proxy-groups:
  - name: AUTO
    type: select
    use: [default]
"#,
        )
        .expect("compatible-only group config");
        let providers = serde_json::json!({
            "providers": {
                "default": {
                    "vehicleType": "Compatible",
                    "proxies": [{"name": "same node"}]
                }
            }
        });
        let node = serde_json::json!({"type": "Vless", "provider-name": ""});
        let context = runtime_proxy_member_context(
            config.proxy_groups.first(),
            Some(&config),
            Some(&providers),
            "same node",
            Some(&node),
        );

        assert_eq!(context.kind, ProxyEntryKind::Ordinary);
        assert_eq!(context.provider, None);

        let path = delay_request_path(&delay_request(
            "same node",
            context.provider.as_deref(),
            None,
            Some(context.kind),
        ))
        .expect("ordinary delay path");
        assert!(path.starts_with("/proxies/same%20node/delay?"));
    }

    #[test]
    fn live_style_compatible_providers_do_not_create_artificial_ambiguity() {
        let config = serde_yaml::from_str::<RuntimeProxyGroupConfig>(
            r#"
proxy-providers:
  PROXY:
    type: http
proxy-groups:
  - name: AUTO
    type: select
    use: [PROXY]
"#,
        )
        .expect("live-style group config");
        let providers = serde_json::json!({
            "providers": {
                "PROXY": {
                    "vehicleType": "Compatible",
                    "proxies": [{"name": "HK-1"}, {"name": "SG-1"}]
                },
                "default": {
                    "vehicleType": "Compatible",
                    "proxies": [{"name": "HK-1"}, {"name": "SG-1"}]
                }
            }
        });

        for node_name in ["HK-1", "SG-1"] {
            let node = serde_json::json!({"type": "Vless", "provider-name": ""});
            let context = runtime_proxy_member_context(
                config.proxy_groups.first(),
                Some(&config),
                Some(&providers),
                node_name,
                Some(&node),
            );

            assert_eq!(context.kind, ProxyEntryKind::Ordinary);
            assert_eq!(context.provider, None);
            assert_eq!(context.provider_candidates, None);
            assert_ne!(context.provider_resolution, Some("ambiguous"));
        }
    }

    #[test]
    fn group_generated_compatible_provider_named_proxy_is_ordinary() {
        let config = serde_yaml::from_str::<RuntimeProxyGroupConfig>(
            r#"
proxy-groups:
  - name: PROXY
    type: select
    proxies: [HK-1]
"#,
        )
        .expect("group-generated provider config");
        let providers = serde_json::json!({
            "providers": {
                "PROXY": {
                    "vehicleType": "Compatible",
                    "proxies": [{"name": "HK-1"}]
                },
                "default": {
                    "vehicleType": "Compatible",
                    "proxies": [{"name": "HK-1"}]
                }
            }
        });
        let node = serde_json::json!({"type": "Vless", "provider-name": ""});
        let context = runtime_proxy_member_context(
            config.proxy_groups.first(),
            Some(&config),
            Some(&providers),
            "HK-1",
            Some(&node),
        );

        assert_eq!(context.kind, ProxyEntryKind::Ordinary);
        assert_eq!(context.provider, None);
    }

    #[test]
    fn multiple_eligible_providers_remain_ambiguous() {
        let mut proxies = serde_json::json!({
            "proxies": {
                "AUTO": {"type": "Selector", "all": ["same node"]},
                "same node": {"type": "Vless", "provider-name": ""}
            }
        });
        let config = serde_yaml::from_str::<RuntimeProxyGroupConfig>(
            r#"
proxy-providers:
  provider-a: {type: http}
  provider-b: {type: file}
proxy-groups:
  - name: AUTO
    type: select
    use: [provider-a, provider-b]
"#,
        )
        .expect("ambiguous provider config");
        let providers = serde_json::json!({
            "providers": {
                "provider-a": {
                    "vehicleType": "HTTP",
                    "proxies": [{"name": "same node"}]
                },
                "provider-b": {
                    "vehicleType": "File",
                    "proxies": [{"name": "same node"}]
                }
            }
        });

        merge_runtime_proxy_group_context_from_config(&mut proxies, &config, Some(&providers));

        let context = &proxies["proxies"]["AUTO"]["memberContexts"]["same node"];
        assert_eq!(context["kind"], "ordinary");
        assert_eq!(context["provider"], Value::Null);
        assert_eq!(context["providerResolution"], "ambiguous");
        assert_eq!(
            context["providerCandidates"],
            serde_json::json!(["provider-a", "provider-b"])
        );
    }

    #[test]
    fn include_all_provider_sources_ignore_compatible_entries() {
        for include_key in ["include-all", "include-all-providers"] {
            let mut proxies = serde_json::json!({
                "proxies": {
                    "AUTO": {"type": "Selector", "all": ["same node"]},
                    "same node": {"type": "Vless", "provider-name": ""}
                }
            });
            let yaml = format!(
                r#"
proxy-providers:
  PROXY: {{type: http}}
proxy-groups:
  - name: AUTO
    type: select
    {include_key}: true
"#
            );
            let config = serde_yaml::from_str::<RuntimeProxyGroupConfig>(&yaml)
                .expect("include-all provider config");
            let providers = serde_json::json!({
                "providers": {
                    "PROXY": {
                        "vehicleType": "HTTP",
                        "proxies": [{"name": "same node"}]
                    },
                    "default": {
                        "vehicleType": "Compatible",
                        "proxies": [{"name": "same node"}]
                    }
                }
            });

            merge_runtime_proxy_group_context_from_config(&mut proxies, &config, Some(&providers));

            let context = &proxies["proxies"]["AUTO"]["memberContexts"]["same node"];
            assert_eq!(context["kind"], "provider");
            assert_eq!(context["provider"], "PROXY");
            assert_eq!(context["providerResolution"], "resolved");
            assert_eq!(context["providerCandidates"], Value::Null);
        }
    }

    #[test]
    fn group_source_context_separates_provider_and_ordinary_same_name() {
        let mut proxies = serde_json::json!({
            "proxies": {
                "PROVIDER-GROUP": {"type": "Selector", "all": ["same node"]},
                "ORDINARY-GROUP": {"type": "Selector", "all": ["same node"]},
                "same node": {"type": "Vless", "provider-name": ""}
            }
        });
        let config = serde_yaml::from_str::<RuntimeProxyGroupConfig>(
            r#"
proxy-providers:
  provider-a: {type: http}
proxy-groups:
  - name: PROVIDER-GROUP
    type: select
    use: [provider-a]
  - name: ORDINARY-GROUP
    type: select
    proxies: [same node]
"#,
        )
        .expect("same-name config");
        let providers = serde_json::json!({
            "providers": {
                "provider-a": {
                    "vehicleType": "HTTP",
                    "proxies": [{"name": "same node"}]
                }
            }
        });

        merge_runtime_proxy_group_context_from_config(&mut proxies, &config, Some(&providers));

        assert_eq!(
            proxies["proxies"]["PROVIDER-GROUP"]["memberContexts"]["same node"]["provider"],
            "provider-a"
        );
        assert_eq!(
            proxies["proxies"]["ORDINARY-GROUP"]["memberContexts"]["same node"]["kind"],
            "ordinary"
        );
        assert_eq!(
            proxies["proxies"]["ORDINARY-GROUP"]["memberContexts"]["same node"]["provider"],
            Value::Null
        );
    }

    #[test]
    fn nested_group_and_builtin_members_keep_their_kinds() {
        let mut proxies = serde_json::json!({
            "proxies": {
                "OUTER": {
                    "type": "Selector",
                    "all": ["NESTED", "DIRECT"]
                },
                "NESTED": {"type": "URLTest", "all": ["node"]},
                "DIRECT": {"type": "Direct"},
                "node": {"type": "Vless", "provider-name": ""}
            }
        });
        let config = serde_yaml::from_str::<RuntimeProxyGroupConfig>(
            r#"
proxy-groups:
  - name: OUTER
    type: select
    proxies: [NESTED, DIRECT]
  - name: NESTED
    type: url-test
    proxies: [node]
"#,
        )
        .expect("nested group config");

        merge_runtime_proxy_group_context_from_config(&mut proxies, &config, None);

        assert_eq!(
            proxies["proxies"]["OUTER"]["memberContexts"]["NESTED"]["kind"],
            "group"
        );
        assert_eq!(
            proxies["proxies"]["OUTER"]["memberContexts"]["DIRECT"]["kind"],
            "builtin"
        );
    }

    #[test]
    fn unavailable_or_stale_runtime_config_does_not_fabricate_provider_identity() {
        let (mut proxies, _config, providers) = provider_group_fixture();
        let before = proxies.clone();
        merge_runtime_proxy_group_context(&mut proxies, "proxy-groups: [");
        assert_eq!(proxies, before);

        let empty_config = RuntimeProxyGroupConfig::default();
        merge_runtime_proxy_group_context_from_config(
            &mut proxies,
            &empty_config,
            Some(&providers),
        );
        assert_eq!(
            proxies["proxies"]["PROXY"]["memberContexts"]["HK-1"]["kind"],
            "ordinary"
        );
        assert_eq!(
            proxies["proxies"]["PROXY"]["memberContexts"]["HK-1"]["provider"],
            Value::Null
        );
    }

    #[test]
    fn controller_timeout_is_above_mihomo_delay_timeout() {
        assert!(std::hint::black_box(DELAY_OUTER_TIMEOUT_SECS) * 1_000 > DELAY_TIMEOUT_MS);
    }

    #[tokio::test]
    async fn mocked_504_is_reported_for_normal_endpoint_but_provider_healthcheck_can_succeed() {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind mock controller");
        let address = listener.local_addr().expect("mock controller address");
        let server = tokio::spawn(async move {
            let mut paths = Vec::new();
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.expect("accept mock request");
                let mut buffer = vec![0_u8; 4_096];
                let length = stream.read(&mut buffer).await.expect("read mock request");
                let request = String::from_utf8_lossy(&buffer[..length]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or_default()
                    .to_string();
                paths.push(path.clone());
                if path.starts_with("/providers/proxies/") {
                    let body = r#"{"delay":321}"#;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(), body
                    );
                    stream
                        .write_all(response.as_bytes())
                        .await
                        .expect("write provider response");
                } else {
                    stream
                        .write_all(b"HTTP/1.1 504 Gateway Timeout\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .await
                        .expect("write normal timeout response");
                }
            }
            paths
        });
        let base_url = format!("http://{address}");

        let normal_request = delay_request("ordinary", None, None, Some(ProxyEntryKind::Ordinary));
        let normal_path = delay_request_path(&normal_request).expect("normal path");
        let normal_result = api_get_with_timeout_at(
            &base_url,
            &normal_path,
            Duration::from_secs(1),
            "test-token",
        )
        .await;
        assert!(normal_result
            .expect_err("normal endpoint must surface 504")
            .contains("504"));

        let provider_request = delay_request(
            "provider node",
            Some("provider"),
            None,
            Some(ProxyEntryKind::Provider),
        );
        let provider_path = delay_request_path(&provider_request).expect("provider path");
        let provider_result = api_get_with_timeout_at(
            &base_url,
            &provider_path,
            Duration::from_secs(1),
            "test-token",
        )
        .await
        .expect("provider healthcheck response");
        assert_eq!(provider_result["delay"].as_u64(), Some(321));

        let paths = server.await.expect("mock controller task");
        assert_eq!(paths.len(), 2);
        assert!(paths[0].starts_with("/proxies/ordinary/delay?"));
        assert!(paths[1].starts_with("/providers/proxies/provider/provider%20node/healthcheck?"));
    }

    #[tokio::test]
    async fn mocked_controller_timeout_is_reported_as_an_error() {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind mock controller");
        let address = listener.local_addr().expect("mock controller address");
        let server = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.expect("accept mock request");
            tokio::time::sleep(Duration::from_millis(100)).await;
        });

        let result = api_get_with_timeout_at(
            &format!("http://{address}"),
            "/proxies/node/delay?url=https%3A%2F%2Fwww.gstatic.com%2Fgenerate_204&timeout=5000",
            Duration::from_millis(20),
            "test-token",
        )
        .await;
        assert!(result.is_err());
        server.await.expect("mock controller task");
    }
}
