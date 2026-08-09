use std::{
    fs,
    io::{ErrorKind, Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
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

pub(crate) const CONTROLLER: &str = "127.0.0.1:9090";
const CONTROLLER_SECRET_FILE: &str = "controller-secret";
const LEGACY_CONTROLLER_SECRET: &str = "mioproxy-v01-local";
const DEFAULT_DELAY_URL: &str = "https://www.gstatic.com/generate_204";
static CONTROLLER_SECRET: OnceLock<String> = OnceLock::new();
// Keep fallback-core startup and termination recovery in one lifecycle critical
// section. In particular, `child` must not be cleared until TUN rollback is done.
static CORE_LIFECYCLE_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());

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
                    {
                        drop(file);
                        let cleanup = fs::remove_file(&path);
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
}

impl Default for CoreState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            stop_requested: AtomicBool::new(false),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    pub running: bool,
    pub controller: String,
    pub config_path: String,
    pub mixed_port: u16,
    pub mode: String,
}

#[derive(Deserialize)]
struct RuntimeConfig {
    #[serde(rename = "mixed-port")]
    mixed_port: Option<u16>,
    mode: Option<String>,
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

    if !config.exists() {
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
        fs::write(&config, yaml).map_err(|e| e.to_string())?;
    }

    Ok(config)
}

pub(crate) async fn api_get(path: &str) -> Result<Value, String> {
    api_get_with_timeout(path, Duration::from_secs(2)).await
}

async fn api_get_with_timeout(path: &str, timeout: Duration) -> Result<Value, String> {
    let url = format!("http://{CONTROLLER}{path}");
    Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?
        .get(url)
        .bearer_auth(secret())
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
    let response = Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?
        .put(url)
        .bearer_auth(bearer)
        .json(&payload)
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

pub(crate) async fn api_put(path: &str, payload: Value) -> Result<Value, String> {
    api_put_with_secret(path, payload, secret()).await
}

async fn migrate_legacy_controller_session(app: &AppHandle) -> Result<bool, String> {
    let (_, config) = runtime_paths(app)?;
    if !config.exists() {
        return Ok(false);
    }
    let payload = serde_json::json!({ "path": config.display().to_string() });
    if api_put_with_secret("/configs?force=true", payload, LEGACY_CONTROLLER_SECRET)
        .await
        .is_err()
    {
        return Ok(false);
    }
    for _ in 0..20 {
        if is_running().await {
            return Ok(true);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("检测到旧版 Mihomo 会话，但切换 Controller 令牌后仍无法连接".to_string())
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

pub(crate) async fn is_running() -> bool {
    api_get("/version").await.is_ok()
}

pub(crate) fn owns_core<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<CoreState>()
        .and_then(|state| state.child.lock().ok().map(|child| child.is_some()))
        .unwrap_or(false)
}

pub(crate) fn mixed_port(app: &AppHandle) -> Result<u16, String> {
    let (_, config) = runtime_paths(app)?;
    if !config.exists() {
        return Ok(7890);
    }
    let content = fs::read_to_string(&config).map_err(|e| e.to_string())?;
    let runtime = serde_yaml::from_str::<RuntimeConfig>(&content)
        .map_err(|e| format!("读取 Mihomo mixed-port 失败：{e}"))?;
    Ok(runtime.mixed_port.unwrap_or(7890))
}

fn mode(app: &AppHandle) -> Result<String, String> {
    let (_, config) = runtime_paths(app)?;
    if !config.exists() {
        return Ok("rule".to_string());
    }
    let content = fs::read_to_string(&config).map_err(|e| e.to_string())?;
    let runtime = serde_yaml::from_str::<RuntimeConfig>(&content)
        .map_err(|e| format!("读取 Mihomo mode 失败：{e}"))?;
    Ok(runtime.mode.unwrap_or_else(|| "rule".to_string()))
}

fn status_for(app: &AppHandle, running: bool) -> Result<CoreStatus, String> {
    let (_, config) = runtime_paths(app)?;
    Ok(CoreStatus {
        running,
        controller: CONTROLLER.to_string(),
        config_path: config.display().to_string(),
        mixed_port: mixed_port(app)?,
        mode: mode(app)?,
    })
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
    if is_running().await {
        traffic::start(app);
        logs::start(app);
        crate::tray::update_current_node(app).await;
        if let Ok(proxy_status) = crate::system_proxy::status(app).await {
            crate::tray::update_proxy_label(app, proxy_status.enabled, proxy_status.core_running);
        }
        return status_for(app, true);
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

    if migrate_legacy_controller_session(app).await? {
        traffic::start(app);
        logs::start(app);
        crate::tray::update_current_node(app).await;
        return status_for(app, true);
    }

    let config = ensure_default_config(app)?;
    let dir = config.parent().ok_or("无法确定配置目录")?.to_path_buf();
    let command = app
        .shell()
        .sidecar("mihomo")
        .map_err(|e| format!("找不到 Mihomo sidecar：{e}。请先运行 npm run mihomo:setup"))?
        .args(vec![
            "-d".to_string(),
            dir.display().to_string(),
            "-f".to_string(),
            config.display().to_string(),
        ]);

    let (mut rx, child) = command
        .spawn()
        .map_err(|e| format!("Mihomo 启动失败：{e}"))?;
    state.stop_requested.store(false, Ordering::SeqCst);
    *state.child.lock().map_err(|_| "CoreState 锁异常")? = Some(child);
    traffic::start(app);
    logs::start(app);

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
                    let _lifecycle = CORE_LIFECYCLE_LOCK.lock().await;
                    traffic::stop(&emitter);
                    logs::stop(&emitter);
                    crate::system_proxy::restore_after_core_exit(&emitter).await;
                    // Keep the child marker set until rollback is complete so a
                    // concurrent start cannot load the still-TUN-enabled config.
                    crate::tun::on_mihomo_exit(&emitter).await;
                    if let Ok(mut child) = emitter.state::<CoreState>().child.lock() {
                        *child = None;
                    }
                    crate::tray::update_current_node(&emitter).await;
                    let stop_requested = emitter
                        .state::<CoreState>()
                        .stop_requested
                        .swap(false, Ordering::SeqCst);
                    if !stop_requested
                        && (payload.code.is_some_and(|code| code != 0) || payload.signal.is_some())
                    {
                        let _ = emitter.emit("mihomo-crashed", ());
                    }
                    let _ = emitter.emit("mihomo-stopped", ());
                }
                _ => {}
            }
        }
    });

    let tray_app = app.clone();
    tauri::async_runtime::spawn(async move {
        for _ in 0..10 {
            if is_running().await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        crate::tray::update_current_node(&tray_app).await;
        if let Ok(proxy_status) = crate::system_proxy::status(&tray_app).await {
            crate::tray::update_proxy_label(
                &tray_app,
                proxy_status.enabled,
                proxy_status.core_running,
            );
        }
    });

    status_for(app, true)
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
            traffic::stop(&app);
            logs::stop(&app);
            crate::system_proxy::restore_for_lifecycle(&app).await?;
            crate::tray::update_current_node(&app).await;
            return Ok(status);
        }
    }
    traffic::stop(&app);
    logs::stop(&app);
    crate::tun::restore_for_lifecycle(&app, &app.state::<crate::tun::TunState>()).await?;
    state.stop_requested.store(true, Ordering::SeqCst);
    if let Some(child) = state.child.lock().map_err(|_| "CoreState 锁异常")?.take() {
        child.kill().map_err(|e| format!("停止 Mihomo 失败：{e}"))?;
    }
    crate::system_proxy::restore_for_lifecycle(&app).await?;
    crate::tray::update_current_node(&app).await;
    status_for(&app, false)
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
    if let Some(status) = crate::service::request_service_status(&app).await? {
        if !status.core.running && !status.owns_core {
            crate::system_proxy::restore_after_core_exit(&app).await;
        }
        return Ok(status.core);
    }
    status_for(&app, is_running().await)
}

#[tauri::command]
pub async fn mihomo_version() -> Result<Value, String> {
    api_get("/version").await
}

#[tauri::command]
pub async fn mihomo_proxies() -> Result<Value, String> {
    api_get("/proxies").await
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
pub async fn mihomo_rule_provider_update(name: String) -> Result<Value, String> {
    api_put(
        &format!("/providers/rules/{}", encode_path_segment(&name)),
        Value::Null,
    )
    .await
}

pub async fn current_node() -> Option<String> {
    api_get("/proxies").await.ok().and_then(|value| {
        value
            .get("PROXY")
            .and_then(|group| group.get("now"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    })
}

#[tauri::command]
pub async fn mihomo_reload(app: AppHandle) -> Result<Value, String> {
    if let Some(result) = crate::service::request_reload(&app).await? {
        return Ok(result);
    }
    let (_, config) = runtime_paths(&app)?;
    if !config.exists() {
        return Err("运行配置不存在，请先启动内核".to_string());
    }
    api_put(
        "/configs?force=true",
        serde_json::json!({ "path": config.display().to_string() }),
    )
    .await
}

#[tauri::command]
pub async fn mihomo_select_proxy(
    app: AppHandle,
    group: String,
    proxy: String,
) -> Result<Value, String> {
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
pub async fn mihomo_proxy_delay(proxy: String, url: Option<String>) -> Result<Value, String> {
    let target = url.unwrap_or_else(|| DEFAULT_DELAY_URL.to_string());
    api_get_with_timeout(
        &format!(
            "/proxies/{}/delay?url={}&timeout=5000",
            encode_path_segment(&proxy),
            encode_path_segment(&target),
        ),
        Duration::from_secs(7),
    )
    .await
}
