use std::{fs, sync::Mutex, time::Duration};

use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::{process::{CommandChild, CommandEvent}, ShellExt};

const CONTROLLER: &str = "127.0.0.1:9090";
const SECRET: &str = "felyx-proxy-v01-local";
const DEFAULT_DELAY_URL: &str = "https://www.gstatic.com/generate_204";

pub struct CoreState {
    child: Mutex<Option<CommandChild>>,
}

impl Default for CoreState {
    fn default() -> Self {
        Self { child: Mutex::new(None) }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    running: bool,
    controller: String,
    config_path: String,
}

fn runtime_paths(app: &AppHandle) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
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

async fn api_get(path: &str) -> Result<Value, String> {
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

async fn api_put(path: &str, payload: Value) -> Result<Value, String> {
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

fn encode_path_segment(value: &str) -> String {
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

async fn is_running() -> bool {
    api_get("/version").await.is_ok()
}

fn status_for(app: &AppHandle, running: bool) -> Result<CoreStatus, String> {
    let (_, config) = runtime_paths(app)?;
    Ok(CoreStatus {
        running,
        controller: CONTROLLER.to_string(),
        config_path: config.display().to_string(),
    })
}

#[tauri::command]
pub async fn mihomo_start(app: AppHandle, state: State<'_, CoreState>) -> Result<CoreStatus, String> {
    if is_running().await {
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

    let (mut rx, child) = command.spawn().map_err(|e| format!("Mihomo 启动失败：{e}"))?;
    *state.child.lock().map_err(|_| "CoreState 锁异常")? = Some(child);

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
                _ => {}
            }
        }
    });

    Ok(status_for(&app, true)?)
}

#[tauri::command]
pub async fn mihomo_stop(app: AppHandle, state: State<'_, CoreState>) -> Result<CoreStatus, String> {
    if let Some(child) = state.child.lock().map_err(|_| "CoreState 锁异常")?.take() {
        child.kill().map_err(|e| format!("停止 Mihomo 失败：{e}"))?;
    }
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
pub async fn mihomo_select_proxy(group: String, proxy: String) -> Result<Value, String> {
    api_put(
        &format!("/proxies/{}", encode_path_segment(&group)),
        serde_json::json!({ "name": proxy }),
    )
    .await
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
