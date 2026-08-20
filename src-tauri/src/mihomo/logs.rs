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
const MAX_CONTROLLER_RESPONSE_CHARS: usize = 2048;
const REDACTED_VALUE: &str = "***";

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

/// Redacts untrusted Controller response text before it reaches diagnostics or
/// user-visible errors. Keep parser locations and field names intact, but never
/// retain credentials or endpoints returned by Mihomo.
pub(crate) fn redact_controller_response(input: &str) -> String {
    let mut redacted = input.to_string();
    redact_all_bearers(&mut redacted);
    for key in [
        "subscription-url",
        "subscription_url",
        "subscriptionurl",
        "authorization",
        "private-key",
        "private_key",
        "password",
        "passwd",
        "api-key",
        "api_key",
        "apikey",
        "secret",
        "token",
        "uuid",
        "url",
    ] {
        redact_structured_value(&mut redacted, key);
    }
    redact_all_urls(&mut redacted);
    redact_all_uuids(&mut redacted);
    truncate_controller_response(redacted)
}

fn redact_structured_value(value: &mut String, key: &str) {
    let mut offset = 0;
    while offset < value.len() {
        let lower = value.to_ascii_lowercase();
        let Some(relative) = lower[offset..].find(key) else {
            break;
        };
        let key_start = offset + relative;
        let key_end = key_start + key.len();
        let bytes = value.as_bytes();

        let mut cursor = key_end;
        if cursor < bytes.len() && matches!(bytes[cursor], b'\'' | b'"') {
            cursor += 1;
        }
        while cursor < bytes.len() && matches!(bytes[cursor], b' ' | b'\t') {
            cursor += 1;
        }
        if cursor >= bytes.len() || !matches!(bytes[cursor], b':' | b'=') {
            offset = key_end;
            continue;
        }
        let delimiter = bytes[cursor];
        cursor += 1;
        while cursor < bytes.len() && matches!(bytes[cursor], b' ' | b'\t') {
            cursor += 1;
        }

        let (start, mut end) = if cursor < bytes.len() && matches!(bytes[cursor], b'\'' | b'"') {
            let quote = bytes[cursor];
            let start = cursor + 1;
            let mut end = start;
            let mut escaped = false;
            while end < bytes.len() {
                let byte = bytes[end];
                if byte == quote && !escaped {
                    break;
                }
                escaped = byte == b'\\' && !escaped;
                if byte != b'\\' {
                    escaped = false;
                }
                end += 1;
            }
            (start, end)
        } else {
            let start = cursor;
            let mut end = start;
            while end < bytes.len() && !is_unquoted_value_terminator(bytes[end], delimiter) {
                end += 1;
            }
            while end > start && matches!(bytes[end - 1], b' ' | b'\t') {
                end -= 1;
            }
            (start, end)
        };

        if end == start {
            offset = end.max(key_end);
            continue;
        }
        value.replace_range(start..end, REDACTED_VALUE);
        end = start + REDACTED_VALUE.len();
        offset = end;
    }
}

fn is_unquoted_value_terminator(byte: u8, delimiter: u8) -> bool {
    matches!(
        byte,
        b'\r' | b'\n' | b',' | b';' | b'}' | b']' | b'\'' | b'"'
    ) || (delimiter == b'=' && (byte.is_ascii_whitespace() || byte == b'&'))
}

fn redact_all_bearers(value: &mut String) {
    let mut offset = 0;
    while offset < value.len() {
        let lower = value.to_ascii_lowercase();
        let Some(relative) = lower[offset..].find("bearer ") else {
            break;
        };
        let start = offset + relative + "bearer ".len();
        let bytes = value.as_bytes();
        let mut end = start;
        while end < bytes.len()
            && !bytes[end].is_ascii_whitespace()
            && !b",;\"'}]".contains(&bytes[end])
        {
            end += 1;
        }
        if end == start {
            offset = start;
            continue;
        }
        value.replace_range(start..end, REDACTED_VALUE);
        offset = start + REDACTED_VALUE.len();
    }
}

fn redact_all_urls(value: &mut String) {
    let mut offset = 0;
    while offset < value.len() {
        let Some(marker_relative) = value[offset..].find("://") else {
            break;
        };
        let marker = offset + marker_relative;
        let bytes = value.as_bytes();
        let mut start = marker;
        while start > 0 && is_scheme_byte(bytes[start - 1]) {
            start -= 1;
        }
        let scheme = &bytes[start..marker];
        if !(2..=24).contains(&scheme.len())
            || !scheme[0].is_ascii_alphabetic()
            || !scheme.iter().all(|byte| is_scheme_byte(*byte))
        {
            offset = marker + 3;
            continue;
        }

        let mut end = marker + 3;
        while end < bytes.len()
            && !bytes[end].is_ascii_whitespace()
            && !b"\"'<>)]},;".contains(&bytes[end])
        {
            end += 1;
        }
        value.replace_range(start..end, REDACTED_VALUE);
        offset = start + REDACTED_VALUE.len();
    }
}

fn is_scheme_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.')
}

fn redact_all_uuids(value: &mut String) {
    let mut index = 0;
    while index + 36 <= value.len() {
        let bytes = value.as_bytes();
        if is_uuid_at(bytes, index) {
            value.replace_range(index..index + 36, REDACTED_VALUE);
            index += REDACTED_VALUE.len();
        } else {
            index += value[index..]
                .chars()
                .next()
                .map(char::len_utf8)
                .unwrap_or(1);
        }
    }
}

fn is_uuid_at(bytes: &[u8], start: usize) -> bool {
    const HYPHENS: [usize; 4] = [8, 13, 18, 23];
    if start + 36 > bytes.len()
        || (start > 0 && bytes[start - 1].is_ascii_hexdigit())
        || (start + 36 < bytes.len() && bytes[start + 36].is_ascii_hexdigit())
    {
        return false;
    }
    (0..36).all(|offset| {
        if HYPHENS.contains(&offset) {
            bytes[start + offset] == b'-'
        } else {
            bytes[start + offset].is_ascii_hexdigit()
        }
    })
}

fn truncate_controller_response(value: String) -> String {
    if value.chars().count() <= MAX_CONTROLLER_RESPONSE_CHARS {
        return value;
    }
    let mut truncated = value
        .chars()
        .take(MAX_CONTROLLER_RESPONSE_CHARS)
        .collect::<String>();
    truncated.push_str("… [truncated]");
    truncated
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
    use super::{normalize_level, redact_controller_response, redact_text};

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

    #[test]
    fn controller_response_redacts_structured_credentials_but_keeps_parser_context() {
        let response = r#"{"secret":"top-secret","password":"hunter2","token":"abc123","uuid":"550e8400-e29b-41d4-a716-446655440000","url":"https://user:pass@example.test/sub?token=abc","message":"yaml: line 47: field tun.device not found"}
subscription-url: https://example.test/private/sub
authorization = Bearer another-secret"#;
        let redacted = redact_controller_response(response);

        for sensitive in [
            "top-secret",
            "hunter2",
            "abc123",
            "550e8400-e29b-41d4-a716-446655440000",
            "user:pass",
            "example.test",
            "another-secret",
        ] {
            assert!(!redacted.contains(sensitive), "leaked {sensitive}");
        }
        assert!(redacted.contains("yaml: line 47: field tun.device not found"));
        assert!(redacted.contains("\"secret\":\"***\""));
    }

    #[test]
    fn controller_response_redacts_bare_urls_uuids_and_bearer_values() {
        let response = "line 8: fetch vless://user@example.test:443 and 550e8400-e29b-41d4-a716-446655440000; Bearer raw-token";
        let redacted = redact_controller_response(response);

        assert_eq!(redacted, "line 8: fetch *** and ***; Bearer ***");
    }

    #[test]
    fn controller_response_redacts_prefixed_sensitive_assignment_keys() {
        let response = "proxy.password=dot-value\nclient-secret: hyphen-value\nrefresh_token=underscore-value\napiToken=api-value\naccessToken: access-value\nclientSecret=client-value\nproxyPassword: 代理密码\nauthToken=auth-value\n错误：第 12 行字段 tun.device 无效";
        let redacted = redact_controller_response(response);

        for sensitive in [
            "dot-value",
            "hyphen-value",
            "underscore-value",
            "api-value",
            "access-value",
            "client-value",
            "代理密码",
            "auth-value",
        ] {
            assert!(!redacted.contains(sensitive), "leaked {sensitive}");
        }
        assert!(redacted.contains("错误：第 12 行字段 tun.device 无效"));
    }

    #[test]
    fn controller_response_is_truncated_after_redaction() {
        let response = format!(
            "line 12: invalid field {} token=must-not-leak",
            "x".repeat(3000)
        );
        let redacted = redact_controller_response(&response);

        assert!(redacted.starts_with("line 12: invalid field"));
        assert!(redacted.ends_with("… [truncated]"));
        assert!(!redacted.contains("must-not-leak"));
    }
}
