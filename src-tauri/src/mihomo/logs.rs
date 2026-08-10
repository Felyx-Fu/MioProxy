use std::{
    collections::VecDeque,
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

pub struct LogStreamState {
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    entries: Mutex<VecDeque<LogEntry>>,
}

impl Default for LogStreamState {
    fn default() -> Self {
        Self {
            task: Mutex::new(None),
            entries: Mutex::new(VecDeque::new()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub timestamp: u64,
    pub level: String,
    pub message: String,
}

const MAX_ENTRIES: usize = 3000;

pub(crate) fn recent_entries(app: &AppHandle) -> Vec<LogEntry> {
    app.state::<LogStreamState>()
        .entries
        .lock()
        .map(|entries| entries.iter().cloned().collect())
        .unwrap_or_default()
}

fn record_entry(app: &AppHandle, entry: &LogEntry) {
    if let Ok(mut entries) = app.state::<LogStreamState>().entries.lock() {
        entries.push_back(entry.clone());
        while entries.len() > MAX_ENTRIES {
            entries.pop_front();
        }
    }
}

pub(crate) fn redact_text(input: &str) -> String {
    let mut redacted = input.to_string();
    redact_authorization(&mut redacted);
    for key in [
        "token=",
        "secret=",
        "password=",
        "passwd=",
        "api-key=",
        "private-key=",
    ] {
        redact_key_value(&mut redacted, key);
    }
    redact_bearer(&mut redacted);
    redacted
}

fn redact_key_value(value: &mut String, key: &str) {
    let mut offset = 0;
    loop {
        let lower = value.to_ascii_lowercase();
        let Some(relative) = lower[offset..].find(key) else {
            break;
        };
        let start = offset + relative + key.len();
        let end = value[start..]
            .find(|character: char| {
                character.is_whitespace() || matches!(character, '&' | ';' | ',' | '"' | '\'')
            })
            .map(|relative| start + relative)
            .unwrap_or(value.len());
        value.replace_range(start..end, "***");
        offset = start + 3;
        if offset >= value.len() {
            break;
        }
    }
}

fn redact_authorization(value: &mut String) {
    let key = "authorization=";
    let mut offset = 0;
    loop {
        let lower = value.to_ascii_lowercase();
        let Some(relative) = lower[offset..].find(key) else {
            break;
        };
        let start = offset + relative + key.len();
        let end = value[start..]
            .find(['&', ';', ',', '"', '\''])
            .map(|relative| start + relative)
            .unwrap_or(value.len());
        value.replace_range(start..end, "***");
        offset = start + 3;
        if offset >= value.len() {
            break;
        }
    }
}

fn redact_bearer(value: &mut String) {
    let lower = value.to_ascii_lowercase();
    let Some(relative) = lower.find("bearer ") else {
        return;
    };
    let start = relative + "bearer ".len();
    let end = value[start..]
        .find(char::is_whitespace)
        .map(|relative| start + relative)
        .unwrap_or(value.len());
    value.replace_range(start..end, "***");
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
                    let message = redact_text(incoming.payload.trim());
                    if message.is_empty() {
                        continue;
                    }
                    let level = normalize_level(&incoming.level);
                    let entry = LogEntry {
                        timestamp: now_millis(),
                        level,
                        message,
                    };
                    record_entry(&app, &entry);
                    let _ = app.emit(EVENT, entry);
                }
            }
            Err(_) => tokio::time::sleep(RETRY_DELAY).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_level, redact_text};

    #[test]
    fn normalizes_mihomo_log_levels_for_filters() {
        assert_eq!(normalize_level("warning"), "WARN");
        assert_eq!(normalize_level("error"), "ERROR");
        assert_eq!(normalize_level("debug"), "DEBUG");
        assert_eq!(normalize_level("info"), "INFO");
    }

    #[test]
    fn redacts_sensitive_log_values() {
        assert_eq!(
            redact_text("token=abc123 password=hunter2 Authorization=Bearer secret-value"),
            "token=*** password=*** Authorization=***"
        );
        assert_eq!(
            redact_text("https://example.test/?sid=1&token=abc&x=2"),
            "https://example.test/?sid=1&token=***&x=2"
        );
    }
}
