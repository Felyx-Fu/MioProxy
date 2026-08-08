use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{api_delete, api_get, encode_path_segment};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionMetadata {
    #[serde(default)]
    pub network: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub destination_ip: String,
    #[serde(default)]
    pub destination_port: String,
    #[serde(default)]
    pub source_ip: String,
    #[serde(default)]
    pub source_port: String,
    #[serde(default)]
    pub process: String,
    #[serde(default)]
    pub process_path: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    #[serde(default)]
    pub metadata: ConnectionMetadata,
    #[serde(default)]
    pub upload: u64,
    #[serde(default)]
    pub download: u64,
    #[serde(default)]
    pub start: String,
    #[serde(default)]
    pub chains: Vec<String>,
    #[serde(default)]
    pub rule: String,
    #[serde(default)]
    pub rule_payload: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsResponse {
    #[serde(default)]
    pub download_total: u64,
    #[serde(default)]
    pub upload_total: u64,
    #[serde(default, deserialize_with = "deserialize_connections")]
    pub connections: Vec<Connection>,
    #[serde(default)]
    pub memory: Option<u64>,
}

fn deserialize_connections<'de, D>(deserializer: D) -> Result<Vec<Connection>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<Vec<Connection>>::deserialize(deserializer)?.unwrap_or_default())
}

#[tauri::command]
pub async fn mihomo_connections() -> Result<ConnectionsResponse, String> {
    let value = api_get("/connections").await?;
    serde_json::from_value(value).map_err(|error| format!("解析 Mihomo connections 失败：{error}"))
}

#[tauri::command]
pub async fn mihomo_close_connection(id: String) -> Result<(), String> {
    api_delete(&format!("/connections/{}", encode_path_segment(&id)))
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn mihomo_close_all_connections() -> Result<(), String> {
    api_delete("/connections").await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_controller_connection_shape() {
        let response: ConnectionsResponse = serde_json::from_value(serde_json::json!({
            "downloadTotal": 14200000,
            "uploadTotal": 1200,
            "memory": 25874432,
            "connections": [{
                "id": "connection-1",
                "metadata": {
                    "network": "tcp",
                    "host": "chatgpt.com",
                    "destinationIP": "104.18.0.1",
                    "destinationPort": "443",
                    "process": "chrome.exe",
                    "processPath": "C:/Program Files/Google/Chrome/chrome.exe"
                },
                "download": 14000000,
                "upload": 200000,
                "chains": ["HK-01"],
                "rule": "DOMAIN-SUFFIX",
                "rulePayload": "chatgpt.com"
            }]
        }))
        .expect("valid Mihomo connections payload");

        assert_eq!(response.connections.len(), 1);
        assert_eq!(response.connections[0].metadata.process, "chrome.exe");
        assert_eq!(response.connections[0].chains, ["HK-01"]);
        assert_eq!(response.connections[0].rule_payload, "chatgpt.com");
        assert_eq!(response.memory, Some(25874432));
    }

    #[test]
    fn treats_null_connections_as_empty() {
        let response: ConnectionsResponse = serde_json::from_value(serde_json::json!({
            "downloadTotal": 0,
            "uploadTotal": 0,
            "connections": null
        }))
        .expect("valid empty Mihomo connections payload");

        assert!(response.connections.is_empty());
    }
}
