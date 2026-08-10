use std::{
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::Ordering,
};

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

use reqwest::{Client, Url};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;
use zip::ZipArchive;

const MIHOMO_RELEASE_ENDPOINT: &str =
    "https://api.github.com/repos/MetaCubeX/mihomo/releases/latest";
const MAX_RELEASE_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_CORE_ARCHIVE_BYTES: usize = 128 * 1024 * 1024;
const MAX_CORE_BINARY_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CoreUpdatePhase {
    #[default]
    Idle,
    Checking,
    Available,
    Downloading,
    Verifying,
    Staging,
    Installing,
    Restarting,
    Completed,
    Error,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreUpdateStatus {
    pub current_version: Option<String>,
    pub available_version: Option<String>,
    pub asset_name: Option<String>,
    pub phase: CoreUpdatePhase,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct CoreRelease {
    pub version: Version,
    pub asset_name: String,
    pub download_url: Url,
    pub sha256: String,
}

#[derive(Debug, Deserialize)]
struct ReleaseAsset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ReleaseResponse {
    tag_name: String,
    #[serde(default)]
    prerelease: bool,
    assets: Vec<ReleaseAsset>,
}

fn github_client() -> Result<Client, String> {
    Client::builder()
        .user_agent("MioProxy-Core-Updater/0.9")
        .build()
        .map_err(|error| format!("创建 Mihomo 更新客户端失败：{error}"))
}

fn parse_sha256(digest: Option<&str>) -> Result<String, String> {
    let value = digest
        .and_then(|value| value.strip_prefix("sha256:"))
        .ok_or_else(|| "官方 Mihomo Release 缺少 SHA-256 摘要，拒绝更新".to_string())?
        .trim()
        .to_ascii_lowercase();
    if value.len() != 64 || value.bytes().any(|byte| !byte.is_ascii_hexdigit()) {
        return Err("官方 Mihomo Release 的 SHA-256 摘要格式无效，拒绝更新".to_string());
    }
    Ok(value)
}

fn validate_download_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|error| format!("Mihomo Release 下载地址无效：{error}"))?;
    let valid = url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url
            .path()
            .starts_with("/MetaCubeX/mihomo/releases/download/");
    if !valid {
        return Err("Mihomo Core 只允许从官方 GitHub Release 下载，已拒绝该地址".to_string());
    }
    Ok(url)
}

fn is_candidate_asset(name: &str, compatible: bool) -> bool {
    let prefix = if compatible {
        "mihomo-windows-amd64-compatible-"
    } else {
        "mihomo-windows-amd64-"
    };
    !name.is_empty()
        && !name.contains(['/', '\\'])
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        && name.starts_with(prefix)
        && name.ends_with(".zip")
}

pub(crate) fn parse_release(body: &[u8]) -> Result<CoreRelease, String> {
    if body.len() > MAX_RELEASE_JSON_BYTES {
        return Err("Mihomo Release 元数据过大，拒绝解析".to_string());
    }
    let release: ReleaseResponse = serde_json::from_slice(body)
        .map_err(|error| format!("Mihomo Release 元数据无效：{error}"))?;
    if release.prerelease {
        return Err("官方 Mihomo 最新 Release 是预发布版本，拒绝自动使用".to_string());
    }
    let version = crate::update::parse_version(&release.tag_name)?;
    let asset = release
        .assets
        .iter()
        .find(|asset| is_candidate_asset(&asset.name, true))
        .or_else(|| {
            release
                .assets
                .iter()
                .find(|asset| is_candidate_asset(&asset.name, false))
        })
        .ok_or_else(|| "官方 Mihomo Release 没有 Windows x86_64 ZIP 包".to_string())?;
    Ok(CoreRelease {
        version,
        asset_name: asset.name.clone(),
        download_url: validate_download_url(&asset.browser_download_url)?,
        sha256: parse_sha256(asset.digest.as_deref())?,
    })
}

pub(crate) async fn latest_release(current: Option<&str>) -> Result<Option<CoreRelease>, String> {
    let client = github_client()?;
    let response = client
        .get(MIHOMO_RELEASE_ENDPOINT)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("检查 Mihomo 官方 Release 失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "检查 Mihomo 官方 Release 失败：HTTP {}",
            response.status()
        ));
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("读取 Mihomo Release 元数据失败：{error}"))?;
    let release = parse_release(&body)?;
    if let Some(current) = current {
        let current = crate::update::parse_version(current)?;
        if release.version <= current {
            return Ok(None);
        }
    }
    Ok(Some(release))
}

fn digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn ensure_regular_file(path: &Path, label: &str) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("读取 {label} 属性失败：{error}"))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(format!("拒绝使用非普通文件形式的 {label}"));
    }
    Ok(())
}

#[cfg(windows)]
fn ensure_not_reparse(path: &Path, label: &str) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取 {label} 属性失败：{error}")),
    };
    if metadata.file_attributes() & 0x400 != 0 {
        return Err(format!("拒绝使用 Reparse Point {label}"));
    }
    Ok(())
}

#[cfg(not(windows))]
fn ensure_not_reparse(path: &Path, label: &str) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取 {label} 属性失败：{error}")),
    };
    if metadata.file_type().is_symlink() {
        return Err(format!("拒绝使用符号链接 {label}"));
    }
    Ok(())
}

fn extract_core(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("Mihomo ZIP 包无效：{error}"))?;
    let mut candidate = None;
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|error| format!("读取 Mihomo ZIP 条目失败：{error}"))?;
        let Some(path) = file.enclosed_name() else {
            return Err("Mihomo ZIP 包包含越界路径，拒绝解压".to_string());
        };
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if file.is_file() && name.eq_ignore_ascii_case("mihomo.exe") {
            candidate = Some(index);
            break;
        }
    }
    let index = candidate.ok_or_else(|| "Mihomo ZIP 包中没有 mihomo.exe".to_string())?;
    let file = archive
        .by_index(index)
        .map_err(|error| format!("读取 Mihomo Core 条目失败：{error}"))?;
    let mut output = Vec::new();
    file.take((MAX_CORE_BINARY_BYTES + 1) as u64)
        .read_to_end(&mut output)
        .map_err(|error| format!("解压 Mihomo Core 失败：{error}"))?;
    if output.len() > MAX_CORE_BINARY_BYTES {
        return Err("Mihomo Core 文件过大，拒绝写入 staging".to_string());
    }
    Ok(output)
}

pub(crate) async fn download_to_staging(
    release: &CoreRelease,
    updates_dir: &Path,
) -> Result<PathBuf, String> {
    fs::create_dir_all(updates_dir)
        .map_err(|error| format!("创建 Core staging 目录失败：{error}"))?;
    ensure_not_reparse(updates_dir, "Core staging 目录")?;
    let client = github_client()?;
    let response = client
        .get(release.download_url.clone())
        .header("Accept", "application/octet-stream")
        .send()
        .await
        .map_err(|error| format!("下载 Mihomo Core 失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("下载 Mihomo Core 失败：HTTP {}", response.status()));
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("读取 Mihomo Core 下载内容失败：{error}"))?;
    if body.len() > MAX_CORE_ARCHIVE_BYTES {
        return Err("Mihomo Core ZIP 包过大，拒绝写入 staging".to_string());
    }
    if digest(&body) != release.sha256 {
        return Err("Mihomo Core SHA-256 校验失败，拒绝安装".to_string());
    }
    let archive_path = updates_dir.join(&release.asset_name);
    crate::config::write_atomic(&archive_path, &body)?;
    let binary = extract_core(&body)?;
    let staged_path = updates_dir.join("mihomo.exe.staged");
    crate::config::write_atomic(&staged_path, &binary)?;
    ensure_regular_file(&staged_path, "staged Mihomo Core")?;
    Ok(staged_path)
}

pub(crate) fn validate_config(
    staged_path: &Path,
    data_dir: &Path,
    config_path: &Path,
) -> Result<(), String> {
    ensure_regular_file(staged_path, "staged Mihomo Core")?;
    let output = Command::new(staged_path)
        .args(["-t", "-d"])
        .arg(data_dir)
        .args(["-f"])
        .arg(config_path)
        .output()
        .map_err(|error| format!("执行 Mihomo 配置校验失败：{error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(format!(
        "Mihomo 配置校验失败：{}",
        if stderr.is_empty() { stdout } else { stderr }
    ))
}

#[derive(Debug, Clone)]
pub(crate) struct CoreBackup {
    pub core_path: PathBuf,
    pub backup_path: PathBuf,
    pub had_original: bool,
}

pub(crate) fn replace_core(core_path: &Path, staged_path: &Path) -> Result<CoreBackup, String> {
    ensure_regular_file(staged_path, "staged Mihomo Core")?;
    ensure_not_reparse(staged_path, "staged Mihomo Core")?;
    if core_path.exists() {
        ensure_regular_file(core_path, "当前 Mihomo Core")?;
    }
    let parent = core_path
        .parent()
        .ok_or_else(|| "无法确定 Mihomo Core 目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建 Mihomo Core 目录失败：{error}"))?;
    ensure_not_reparse(parent, "Mihomo Core 目录")?;
    let replacement = parent.join(".mihomo.exe.replacement");
    let backup_path = core_path.with_file_name("mihomo.exe.backup");
    ensure_not_reparse(core_path, "当前 Mihomo Core")?;
    ensure_not_reparse(&replacement, "Mihomo Core replacement")?;
    ensure_not_reparse(&backup_path, "旧 Mihomo Core 备份")?;
    let _ = fs::remove_file(&replacement);
    if backup_path.exists() {
        ensure_regular_file(&backup_path, "旧 Mihomo Core 备份")?;
        return Err("检测到未完成的 Mihomo Core 备份，已拒绝覆盖；请先完成启动恢复".to_string());
    }
    fs::copy(staged_path, &replacement)
        .map_err(|error| format!("复制 Mihomo Core replacement 失败：{error}"))?;
    let had_original = core_path.exists();
    if had_original {
        if let Err(error) = fs::rename(core_path, &backup_path) {
            let _ = fs::remove_file(&replacement);
            return Err(format!("保存旧 Mihomo Core 备份失败：{error}"));
        }
    }
    if let Err(error) = fs::rename(&replacement, core_path) {
        if had_original {
            let _ = fs::rename(&backup_path, core_path);
        }
        let _ = fs::remove_file(&replacement);
        return Err(format!("替换 Mihomo Core 失败：{error}"));
    }
    Ok(CoreBackup {
        core_path: core_path.to_path_buf(),
        backup_path,
        had_original,
    })
}

pub(crate) fn rollback_core(backup: &CoreBackup) -> Result<(), String> {
    ensure_not_reparse(&backup.core_path, "当前 Mihomo Core")?;
    ensure_not_reparse(&backup.backup_path, "旧 Mihomo Core 备份")?;
    let _ = fs::remove_file(&backup.core_path);
    if backup.had_original {
        fs::rename(&backup.backup_path, &backup.core_path)
            .map_err(|error| format!("回滚旧 Mihomo Core 失败：{error}"))?;
    }
    Ok(())
}

pub(crate) fn finalize_core(backup: &CoreBackup) -> Result<(), String> {
    if backup.had_original {
        ensure_not_reparse(&backup.backup_path, "旧 Mihomo Core 备份")?;
        fs::remove_file(&backup.backup_path)
            .map_err(|error| format!("删除旧 Mihomo Core 备份失败：{error}"))?;
    }
    Ok(())
}

pub(crate) fn recover_orphaned_backup(core_path: &Path) -> Result<bool, String> {
    let backup_path = core_path.with_file_name("mihomo.exe.backup");
    ensure_not_reparse(core_path, "当前 Mihomo Core")?;
    ensure_not_reparse(&backup_path, "旧 Mihomo Core 备份")?;
    if !backup_path.exists() {
        return Ok(false);
    }
    ensure_regular_file(&backup_path, "旧 Mihomo Core 备份")?;
    if core_path.exists() {
        ensure_regular_file(core_path, "当前 Mihomo Core")?;
        fs::remove_file(core_path)
            .map_err(|error| format!("清理未完成的 Mihomo Core 替换失败：{error}"))?;
    }
    fs::rename(&backup_path, core_path)
        .map_err(|error| format!("恢复未完成更新的旧 Mihomo Core 失败：{error}"))?;
    Ok(true)
}

async fn require_service_status(
    app: &tauri::AppHandle,
) -> Result<crate::service::ServiceStatusData, String> {
    crate::service::request_service_status(app)
        .await?
        .ok_or_else(|| "Mihomo Core 更新必须由 MioProxy Service 管理，当前 IPC 不可用".to_string())
}

#[tauri::command]
pub(crate) async fn mihomo_core_update_status(
    app: tauri::AppHandle,
) -> Result<CoreUpdateStatus, String> {
    Ok(require_service_status(&app).await?.core_update)
}

#[tauri::command]
pub(crate) async fn mihomo_core_update_check(
    app: tauri::AppHandle,
) -> Result<CoreUpdateStatus, String> {
    let Some(status) =
        crate::service::request_core_update(&app, crate::service::ServiceCommand::CoreCheck)
            .await?
    else {
        return Err("Mihomo Core 更新必须由 MioProxy Service 管理，当前 IPC 不可用".to_string());
    };
    Ok(status)
}

#[tauri::command]
pub(crate) async fn mihomo_core_update_install(
    app: tauri::AppHandle,
) -> Result<CoreUpdateStatus, String> {
    crate::ensure_mutations_allowed(&app)?;
    if crate::system_proxy::is_enabled_for_update(&app)? {
        return Err(
            "Core 更新前必须关闭 Windows System Proxy，避免 Mihomo 停止期间断网".to_string(),
        );
    }
    let lifecycle = app.state::<crate::AppLifecycle>();
    if lifecycle.updating.swap(true, Ordering::SeqCst) {
        return Err("MioProxy 已有更新或 Core 操作正在进行，拒绝并发修改".to_string());
    }
    let result = async {
        let Some(status) =
            crate::service::request_core_update(&app, crate::service::ServiceCommand::CoreInstall)
                .await?
        else {
            return Err(
                "Mihomo Core 更新必须由 MioProxy Service 管理，当前 IPC 不可用".to_string(),
            );
        };
        Ok(status)
    }
    .await;
    lifecycle.updating.store(false, Ordering::SeqCst);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::ZipWriter;

    fn release_json(digest: &str) -> Vec<u8> {
        serde_json::json!({
            "tag_name": "v1.19.28",
            "prerelease": false,
            "assets": [{
                "name": "mihomo-windows-amd64-compatible-v1.19.28.zip",
                "browser_download_url": "https://github.com/MetaCubeX/mihomo/releases/download/v1.19.28/mihomo-windows-amd64-compatible-v1.19.28.zip",
                "digest": format!("sha256:{digest}")
            }]
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn parses_official_windows_asset_and_digest() {
        let release = parse_release(&release_json(
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ))
        .expect("release metadata");
        assert_eq!(release.version, Version::parse("1.19.28").unwrap());
        assert_eq!(
            release.asset_name,
            "mihomo-windows-amd64-compatible-v1.19.28.zip"
        );
    }

    #[test]
    fn rejects_untrusted_release_download_url() {
        let body = String::from_utf8(release_json(
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ))
        .unwrap()
        .replace(
            "https://github.com/MetaCubeX",
            "https://example.com/MetaCubeX",
        );
        assert!(parse_release(body.as_bytes()).is_err());
    }

    #[test]
    fn rejects_missing_digest() {
        let body = String::from_utf8(release_json(
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ))
        .unwrap()
        .replace(",\"digest\":\"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"", "");
        assert!(parse_release(body.as_bytes()).is_err());
    }

    #[test]
    fn rejects_asset_names_with_path_separators() {
        let body = String::from_utf8(release_json(
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ))
        .unwrap()
        .replace(
            "mihomo-windows-amd64-compatible-v1.19.28.zip",
            "mihomo-windows-amd64-compatible-..\\evil.zip",
        );
        assert!(parse_release(body.as_bytes()).is_err());
    }

    #[test]
    fn stages_only_the_expected_mihomo_executable() {
        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        archive
            .start_file("mihomo.exe", zip::write::SimpleFileOptions::default())
            .expect("start mihomo entry");
        archive
            .write_all(b"trusted-core")
            .expect("write mihomo entry");
        archive
            .start_file("readme.txt", zip::write::SimpleFileOptions::default())
            .expect("start readme entry");
        archive.write_all(b"readme").expect("write readme entry");
        let bytes = archive.finish().expect("finish archive").into_inner();
        assert_eq!(extract_core(&bytes).expect("extract core"), b"trusted-core");
    }

    #[test]
    fn rolls_back_a_replaced_core_until_health_check_succeeds() {
        let root = std::env::temp_dir().join(format!(
            "mioproxy-core-update-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&root).expect("create test directory");
        let core = root.join("mihomo.exe");
        let staged = root.join("mihomo.exe.staged");
        fs::write(&core, b"old-core").expect("write old core");
        fs::write(&staged, b"new-core").expect("write staged core");
        let backup = replace_core(&core, &staged).expect("replace core");
        assert_eq!(fs::read(&core).expect("read new core"), b"new-core");
        rollback_core(&backup).expect("rollback core");
        assert_eq!(fs::read(&core).expect("read restored core"), b"old-core");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn restores_an_orphaned_backup_before_the_next_update() {
        let root = std::env::temp_dir().join(format!(
            "mioproxy-core-recovery-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&root).expect("create test directory");
        let core = root.join("mihomo.exe");
        let backup = root.join("mihomo.exe.backup");
        fs::write(&core, b"unhealthy-core").expect("write current core");
        fs::write(&backup, b"known-good-core").expect("write backup core");
        assert!(recover_orphaned_backup(&core).expect("recover backup"));
        assert_eq!(
            fs::read(&core).expect("read recovered core"),
            b"known-good-core"
        );
        assert!(!backup.exists());
        let _ = fs::remove_dir_all(root);
    }
}
