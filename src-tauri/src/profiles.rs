use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose, Engine as _};
use percent_encoding::percent_decode_str;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub url: String,
    pub file_path: Option<String>,
    pub updated_at: Option<u64>,
    #[serde(default)]
    pub node_count: Option<u32>,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn profiles_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("profiles.json"))
}

pub(crate) fn read_profiles(app: &AppHandle) -> Result<Vec<Profile>, String> {
    let path = profiles_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| format!("Profile 数据损坏：{e}"))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let temp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("file")
    ));
    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    fs::rename(temp, path).map_err(|e| e.to_string())
}

fn write_profiles(app: &AppHandle, profiles: &[Profile]) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(profiles).map_err(|e| e.to_string())?;
    write_atomic(&profiles_path(app)?, &content)
}

fn validate_subscription_url(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    let url = Url::parse(value).map_err(|_| "订阅 URL 无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("订阅 URL 必须是 http 或 https 地址".to_string());
    }
    Ok(value.to_string())
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn generate_profile_id() -> Result<String, String> {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|e| format!("生成 Profile ID 失败：{e}"))?;
    let suffix = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("profile-{suffix}"))
}

fn count_nodes(body: &str) -> Option<u32> {
    let yaml = serde_yaml::from_str::<serde_yaml::Value>(body).ok()?;
    yaml.get("proxies")?
        .as_sequence()
        .map(|items| items.len() as u32)
}

fn value_key(value: &str) -> Value {
    Value::String(value.to_string())
}

fn set_string(map: &mut Mapping, key: &str, value: impl Into<String>) {
    map.insert(value_key(key), Value::String(value.into()));
}

fn set_bool(map: &mut Mapping, key: &str, value: bool) {
    map.insert(value_key(key), Value::Bool(value));
}

fn query_value(url: &Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find_map(|(candidate, value)| (candidate == key).then(|| value.into_owned()))
        .filter(|value| !value.trim().is_empty())
}

fn query_bool(url: &Url, key: &str) -> Option<bool> {
    query_value(url, key).and_then(|value| match value.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    })
}

fn set_alpn(map: &mut Mapping, url: &Url) {
    let Some(value) = query_value(url, "alpn") else {
        return;
    };
    let values = value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(|item| Value::String(item.to_string()))
        .collect::<Vec<_>>();
    if !values.is_empty() {
        map.insert(value_key("alpn"), Value::Sequence(values));
    }
}

fn decode_userinfo(value: &str, kind: &str, index: usize) -> Result<String, String> {
    percent_decode_str(value)
        .decode_utf8()
        .map(|decoded| decoded.into_owned())
        .map_err(|_| format!("第 {index} 个 {kind} 节点用户信息不是有效 UTF-8"))
}

fn proxy_name(url: &Url, index: usize, used_names: &mut HashSet<String>) -> Result<String, String> {
    let candidate = url
        .fragment()
        .map(|fragment| {
            percent_decode_str(fragment)
                .decode_utf8()
                .map(|decoded| decoded.into_owned())
                .map_err(|_| format!("第 {index} 个订阅节点名称不是有效 UTF-8"))
        })
        .transpose()?
        .filter(|fragment| !fragment.trim().is_empty())
        .unwrap_or_else(|| format!("Node {index}"));
    if used_names.insert(candidate.clone()) {
        return Ok(candidate);
    }
    for suffix in 2.. {
        let unique = format!("{candidate} {suffix}");
        if used_names.insert(unique.clone()) {
            return Ok(unique);
        }
    }
    unreachable!("the suffix loop always returns a unique name")
}

fn proxy_base(url: &Url, name: String, proxy_type: &str) -> Result<Mapping, String> {
    let server = url
        .host_str()
        .ok_or_else(|| "订阅节点缺少服务器地址".to_string())?;
    let port = url.port().ok_or_else(|| "订阅节点缺少端口".to_string())?;
    let mut map = Mapping::new();
    set_string(&mut map, "name", name);
    set_string(&mut map, "type", proxy_type);
    set_string(&mut map, "server", server);
    map.insert(value_key("port"), serde_yaml::to_value(port).unwrap());
    Ok(map)
}

fn parse_proxy_uri(
    line: &str,
    index: usize,
    used_names: &mut HashSet<String>,
) -> Result<Value, String> {
    let url = Url::parse(line).map_err(|_| format!("第 {index} 个订阅节点 URL 无效"))?;
    let name = proxy_name(&url, index, used_names)?;
    let scheme = url.scheme().to_ascii_lowercase();
    let map = match scheme.as_str() {
        "vless" => {
            let mut map = proxy_base(&url, name, "vless")?;
            let uuid = decode_userinfo(url.username(), "VLESS", index)?;
            if uuid.is_empty() {
                return Err(format!("第 {index} 个 VLESS 节点缺少 UUID"));
            }
            set_string(&mut map, "uuid", uuid);
            set_bool(&mut map, "udp", true);
            let network = query_value(&url, "type").unwrap_or_else(|| "tcp".to_string());
            set_string(&mut map, "network", network.clone());
            let security = query_value(&url, "security");
            if security.as_deref().is_some_and(|value| value != "none") {
                set_bool(&mut map, "tls", true);
            }
            if let Some(value) = query_value(&url, "sni") {
                set_string(&mut map, "servername", value);
            }
            if let Some(value) = query_value(&url, "fp") {
                set_string(&mut map, "client-fingerprint", value);
            }
            if let Some(value) = query_value(&url, "flow") {
                set_string(&mut map, "flow", value);
            }
            if let Some(value) = query_value(&url, "encryption") {
                set_string(
                    &mut map,
                    "encryption",
                    if value == "none" { "" } else { &value },
                );
            }
            if let Some(public_key) = query_value(&url, "pbk") {
                let mut reality = Mapping::new();
                set_string(&mut reality, "public-key", public_key);
                if let Some(short_id) = query_value(&url, "sid") {
                    set_string(&mut reality, "short-id", short_id);
                }
                map.insert(value_key("reality-opts"), Value::Mapping(reality));
            }
            if network.eq_ignore_ascii_case("ws") {
                let mut ws = Mapping::new();
                if let Some(path) = query_value(&url, "path") {
                    set_string(&mut ws, "path", path);
                }
                if let Some(host) = query_value(&url, "host") {
                    let mut headers = Mapping::new();
                    set_string(&mut headers, "Host", host);
                    ws.insert(value_key("headers"), Value::Mapping(headers));
                }
                if !ws.is_empty() {
                    map.insert(value_key("ws-opts"), Value::Mapping(ws));
                }
            }
            if network.eq_ignore_ascii_case("grpc") {
                if let Some(service_name) = query_value(&url, "serviceName") {
                    let mut grpc = Mapping::new();
                    set_string(&mut grpc, "grpc-service-name", service_name);
                    map.insert(value_key("grpc-opts"), Value::Mapping(grpc));
                }
            }
            if query_bool(&url, "allowInsecure").or_else(|| query_bool(&url, "insecure"))
                == Some(true)
            {
                set_bool(&mut map, "skip-cert-verify", true);
            }
            set_alpn(&mut map, &url);
            map
        }
        "hysteria2" | "hy2" => {
            let mut map = proxy_base(&url, name, "hysteria2")?;
            let password = match query_value(&url, "password") {
                Some(value) => value,
                None => decode_userinfo(url.username(), "Hysteria2", index)?,
            };
            if password.is_empty() {
                return Err(format!("第 {index} 个 Hysteria2 节点缺少密码"));
            }
            set_string(&mut map, "password", password);
            if let Some(value) = query_value(&url, "sni") {
                set_string(&mut map, "sni", value);
            }
            if query_bool(&url, "insecure") == Some(true) {
                set_bool(&mut map, "skip-cert-verify", true);
            }
            if let Some(value) = query_value(&url, "obfs") {
                set_string(&mut map, "obfs", value);
            }
            if let Some(value) = query_value(&url, "obfs-password") {
                set_string(&mut map, "obfs-password", value);
            }
            set_alpn(&mut map, &url);
            map
        }
        "tuic" => {
            let mut map = proxy_base(&url, name, "tuic")?;
            let uuid = match query_value(&url, "uuid") {
                Some(value) => value,
                None => decode_userinfo(url.username(), "TUIC", index)?,
            };
            let password = if let Some(value) = query_value(&url, "password") {
                Some(value)
            } else {
                url.password()
                    .map(|value| decode_userinfo(value, "TUIC", index))
                    .transpose()?
            };
            let token = query_value(&url, "token");
            let has_credentials =
                !uuid.is_empty() && password.as_deref().is_some_and(|value| !value.is_empty());
            if !has_credentials && token.is_none() {
                return Err(format!("第 {index} 个 TUIC 节点缺少 UUID 或密码"));
            }
            if has_credentials {
                set_string(&mut map, "uuid", uuid);
                set_string(&mut map, "password", password.unwrap_or_default());
            }
            if let Some(value) = query_value(&url, "sni") {
                set_string(&mut map, "sni", value);
            }
            if query_bool(&url, "insecure") == Some(true) {
                set_bool(&mut map, "skip-cert-verify", true);
            }
            if let Some(value) = query_value(&url, "congestion_control") {
                set_string(&mut map, "congestion-controller", value);
            }
            if let Some(value) = query_value(&url, "udp_relay_mode") {
                set_string(&mut map, "udp-relay-mode", value);
            }
            if let Some(value) = query_bool(&url, "reduce_rtt") {
                set_bool(&mut map, "reduce-rtt", value);
            }
            if let Some(value) = query_bool(&url, "disable_sni") {
                set_bool(&mut map, "disable-sni", value);
            }
            if let Some(value) = token {
                set_string(&mut map, "token", value);
            }
            set_alpn(&mut map, &url);
            map
        }
        _ => return Err(format!("订阅节点协议暂不支持：{scheme}")),
    };
    Ok(Value::Mapping(map))
}

fn uri_subscription_to_yaml(source: &str) -> Result<String, String> {
    let mut proxies = Vec::new();
    let mut used_names = HashSet::new();
    used_names.insert("DIRECT".to_string());
    for (offset, line) in source.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        proxies.push(parse_proxy_uri(line, offset + 1, &mut used_names)?);
    }
    if proxies.is_empty() {
        return Err("订阅中没有可用节点".to_string());
    }

    let proxy_names = proxies
        .iter()
        .filter_map(|proxy| proxy.get("name").and_then(Value::as_str))
        .map(|name| Value::String(name.to_string()))
        .chain(std::iter::once(Value::String("DIRECT".to_string())))
        .collect::<Vec<_>>();
    let mut group = Mapping::new();
    set_string(&mut group, "name", "PROXY");
    set_string(&mut group, "type", "select");
    group.insert(value_key("proxies"), Value::Sequence(proxy_names));

    let mut dns = Mapping::new();
    set_bool(&mut dns, "enable", true);
    set_string(&mut dns, "enhanced-mode", "redir-host");
    dns.insert(
        value_key("nameserver"),
        Value::Sequence(vec![
            Value::String("1.1.1.1".to_string()),
            Value::String("8.8.8.8".to_string()),
        ]),
    );

    let mut root = Mapping::new();
    root.insert(
        value_key("mixed-port"),
        serde_yaml::to_value(7890u16).unwrap(),
    );
    set_bool(&mut root, "allow-lan", false);
    set_string(&mut root, "mode", "rule");
    set_string(&mut root, "log-level", "info");
    root.insert(value_key("proxies"), Value::Sequence(proxies));
    root.insert(
        value_key("proxy-groups"),
        Value::Sequence(vec![Value::Mapping(group)]),
    );
    root.insert(
        value_key("rules"),
        Value::Sequence(vec![Value::String("MATCH,PROXY".to_string())]),
    );
    root.insert(value_key("dns"), Value::Mapping(dns));
    serde_yaml::to_string(&Value::Mapping(root)).map_err(|e| format!("生成订阅 YAML 失败：{e}"))
}

fn decode_subscription_source(body: &str) -> Result<String, String> {
    let trimmed = body.trim();
    if trimmed.lines().any(|line| line.contains("://")) {
        return Ok(trimmed.to_string());
    }

    let compact = trimmed
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    let decoded = [
        general_purpose::STANDARD.decode(compact.as_bytes()),
        general_purpose::STANDARD_NO_PAD.decode(compact.as_bytes()),
        general_purpose::URL_SAFE.decode(compact.as_bytes()),
        general_purpose::URL_SAFE_NO_PAD.decode(compact.as_bytes()),
    ]
    .into_iter()
    .find_map(Result::ok)
    .ok_or_else(|| "订阅格式不是 Mihomo YAML 或可识别的 Base64 节点列表".to_string())?;
    String::from_utf8(decoded).map_err(|_| "订阅 Base64 内容不是 UTF-8 文本".to_string())
}

fn normalize_subscription_body(body: &str) -> Result<String, String> {
    if let Ok(value) = serde_yaml::from_str::<Value>(body) {
        if value.is_mapping() {
            return Ok(body.to_string());
        }
    }
    let decoded = decode_subscription_source(body)?;
    if let Ok(value) = serde_yaml::from_str::<Value>(&decoded) {
        if value.is_mapping() {
            return Ok(decoded);
        }
    }
    uri_subscription_to_yaml(&decoded)
}

#[tauri::command]
pub fn profile_list(app: AppHandle) -> Result<Vec<Profile>, String> {
    read_profiles(&app)
}

#[tauri::command]
pub fn profile_add(app: AppHandle, name: String, url: String) -> Result<Profile, String> {
    let url = validate_subscription_url(&url)?;
    let name = name.trim();
    if name.is_empty() {
        return Err("Profile 名称不能为空".to_string());
    }

    let mut profiles = read_profiles(&app)?;
    if profiles.iter().any(|profile| profile.url == url) {
        return Err("这个订阅 URL 已经添加".to_string());
    }

    let profile = Profile {
        id: generate_profile_id()?,
        name: name.to_string(),
        url,
        file_path: None,
        updated_at: None,
        node_count: None,
    };
    profiles.push(profile.clone());
    write_profiles(&app, &profiles)?;
    Ok(profile)
}

#[tauri::command]
pub async fn profile_download(app: AppHandle, id: String) -> Result<Profile, String> {
    let _transition = crate::tun::lock_transitions().await;
    if crate::tun::is_active(&app) {
        return Err("请先关闭 TUN，再更新 Profile".to_string());
    }
    if let Some(tun) = crate::service::service_tun_status(&app).await? {
        if tun.status != crate::tun::TunStatus::Disabled {
            return Err("请先关闭 Service 管理的 TUN，再更新 Profile".to_string());
        }
    }
    let mut profiles = read_profiles(&app)?;
    let profile = profiles
        .iter()
        .find(|profile| profile.id == id)
        .cloned()
        .ok_or_else(|| "找不到这个 Profile".to_string())?;

    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(&profile.url)
        .header("User-Agent", "MioProxy/0.2")
        .send()
        .await
        .map_err(|e| format!("订阅下载失败：{e}"))?
        .error_for_status()
        .map_err(|e| format!("订阅响应失败：{e}"))?;
    let body = response
        .text()
        .await
        .map_err(|e| format!("读取订阅失败：{e}"))?;
    if body.trim().is_empty() {
        return Err("订阅响应为空".to_string());
    }
    let body = normalize_subscription_body(&body)?;

    let path = data_dir(&app)?
        .join("profiles")
        .join(format!("{}.yaml", profile.id));
    write_atomic(&path, body.as_bytes())?;

    let updated_at = timestamp();
    let updated = {
        let updated = profiles
            .iter_mut()
            .find(|candidate| candidate.id == id)
            .ok_or_else(|| "找不到这个 Profile".to_string())?;
        updated.file_path = Some(path.display().to_string());
        updated.updated_at = Some(updated_at);
        updated.node_count = count_nodes(&body);
        updated.clone()
    };
    write_profiles(&app, &profiles)?;
    Ok(updated)
}

#[tauri::command]
pub async fn profile_apply(app: AppHandle, id: String) -> Result<String, String> {
    crate::config::apply_profile(app, id).await
}

#[tauri::command]
pub async fn profile_remove(app: AppHandle, id: String) -> Result<(), String> {
    let _transition = crate::tun::lock_transitions().await;
    if crate::tun::is_active(&app) {
        return Err("请先关闭 TUN，再删除 Profile".to_string());
    }
    if let Some(tun) = crate::service::service_tun_status(&app).await? {
        if tun.status != crate::tun::TunStatus::Disabled {
            return Err("请先关闭 Service 管理的 TUN，再删除 Profile".to_string());
        }
    }
    let mut profiles = read_profiles(&app)?;
    let index = profiles
        .iter()
        .position(|profile| profile.id == id)
        .ok_or_else(|| "找不到这个 Profile".to_string())?;
    if let Some(path) = profiles[index].file_path.as_ref() {
        if Path::new(path).exists() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    profiles.remove(index);
    write_profiles(&app, &profiles)
}

#[cfg(test)]
mod tests {
    use super::{generate_profile_id, normalize_subscription_body};
    use base64::{engine::general_purpose, Engine as _};
    use serde_yaml::Value;

    #[test]
    fn normalizes_base64_proxy_subscription() {
        let source = concat!(
            "vless://11111111-1111-1111-1111-111111111111@example.com:443?type=grpc&security=reality&pbk=public-key&sid=short-id&sni=example.com&serviceName=update&fp=chrome&alpn=h2&allowInsecure=1#Alpha\n",
            "hysteria2://password@example.org:443?insecure=1&sni=example.org&obfs=salamander&obfs-password=obfs-pass#Beta\n",
            "tuic://22222222-2222-2222-2222-222222222222:password@example.net:443?insecure=1&sni=example.net&congestion_control=bbr&udp_relay_mode=quic#Gamma\n",
        );
        let encoded = general_purpose::STANDARD.encode(source);
        let yaml = normalize_subscription_body(&encoded).unwrap();
        let value = serde_yaml::from_str::<Value>(&yaml).unwrap();
        let proxies = value["proxies"].as_sequence().unwrap();
        assert_eq!(proxies.len(), 3);
        assert_eq!(proxies[0]["type"].as_str(), Some("vless"));
        assert_eq!(proxies[0]["network"].as_str(), Some("grpc"));
        assert_eq!(
            proxies[0]["reality-opts"]["public-key"].as_str(),
            Some("public-key")
        );
        assert_eq!(proxies[0]["alpn"][0].as_str(), Some("h2"));
        assert_eq!(proxies[0]["skip-cert-verify"].as_bool(), Some(true));
        assert_eq!(proxies[1]["type"].as_str(), Some("hysteria2"));
        assert_eq!(proxies[1]["skip-cert-verify"].as_bool(), Some(true));
        assert_eq!(proxies[2]["type"].as_str(), Some("tuic"));
        assert_eq!(proxies[2]["congestion-controller"].as_str(), Some("bbr"));
        assert_eq!(
            value["proxy-groups"][0]["proxies"][3].as_str(),
            Some("DIRECT")
        );
        assert_eq!(value["rules"][0].as_str(), Some("MATCH,PROXY"));
    }

    #[test]
    fn keeps_mihomo_yaml_profiles_unchanged() {
        let source = "mixed-port: 7890\nproxies: []\n";
        assert_eq!(normalize_subscription_body(source).unwrap(), source);
    }

    #[test]
    fn imports_ws_options_and_decodes_userinfo() {
        let source = concat!(
            "vless://11111111-1111-1111-1111-111111111111@example.com:443?type=ws&path=%2Fedge&host=cdn.example.com#WS\n",
            "hysteria2://p%40ss@example.org:443#Hy2\n",
            "tuic://22222222-2222-2222-2222-222222222222:pass%40word@example.net:443#TUIC\n",
        );
        let yaml = normalize_subscription_body(source).unwrap();
        let value = serde_yaml::from_str::<Value>(&yaml).unwrap();
        let proxies = value["proxies"].as_sequence().unwrap();
        assert_eq!(proxies[0]["ws-opts"]["path"].as_str(), Some("/edge"));
        assert_eq!(
            proxies[0]["ws-opts"]["headers"]["Host"].as_str(),
            Some("cdn.example.com")
        );
        assert_eq!(proxies[1]["password"].as_str(), Some("p@ss"));
        assert_eq!(proxies[2]["password"].as_str(), Some("pass@word"));
    }

    #[test]
    fn accepts_tuic_token_authentication() {
        let yaml = normalize_subscription_body(
            "tuic://example.net:443?token=token-value&sni=example.net#Token",
        )
        .unwrap();
        let value = serde_yaml::from_str::<Value>(&yaml).unwrap();
        assert_eq!(value["proxies"][0]["token"].as_str(), Some("token-value"));
        assert!(value["proxies"][0].get("uuid").is_none());
        assert!(value["proxies"][0].get("password").is_none());
    }

    #[test]
    fn reserves_direct_for_the_builtin_outbound() {
        let yaml = normalize_subscription_body(
            "vless://11111111-1111-1111-1111-111111111111@example.com:443#DIRECT",
        )
        .unwrap();
        let value = serde_yaml::from_str::<Value>(&yaml).unwrap();
        assert_eq!(value["proxies"][0]["name"].as_str(), Some("DIRECT 2"));
        assert_eq!(
            value["proxy-groups"][0]["proxies"][0].as_str(),
            Some("DIRECT 2")
        );
        assert_eq!(
            value["proxy-groups"][0]["proxies"][1].as_str(),
            Some("DIRECT")
        );
    }

    #[test]
    fn accepts_unpadded_standard_base64() {
        let source = "vless://11111111-1111-1111-1111-111111111111@example.com:443#A~";
        let encoded = general_purpose::STANDARD_NO_PAD.encode(source);
        let yaml = normalize_subscription_body(&encoded).unwrap();
        let value = serde_yaml::from_str::<Value>(&yaml).unwrap();
        assert_eq!(value["proxies"][0]["name"].as_str(), Some("A~"));
    }

    #[test]
    fn decodes_percent_encoded_proxy_names() {
        let source = "vless://11111111-1111-1111-1111-111111111111@example.com:443#Hong%20Kong";
        let yaml = normalize_subscription_body(source).unwrap();
        let value = serde_yaml::from_str::<Value>(&yaml).unwrap();
        assert_eq!(value["proxies"][0]["name"].as_str(), Some("Hong Kong"));
    }

    #[test]
    fn generates_unique_profile_ids_for_rapid_additions() {
        let first = generate_profile_id().unwrap();
        let second = generate_profile_id().unwrap();

        assert_ne!(first, second);
        assert!(first.starts_with("profile-"));
        assert_eq!(first.len(), "profile-".len() + 32);
    }
}
