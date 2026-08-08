use std::{
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};

use super::{is_running, secret, CONTROLLER};

const EVENT: &str = "mihomo-log-entry";
const RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Default)]
pub struct LogStreamState {
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub timestamp: u64,
    pub level: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
struct IncomingLog {
    #[serde(rename = "type", default)]
    level: String,
    #[serde(default)]
    payload: String,
}

fn normalize_level(level: &str) -> String {
    match level.to_ascii_lowercase().as_str() {
        "warning" => "WARN",
        "error" => "ERROR",
        "debug" => "DEBUG",
        _ => "INFO",
    }
    .to_string()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn start(app: &AppHandle) {
    let state = app.state::<LogStreamState>();
    if let Ok(mut task) = state.task.lock() {
        if task.is_none() {
            *task = Some(tauri::async_runtime::spawn(run(app.clone())));
        }
    };
}

pub fn stop(app: &AppHandle) {
    let state = app.state::<LogStreamState>();
    if let Ok(mut task) = state.task.lock() {
        if let Some(handle) = task.take() {
            handle.abort();
        }
    };
}

async fn run(app: AppHandle) {
    loop {
        if !is_running().await {
            tokio::time::sleep(RETRY_DELAY).await;
            continue;
        }
        let request = match format!("ws://{CONTROLLER}/logs?level=debug").into_client_request() {
            Ok(mut request) => {
                request.headers_mut().insert(
                    "Authorization",
                    format!("Bearer {}", secret()).parse().unwrap(),
                );
                request
            }
            Err(_) => {
                tokio::time::sleep(RETRY_DELAY).await;
                continue;
            }
        };
        match connect_async(request).await {
            Ok((mut socket, _)) => {
                while let Some(message) = socket.next().await {
                    let message = match message {
                        Ok(message) => message,
                        Err(_) => break,
                    };
                    let text = match message {
                        Message::Text(text) => text,
                        Message::Close(_) => break,
                        _ => continue,
                    };
                    let incoming = match serde_json::from_str::<IncomingLog>(text.as_ref()) {
                        Ok(value) => value,
                        Err(_) => continue,
                    };
                    let message = incoming.payload.trim().to_string();
                    if message.is_empty() {
                        continue;
                    }
                    let level = normalize_level(&incoming.level);
                    let _ = app.emit(
                        EVENT,
                        LogEntry {
                            timestamp: now_millis(),
                            level,
                            message,
                        },
                    );
                }
            }
            Err(_) => tokio::time::sleep(RETRY_DELAY).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_level;

    #[test]
    fn normalizes_mihomo_log_levels_for_filters() {
        assert_eq!(normalize_level("warning"), "WARN");
        assert_eq!(normalize_level("error"), "ERROR");
        assert_eq!(normalize_level("debug"), "DEBUG");
        assert_eq!(normalize_level("info"), "INFO");
    }
}
