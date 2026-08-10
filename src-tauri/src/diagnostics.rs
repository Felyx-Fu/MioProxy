use std::{
    collections::VecDeque,
    fs::{self, File},
    io::Write,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

use crate::{mihomo, outbound, profiles, service, system_proxy, tun};

const MAX_EVENTS: usize = 3000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticEvent {
    pub timestamp: u64,
    pub level: String,
    pub category: String,
    pub message: String,
}

#[derive(Default)]
pub(crate) struct DiagnosticLogState {
    entries: Mutex<VecDeque<DiagnosticEvent>>,
}

pub(crate) fn record_event(app: &AppHandle, level: &str, category: &str, message: impl AsRef<str>) {
    let Some(state) = app.try_state::<DiagnosticLogState>() else {
        return;
    };
    let entry = DiagnosticEvent {
        timestamp: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        level: level.to_ascii_uppercase(),
        category: category.to_string(),
        message: crate::mihomo::logs::redact_text(message.as_ref()),
    };
    let Ok(mut entries) = state.entries.lock() else {
        return;
    };
    entries.push_back(entry);
    while entries.len() > MAX_EVENTS {
        entries.pop_front();
    }
}

fn recent_events(app: &AppHandle) -> Vec<DiagnosticEvent> {
    app.try_state::<DiagnosticLogState>()
        .and_then(|state| {
            state
                .entries
                .lock()
                .ok()
                .map(|entries| entries.iter().cloned().collect())
        })
        .unwrap_or_default()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticManifest {
    app_version: &'static str,
    service_version: Option<String>,
    core_version: Option<String>,
    current_mode: Option<String>,
    service_reachable: Option<bool>,
    architecture: &'static str,
    platform: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileSummary {
    id: String,
    name: String,
    has_subscription_url: bool,
    downloaded: bool,
    updated_at: Option<u64>,
    node_count: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkSummary {
    default_route: Value,
    dns_servers: Value,
    adapters: Value,
    mihomo_running: bool,
    captured_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutboundCompatibilitySummary {
    foreign_tun_detected: bool,
    selected_if_index: Option<u32>,
    selected_kind: Option<outbound::InterfaceKind>,
    confidence: Option<outbound::Confidence>,
    auto_interface_binding: bool,
    reason: Option<String>,
}

fn outbound_compatibility_summary() -> OutboundCompatibilitySummary {
    let compatibility = outbound::resolve().unwrap_or_default();
    OutboundCompatibilitySummary {
        foreign_tun_detected: compatibility.foreign_tun_detected,
        selected_if_index: compatibility.selected.as_ref().map(|item| item.if_index),
        selected_kind: compatibility.selected.as_ref().map(|item| item.kind),
        confidence: compatibility.selected.as_ref().map(|item| item.confidence),
        auto_interface_binding: compatibility.selected.is_some()
            && compatibility.foreign_tun_detected,
        reason: compatibility.reason,
    }
}

fn sanitize_network_value(value: Value) -> Value {
    match value {
        Value::Array(values) => {
            Value::Array(values.into_iter().map(sanitize_network_value).collect())
        }
        Value::Object(mut object) => {
            object.retain(|key, _| {
                let key = key.to_ascii_lowercase();
                !key.contains("mac") && !key.contains("physicaladdress")
            });
            Value::Object(
                object
                    .into_iter()
                    .map(|(key, value)| (key, sanitize_network_value(value)))
                    .collect(),
            )
        }
        value => value,
    }
}

fn network_summary(snapshot: tun::NetworkSnapshot) -> NetworkSummary {
    NetworkSummary {
        default_route: sanitize_network_value(snapshot.default_route),
        dns_servers: sanitize_network_value(snapshot.dns_servers),
        adapters: sanitize_network_value(snapshot.adapters),
        mihomo_running: snapshot.mihomo_running,
        captured_at: snapshot.captured_at,
    }
}

fn bundle_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    Ok(directory.join(format!("diagnostic-bundle-{timestamp}.zip")))
}

fn add_json<T: Serialize>(
    archive: &mut ZipWriter<File>,
    name: &str,
    value: &T,
) -> Result<(), String> {
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    archive
        .start_file(name, options)
        .map_err(|e| e.to_string())?;
    let content = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    archive.write_all(&content).map_err(|e| e.to_string())
}

fn version_string(value: serde_json::Value) -> Option<String> {
    value
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
}

#[tauri::command]
pub(crate) async fn diagnostic_bundle_generate(app: AppHandle) -> Result<String, String> {
    let path = bundle_path(&app)?;
    let file = File::options()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("创建诊断包失败：{e}"))?;
    let mut archive = ZipWriter::new(file);

    let service_status = service::service_status_command(app.clone()).await.ok();
    let core_status = mihomo::mihomo_status(app.clone()).await.ok();
    let core_version = mihomo::mihomo_version().await.ok().and_then(version_string);
    let proxy_status = system_proxy::status(&app).await.ok();
    let tun_status = tun::diagnostic_status(&app).await.ok();
    let network_status = tun::diagnostic_network_snapshot()
        .await
        .ok()
        .map(network_summary);
    let outbound_compatibility = outbound_compatibility_summary();
    let (profiles, profiles_error) = match profiles::read_profiles(&app) {
        Ok(profiles) => (
            profiles
                .into_iter()
                .map(|profile| ProfileSummary {
                    id: profile.id,
                    name: profile.name,
                    has_subscription_url: !profile.url.trim().is_empty(),
                    downloaded: profile.file_path.is_some(),
                    updated_at: profile.updated_at,
                    node_count: profile.node_count,
                })
                .collect::<Vec<_>>(),
            None,
        ),
        Err(error) => (Vec::new(), Some(error)),
    };
    let manifest = DiagnosticManifest {
        app_version: env!("CARGO_PKG_VERSION"),
        service_version: service_status
            .as_ref()
            .and_then(|status| status.service_version.clone()),
        core_version,
        current_mode: core_status.as_ref().map(|status| status.mode.clone()),
        service_reachable: service_status.as_ref().map(|status| status.reachable),
        architecture: std::env::consts::ARCH,
        platform: std::env::consts::OS,
    };

    add_json(&mut archive, "manifest.json", &manifest)?;
    add_json(&mut archive, "service.json", &service_status)?;
    add_json(&mut archive, "core.json", &core_status)?;
    add_json(&mut archive, "system-proxy.json", &proxy_status)?;
    add_json(&mut archive, "tun.json", &tun_status)?;
    add_json(&mut archive, "network.json", &network_status)?;
    add_json(
        &mut archive,
        "outbound-compatibility.json",
        &outbound_compatibility,
    )?;
    add_json(&mut archive, "profiles-summary.json", &profiles)?;
    add_json(&mut archive, "profiles-error.json", &profiles_error)?;
    add_json(&mut archive, "diagnostic-events.json", &recent_events(&app))?;
    add_json(
        &mut archive,
        "logs.json",
        &mihomo::logs::recent_entries(&app),
    )?;
    archive.finish().map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::{network_summary, sanitize_network_value};
    use crate::tun::NetworkSnapshot;
    use serde_json::json;

    #[test]
    fn diagnostic_network_summary_removes_hardware_identifiers() {
        let summary = network_summary(NetworkSnapshot {
            default_route: json!({"InterfaceAlias": "Wi-Fi"}),
            dns_servers: json!([{"ServerAddresses": ["1.1.1.1"]}]),
            adapters: json!([{
                "Name": "Wi-Fi",
                "MacAddress": "00-11-22-33-44-55",
                "PhysicalAddress": "00-11-22-33-44-55"
            }]),
            mihomo_running: true,
            captured_at: 1,
        });

        assert_eq!(summary.adapters[0]["Name"], "Wi-Fi");
        assert!(summary.adapters[0].get("MacAddress").is_none());
        assert!(summary.adapters[0].get("PhysicalAddress").is_none());
        assert_eq!(summary.dns_servers[0]["ServerAddresses"][0], "1.1.1.1");
    }

    #[test]
    fn network_sanitizer_recurses_through_arrays_and_objects() {
        let value = sanitize_network_value(json!({
            "outer": [{"macAddress": "secret", "value": "kept"}]
        }));
        assert!(value["outer"][0].get("macAddress").is_none());
        assert_eq!(value["outer"][0]["value"], "kept");
    }
}
