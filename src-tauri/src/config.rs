use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_yaml::{Mapping, Value};
use tauri::{AppHandle, Manager};

use crate::{mihomo, profiles};

const OVERRIDE_FILE: &str = "local-override.yaml";
const CANDIDATE_FILE: &str = "config.candidate.yaml";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverrideSnapshot {
    pub content: String,
    pub path: String,
    pub has_content: bool,
    pub updated_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPreview {
    pub profile_id: String,
    pub profile_name: String,
    pub yaml: String,
    pub override_active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigApplyResult {
    pub profile_id: String,
    pub profile_name: String,
    pub path: String,
    pub controller_validated: bool,
    pub override_active: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsSettings {
    pub enabled: bool,
    pub enhanced_mode: String,
    pub default_nameserver: Vec<String>,
    pub nameserver: Vec<String>,
    pub fallback: Vec<String>,
    pub fake_ip_filter_mode: String,
    pub fake_ip_filter: Vec<String>,
}

pub(crate) struct BuiltConfig {
    pub profile: profiles::Profile,
    pub value: Value,
    pub override_active: bool,
}

fn app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app_data_dir(app)?.join("config.yaml"))
}

fn override_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app_data_dir(app)?.join(OVERRIDE_FILE))
}

fn candidate_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app_data_dir(app)?.join(CANDIDATE_FILE))
}

pub(crate) fn config_path_at(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("config.yaml")
}

pub(crate) fn candidate_path_at(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join(CANDIDATE_FILE)
}

fn override_path_at(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join(OVERRIDE_FILE)
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp = path.with_extension("tmp");
    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    fs::rename(temp, path).map_err(|e| e.to_string())
}

fn empty_mapping() -> Value {
    Value::Mapping(Mapping::new())
}

fn read_override_value_at(data_dir: &Path) -> Result<(Value, String), String> {
    let path = override_path_at(data_dir);
    if !path.exists() {
        return Ok((empty_mapping(), String::new()));
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("读取本地 Override 失败：{e}"))?;
    if content.trim().is_empty() {
        return Ok((empty_mapping(), content));
    }
    let value = serde_yaml::from_str::<Value>(&content)
        .map_err(|e| format!("本地 Override YAML 无效：{e}"))?;
    if !value.is_mapping() {
        return Err("本地 Override 根节点必须是 YAML 对象".to_string());
    }
    Ok((value, content))
}

fn read_override_value(app: &AppHandle) -> Result<(Value, String), String> {
    read_override_value_at(&app_data_dir(app)?)
}

pub(crate) fn override_content_at(data_dir: &Path) -> Result<String, String> {
    read_override_value_at(data_dir).map(|(_, content)| content)
}

pub(crate) fn override_content(app: &AppHandle) -> Result<String, String> {
    read_override_value(app).map(|(_, content)| content)
}

fn merge_values(base: &mut Value, overlay: Value) {
    match (base, overlay) {
        (Value::Mapping(base_map), Value::Mapping(overlay_map)) => {
            for (key, value) in overlay_map {
                if let Some(existing) = base_map.get_mut(&key) {
                    merge_values(existing, value);
                } else {
                    base_map.insert(key, value);
                }
            }
        }
        (base, overlay) => *base = overlay,
    }
}

fn value_key(value: &str) -> Value {
    Value::String(value.to_string())
}

fn mapping_value<'a>(map: &'a Mapping, key: &str) -> Option<&'a Value> {
    map.get(value_key(key))
}

fn validate_config(value: &Value) -> Result<(), String> {
    let map = value
        .as_mapping()
        .ok_or_else(|| "最终配置根节点必须是 YAML 对象".to_string())?;
    if let Some(port) = mapping_value(map, "mixed-port") {
        let port = port
            .as_i64()
            .ok_or_else(|| "mixed-port 必须是数字".to_string())?;
        if !(1..=65535).contains(&port) {
            return Err("mixed-port 必须在 1 到 65535 之间".to_string());
        }
    }
    for key in ["proxies", "proxy-groups", "rules"] {
        if let Some(value) = mapping_value(map, key) {
            if !value.is_sequence() {
                return Err(format!("{key} 必须是 YAML 列表"));
            }
        }
    }
    for key in ["dns", "rule-providers"] {
        if let Some(value) = mapping_value(map, key) {
            if !value.is_mapping() {
                return Err(format!("{key} 必须是 YAML 对象"));
            }
        }
    }
    if let Some(dns) = mapping_value(map, "dns").and_then(Value::as_mapping) {
        if let Some(enable) = mapping_value(dns, "enable") {
            if !enable.is_bool() {
                return Err("dns.enable 必须是布尔值".to_string());
            }
        }
        if let Some(mode) = mapping_value(dns, "enhanced-mode") {
            let mode = mode
                .as_str()
                .ok_or_else(|| "dns.enhanced-mode 必须是字符串".to_string())?;
            if !matches!(mode, "fake-ip" | "redir-host") {
                return Err("dns.enhanced-mode 只支持 fake-ip 或 redir-host".to_string());
            }
        }
        if let Some(mode) = mapping_value(dns, "fake-ip-filter-mode") {
            let mode = mode
                .as_str()
                .ok_or_else(|| "dns.fake-ip-filter-mode 必须是字符串".to_string())?;
            if !matches!(mode, "blacklist" | "whitelist" | "rule") {
                return Err(
                    "dns.fake-ip-filter-mode 只支持 blacklist、whitelist 或 rule".to_string(),
                );
            }
        }
        for key in [
            "default-nameserver",
            "nameserver",
            "fallback",
            "fake-ip-filter",
        ] {
            if let Some(items) = mapping_value(dns, key) {
                let sequence = items
                    .as_sequence()
                    .ok_or_else(|| format!("dns.{key} 必须是 YAML 列表"))?;
                if sequence.iter().any(|item| !item.is_string()) {
                    return Err(format!("dns.{key} 只能包含字符串"));
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn build_value_at(data_dir: &Path, profile_id: &str) -> Result<BuiltConfig, String> {
    let profiles_path = data_dir.join("profiles.json");
    let profiles_content =
        fs::read_to_string(&profiles_path).map_err(|e| format!("读取 Profile 数据失败：{e}"))?;
    let profile = serde_json::from_str::<Vec<profiles::Profile>>(&profiles_content)
        .map_err(|e| format!("Profile 数据损坏：{e}"))?
        .into_iter()
        .find(|candidate| candidate.id == profile_id)
        .ok_or_else(|| "找不到这个 Profile".to_string())?;
    let source_path = profile
        .file_path
        .as_ref()
        .ok_or_else(|| "请先下载这个 Profile".to_string())?;
    let source =
        fs::read_to_string(source_path).map_err(|e| format!("读取 Profile YAML 失败：{e}"))?;
    if source.trim().is_empty() {
        return Err("Profile YAML 为空".to_string());
    }
    let mut base =
        serde_yaml::from_str::<Value>(&source).map_err(|e| format!("Profile YAML 无效：{e}"))?;
    let (override_value, override_content) = read_override_value_at(data_dir)?;
    merge_values(&mut base, override_value);
    let map = base
        .as_mapping_mut()
        .ok_or_else(|| "Profile YAML 根节点必须是 YAML 对象".to_string())?;
    map.insert(
        value_key("external-controller"),
        Value::String(mihomo::CONTROLLER.to_string()),
    );
    map.insert(
        value_key("secret"),
        Value::String(mihomo::SECRET.to_string()),
    );
    validate_config(&base)?;
    Ok(BuiltConfig {
        profile,
        value: base,
        override_active: !override_content.trim().is_empty(),
    })
}

fn build_value(
    app: &AppHandle,
    profile_id: &str,
) -> Result<(profiles::Profile, Value, bool), String> {
    let built = build_value_at(&app_data_dir(app)?, profile_id)?;
    Ok((built.profile, built.value, built.override_active))
}

fn settings_from_value(value: &Value) -> DnsSettings {
    let Some(map) = value.as_mapping() else {
        return DnsSettings {
            enhanced_mode: "redir-host".to_string(),
            fake_ip_filter_mode: "blacklist".to_string(),
            ..Default::default()
        };
    };
    let values = |key: &str| {
        mapping_value(map, key)
            .and_then(Value::as_sequence)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    DnsSettings {
        enabled: mapping_value(map, "enable")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        enhanced_mode: mapping_value(map, "enhanced-mode")
            .and_then(Value::as_str)
            .unwrap_or("redir-host")
            .to_string(),
        default_nameserver: values("default-nameserver"),
        nameserver: values("nameserver"),
        fallback: values("fallback"),
        fake_ip_filter_mode: mapping_value(map, "fake-ip-filter-mode")
            .and_then(Value::as_str)
            .unwrap_or("blacklist")
            .to_string(),
        fake_ip_filter: values("fake-ip-filter"),
    }
}

fn dns_value(settings: &DnsSettings) -> Value {
    let mut map = Mapping::new();
    map.insert(value_key("enable"), Value::Bool(settings.enabled));
    map.insert(
        value_key("enhanced-mode"),
        Value::String(settings.enhanced_mode.clone()),
    );
    map.insert(
        value_key("default-nameserver"),
        Value::Sequence(
            settings
                .default_nameserver
                .iter()
                .cloned()
                .map(Value::String)
                .collect(),
        ),
    );
    map.insert(
        value_key("nameserver"),
        Value::Sequence(
            settings
                .nameserver
                .iter()
                .cloned()
                .map(Value::String)
                .collect(),
        ),
    );
    map.insert(
        value_key("fallback"),
        Value::Sequence(
            settings
                .fallback
                .iter()
                .cloned()
                .map(Value::String)
                .collect(),
        ),
    );
    map.insert(
        value_key("fake-ip-filter-mode"),
        Value::String(settings.fake_ip_filter_mode.clone()),
    );
    map.insert(
        value_key("fake-ip-filter"),
        Value::Sequence(
            settings
                .fake_ip_filter
                .iter()
                .cloned()
                .map(Value::String)
                .collect(),
        ),
    );
    Value::Mapping(map)
}

fn write_override_value(app: &AppHandle, value: &Value) -> Result<OverrideSnapshot, String> {
    validate_config(&serde_yaml::to_value(value).map_err(|e| e.to_string())?)?;
    let content = if value.as_mapping().is_some_and(Mapping::is_empty) {
        String::new()
    } else {
        serde_yaml::to_string(value).map_err(|e| format!("生成 Override YAML 失败：{e}"))?
    };
    let has_content = !content.trim().is_empty();
    let path = override_path(app)?;
    write_atomic(&path, content.as_bytes())?;
    Ok(OverrideSnapshot {
        content,
        path: path.display().to_string(),
        has_content,
        updated_at: Some(timestamp()),
    })
}

pub(crate) fn restore_override_content_at(data_dir: &Path, content: &str) -> Result<(), String> {
    let value = if content.trim().is_empty() {
        empty_mapping()
    } else {
        serde_yaml::from_str::<Value>(content)
            .map_err(|e| format!("恢复 Local Override 失败：{e}"))?
    };
    if !value.is_mapping() {
        return Err("恢复的 Local Override 根节点必须是 YAML 对象".to_string());
    }
    validate_config(&value)?;
    let path = override_path_at(data_dir);
    write_atomic(&path, content.as_bytes())
}

pub(crate) fn restore_override_content(app: &AppHandle, content: &str) -> Result<(), String> {
    restore_override_content_at(&app_data_dir(app)?, content)
}

pub(crate) fn set_tun_enabled_at(data_dir: &Path, enabled: bool) -> Result<(), String> {
    let (mut value, _) = read_override_value_at(data_dir)?;
    let map = value
        .as_mapping_mut()
        .ok_or_else(|| "本地 Override 根节点必须是 YAML 对象".to_string())?;
    let existing_tun = map.remove(value_key("tun")).unwrap_or_else(empty_mapping);
    let mut tun = existing_tun;
    let tun_map = tun
        .as_mapping_mut()
        .ok_or_else(|| "Local Override 的 tun 必须是 YAML 对象".to_string())?;
    tun_map.insert(value_key("enable"), Value::Bool(enabled));
    if enabled {
        tun_map.insert(value_key("stack"), Value::String("mixed".to_string()));
        tun_map.insert(value_key("device"), Value::String("MioProxy".to_string()));
        tun_map.insert(value_key("auto-route"), Value::Bool(true));
        tun_map.insert(value_key("auto-detect-interface"), Value::Bool(true));
        tun_map.insert(value_key("strict-route"), Value::Bool(true));
        tun_map.insert(
            value_key("dns-hijack"),
            Value::Sequence(vec![
                Value::String("any:53".to_string()),
                Value::String("tcp://any:53".to_string()),
            ]),
        );
    }
    map.insert(value_key("tun"), tun);
    let content = if value.as_mapping().is_some_and(Mapping::is_empty) {
        String::new()
    } else {
        serde_yaml::to_string(&value).map_err(|e| format!("生成 Override YAML 失败：{e}"))?
    };
    validate_config(&value)?;
    write_atomic(&override_path_at(data_dir), content.as_bytes())
}

pub(crate) fn set_tun_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    set_tun_enabled_at(&app_data_dir(app)?, enabled)
}

#[tauri::command]
pub fn override_get(app: AppHandle) -> Result<OverrideSnapshot, String> {
    let (_value, content) = read_override_value(&app)?;
    let path = override_path(&app)?;
    Ok(OverrideSnapshot {
        content: content.clone(),
        path: path.display().to_string(),
        has_content: !content.trim().is_empty(),
        updated_at: None,
    })
}

#[tauri::command]
pub fn override_set(app: AppHandle, content: String) -> Result<OverrideSnapshot, String> {
    let value = if content.trim().is_empty() {
        empty_mapping()
    } else {
        serde_yaml::from_str::<Value>(&content)
            .map_err(|e| format!("本地 Override YAML 无效：{e}"))?
    };
    if !value.is_mapping() {
        return Err("本地 Override 根节点必须是 YAML 对象".to_string());
    }
    let snapshot = write_override_value(&app, &value)?;
    Ok(OverrideSnapshot {
        content,
        ..snapshot
    })
}

#[tauri::command]
pub fn config_preview(app: AppHandle, profile_id: String) -> Result<ConfigPreview, String> {
    let (profile, value, override_active) = build_value(&app, &profile_id)?;
    let yaml = serde_yaml::to_string(&value).map_err(|e| format!("生成最终配置失败：{e}"))?;
    Ok(ConfigPreview {
        profile_id,
        profile_name: profile.name,
        yaml,
        override_active,
    })
}

pub(crate) async fn apply_config(
    app: AppHandle,
    profile_id: String,
) -> Result<ConfigApplyResult, String> {
    let (profile, value, override_active) = build_value(&app, &profile_id)?;
    let yaml = serde_yaml::to_string(&value).map_err(|e| format!("生成最终配置失败：{e}"))?;
    let stable = config_path(&app)?;
    let candidate = candidate_path(&app)?;
    write_atomic(&candidate, yaml.as_bytes())?;
    if !mihomo::is_running().await {
        let _ = fs::remove_file(&candidate);
        return Err("Mihomo 未运行，应用配置前请先启动内核以完成 Controller 校验".to_string());
    }
    match mihomo::api_put(
        "/configs?force=true",
        json!({ "path": candidate.display().to_string() }),
    )
    .await
    {
        Ok(_) => {}
        Err(error) => {
            let _ = fs::remove_file(&candidate);
            return Err(format!("Mihomo 配置校验失败，已保留当前配置：{error}"));
        }
    };
    write_atomic(&stable, yaml.as_bytes())?;
    let _ = fs::remove_file(&candidate);
    Ok(ConfigApplyResult {
        profile_id,
        profile_name: profile.name,
        path: stable.display().to_string(),
        controller_validated: true,
        override_active,
    })
}

pub async fn apply_profile(app: AppHandle, profile_id: String) -> Result<String, String> {
    let result = apply_config(app, profile_id).await?;
    Ok(format!(
        "{} · {} · {}",
        result.profile_name,
        "Mihomo 已校验并加载",
        if result.override_active {
            "已合并 Local Override"
        } else {
            "未使用 Local Override"
        }
    ))
}

#[tauri::command]
pub async fn config_apply(app: AppHandle, profile_id: String) -> Result<ConfigApplyResult, String> {
    apply_config(app, profile_id).await
}

#[tauri::command]
pub fn dns_get(app: AppHandle, profile_id: String) -> Result<DnsSettings, String> {
    let (_, value, _) = build_value(&app, &profile_id)?;
    let dns = value.as_mapping().and_then(|map| mapping_value(map, "dns"));
    Ok(settings_from_value(dns.unwrap_or(&Value::Null)))
}

#[tauri::command]
pub fn dns_set(app: AppHandle, settings: DnsSettings) -> Result<OverrideSnapshot, String> {
    let (mut value, _) = read_override_value(&app)?;
    let map = value
        .as_mapping_mut()
        .ok_or_else(|| "本地 Override 根节点必须是 YAML 对象".to_string())?;
    let existing_dns = map.remove(value_key("dns")).unwrap_or_else(empty_mapping);
    let mut dns = existing_dns;
    merge_values(&mut dns, dns_value(&settings));
    map.insert(value_key("dns"), dns);
    write_override_value(&app, &value)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{merge_values, restore_override_content_at, set_tun_enabled_at, validate_config};
    use serde_yaml::Value;

    #[test]
    fn merges_nested_override_without_mutating_unrelated_values() {
        let mut base = serde_yaml::from_str::<Value>(
            "dns:\n  enable: false\n  nameserver: [1.1.1.1]\nrules: [MATCH,DIRECT]\n",
        )
        .unwrap();
        let override_value = serde_yaml::from_str::<Value>("dns:\n  enable: true\n").unwrap();
        merge_values(&mut base, override_value);
        assert_eq!(base["dns"]["enable"].as_bool(), Some(true));
        assert_eq!(base["dns"]["nameserver"][0].as_str(), Some("1.1.1.1"));
        assert!(base["rules"].is_sequence());
    }

    #[test]
    fn rejects_invalid_config_shape() {
        let value = serde_yaml::from_str::<Value>("dns: []\n").unwrap();
        assert!(validate_config(&value).is_err());
    }

    #[test]
    fn rejects_invalid_dns_mode_and_list_items() {
        let value = serde_yaml::from_str::<Value>(
            "dns:\n  enhanced-mode: hosts\n  nameserver: [8.8.8.8]\n",
        )
        .unwrap();
        assert!(validate_config(&value).is_err());

        let value = serde_yaml::from_str::<Value>("dns:\n  nameserver: [8]\n").unwrap();
        assert!(validate_config(&value).is_err());
    }

    #[test]
    fn writes_tun_route_and_dns_override_without_touching_subscription() {
        let data_dir = std::env::temp_dir().join(format!(
            "mioproxy-config-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&data_dir).unwrap();
        let override_path = data_dir.join("local-override.yaml");
        fs::write(&override_path, "dns:\n  enable: true\n").unwrap();
        set_tun_enabled_at(&data_dir, true).unwrap();
        let value =
            serde_yaml::from_str::<Value>(&fs::read_to_string(&override_path).unwrap()).unwrap();
        assert_eq!(value["dns"]["enable"].as_bool(), Some(true));
        assert_eq!(value["tun"]["enable"].as_bool(), Some(true));
        assert_eq!(value["tun"]["auto-route"].as_bool(), Some(true));
        assert_eq!(value["tun"]["auto-detect-interface"].as_bool(), Some(true));
        assert_eq!(value["tun"]["dns-hijack"][0].as_str(), Some("any:53"));
        restore_override_content_at(&data_dir, "dns:\n  enable: true\n").unwrap();
        let restored = fs::read_to_string(override_path).unwrap();
        assert_eq!(restored, "dns:\n  enable: true\n");
        let _ = fs::remove_dir_all(data_dir);
    }
}
