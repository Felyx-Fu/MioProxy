use std::{fs, sync::Mutex, time::Duration};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

use super::{logs, traffic};

pub(crate) const CONTROLLER: &str = "127.0.0.1:9090";
pub(crate) const SECRET: &str = "mioproxy-v01-local";
const DEFAULT_DELAY_URL: &str = "https://www.gstatic.com/generate_204";

pub struct CoreState {
    pub child: Mutex<Option<CommandChild>>,
}

impl Default for CoreState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    running: bool,
    controller: String,
    config_path: String,
    mixed_port: u16,
    mode: String,
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
            secret = SECRET,
        );
        fs::write(&config, yaml).map_err(|e| e.to_string())?;
    }

    Ok(config)
}

pub(crate) async fn api_get(path: &str) -> Result<Value, String> {
    let url = format!("http://{CONTROLLER}{path}");
    Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?
        .get(url)
        .bearer_auth(SECRET)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json::<Value>()
        .await
        .map_err(|e| e.to_string())
}

pub(crate) async fn api_put(path: &str, payload: Value) -> Result<Value, String> {
    let url = format!("http://{CONTROLLER}{path}");
    let response = Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?
        .put(url)
        .bearer_auth(SECRET)
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

pub(crate) async fn api_delete(path: &str) -> Result<Value, String> {
    let url = format!("http://{CONTROLLER}{path}");
    let response = Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?
        .delete(url)
        .bearer_auth(SECRET)
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
    if is_running().await {
        traffic::start(&app);
        logs::start(&app);
        crate::tray::update_current_node(&app).await;
        if let Ok(proxy_status) = crate::system_proxy::status(&app).await {
            crate::tray::update_proxy_label(&app, proxy_status.enabled, proxy_status.core_running);
        }
        return status_for(&app, true);
    }

    let config = ensure_default_config(&app)?;
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
    *state.child.lock().map_err(|_| "CoreState 锁异常")? = Some(child);
    traffic::start(&app);
    logs::start(&app);

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
                CommandEvent::Terminated(_) => {
                    if let Ok(mut child) = emitter.state::<CoreState>().child.lock() {
                        *child = None;
                    }
                    traffic::stop(&emitter);
                    logs::stop(&emitter);
                    crate::system_proxy::restore_after_core_exit(&emitter).await;
                    crate::tray::update_current_node(&emitter).await;
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

    Ok(status_for(&app, true)?)
}

#[tauri::command]
pub async fn mihomo_stop(
    app: AppHandle,
    state: State<'_, CoreState>,
) -> Result<CoreStatus, String> {
    traffic::stop(&app);
    logs::stop(&app);
    if let Some(child) = state.child.lock().map_err(|_| "CoreState 锁异常")?.take() {
        child.kill().map_err(|e| format!("停止 Mihomo 失败：{e}"))?;
    }
    crate::system_proxy::restore_for_lifecycle(&app).await?;
    crate::tray::update_current_node(&app).await;
    Ok(status_for(&app, false)?)
}

#[tauri::command]
pub async fn mihomo_status(app: AppHandle) -> Result<CoreStatus, String> {
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
    api_get(&format!(
        "/proxies/{}/delay?url={}&timeout=5000",
        encode_path_segment(&proxy),
        encode_path_segment(&target),
    ))
    .await
}
