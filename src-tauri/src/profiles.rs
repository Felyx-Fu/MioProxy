use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
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

fn count_nodes(body: &str) -> Option<u32> {
    let yaml = serde_yaml::from_str::<serde_yaml::Value>(body).ok()?;
    yaml.get("proxies")?
        .as_sequence()
        .map(|items| items.len() as u32)
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
        id: format!("profile-{}", timestamp()),
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
pub fn profile_remove(app: AppHandle, id: String) -> Result<(), String> {
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
