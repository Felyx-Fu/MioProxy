use std::{
    fmt, fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    process::Command,
    sync::{atomic::Ordering, Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

use futures_util::StreamExt;
use reqwest::{header::HeaderMap, Client, Response, StatusCode, Url};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;
use zip::ZipArchive;

use crate::config;

const MIHOMO_RELEASE_ENDPOINT: &str =
    "https://api.github.com/repos/MetaCubeX/mihomo/releases/latest";
const GITHUB_API_VERSION: &str = "2022-11-28";
const RELEASE_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const RELEASE_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RELEASE_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_RELEASE_ERROR_BODY_CHARS: usize = 512;
const MAX_RELEASE_ERROR_BODY_BYTES: usize = MAX_RELEASE_ERROR_BODY_CHARS * 4 + 1;
const DEFAULT_RATE_LIMIT_COOLDOWN: Duration = Duration::from_secs(60);
const MIN_RATE_LIMIT_COOLDOWN: Duration = Duration::from_secs(1);
const MAX_CORE_ARCHIVE_BYTES: usize = 128 * 1024 * 1024;
const MAX_CORE_BINARY_BYTES: usize = 128 * 1024 * 1024;

static RELEASE_CHECK_COOLDOWN: OnceLock<Mutex<ReleaseCheckCooldown>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GitHubReleaseErrorKind {
    RateLimited,
    Forbidden,
    ServerError,
    NetworkUnavailable,
    InvalidResponse,
}

impl fmt::Display for GitHubReleaseErrorKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::RateLimited => "RateLimited",
            Self::Forbidden => "Forbidden",
            Self::ServerError => "ServerError",
            Self::NetworkUnavailable => "NetworkUnavailable",
            Self::InvalidResponse => "InvalidResponse",
        })
    }
}

#[derive(Debug, Clone, Default)]
struct RateLimitEvidence {
    limit: Option<u64>,
    remaining: Option<u64>,
    reset_epoch: Option<u64>,
    retry_after: Option<String>,
    retry_after_present: bool,
    request_id: Option<String>,
}

impl RateLimitEvidence {
    fn from_headers(headers: &HeaderMap) -> Self {
        let retry_after_header = headers.get("retry-after");
        Self {
            limit: parse_header_u64(headers, "x-ratelimit-limit"),
            remaining: parse_header_u64(headers, "x-ratelimit-remaining"),
            reset_epoch: parse_header_u64(headers, "x-ratelimit-reset"),
            retry_after: retry_after_header.and_then(safe_header_text),
            retry_after_present: retry_after_header.is_some(),
            request_id: headers
                .get("x-github-request-id")
                .and_then(safe_header_text),
        }
    }
}

#[derive(Debug, Clone)]
struct RateLimitWait {
    delay: Duration,
    retry_at: Option<SystemTime>,
}

#[derive(Debug, Default)]
struct ReleaseCheckCooldown {
    blocked_until: Option<Instant>,
    retry_at: Option<SystemTime>,
}

impl ReleaseCheckCooldown {
    fn active_wait(&mut self) -> Option<RateLimitWait> {
        let blocked_until = self.blocked_until?;
        let now = Instant::now();
        if blocked_until <= now {
            self.blocked_until = None;
            self.retry_at = None;
            return None;
        }
        Some(RateLimitWait {
            delay: blocked_until.duration_since(now),
            retry_at: self.retry_at,
        })
    }

    fn block(&mut self, wait: &RateLimitWait) {
        let delay = wait.delay.max(MIN_RATE_LIMIT_COOLDOWN);
        let now = Instant::now();
        self.blocked_until = now
            .checked_add(delay)
            .or_else(|| now.checked_add(DEFAULT_RATE_LIMIT_COOLDOWN));
        self.retry_at = wait.retry_at;
    }
}

#[derive(Debug)]
struct GitHubReleaseError {
    kind: GitHubReleaseErrorKind,
    status: Option<u16>,
    evidence: RateLimitEvidence,
    retry: Option<RateLimitWait>,
    body_snippet: Option<String>,
    detail: Option<String>,
}

impl GitHubReleaseError {
    fn new(kind: GitHubReleaseErrorKind) -> Self {
        Self {
            kind,
            status: None,
            evidence: RateLimitEvidence::default(),
            retry: None,
            body_snippet: None,
            detail: None,
        }
    }

    fn network(detail: impl Into<String>) -> Self {
        let mut error = Self::new(GitHubReleaseErrorKind::NetworkUnavailable);
        error.detail = Some(detail.into());
        error
    }

    fn invalid(detail: impl Into<String>) -> Self {
        let mut error = Self::new(GitHubReleaseErrorKind::InvalidResponse);
        error.detail = Some(detail.into());
        error
    }

    fn user_message(&self) -> String {
        let mut message = match self.kind {
            GitHubReleaseErrorKind::RateLimited => {
                let mut message = "GitHub API 请求频率受限，请稍后再试".to_string();
                if let Some(retry) = self.retry.as_ref() {
                    message.push_str(&format_rate_limit_wait(retry));
                }
                if let (Some(remaining), Some(limit)) =
                    (self.evidence.remaining, self.evidence.limit)
                {
                    message.push_str(&format!("（配额 {remaining}/{limit}）"));
                }
                message
            }
            GitHubReleaseErrorKind::Forbidden => format!(
                "GitHub 拒绝了 Mihomo Release 检查请求（HTTP {}）",
                self.status.unwrap_or(403)
            ),
            GitHubReleaseErrorKind::ServerError => format!(
                "GitHub Mihomo Release 服务暂时不可用（HTTP {}）",
                self.status.unwrap_or(500)
            ),
            GitHubReleaseErrorKind::NetworkUnavailable => {
                "无法连接 GitHub Mihomo Release 服务，请检查网络连接后再试".to_string()
            }
            GitHubReleaseErrorKind::InvalidResponse => "GitHub Mihomo Release 响应无效".to_string(),
        };

        if let Some(detail) = self.detail.as_deref() {
            if matches!(
                self.kind,
                GitHubReleaseErrorKind::InvalidResponse
                    | GitHubReleaseErrorKind::NetworkUnavailable
            ) {
                message.push('：');
            } else {
                message.push('；');
            }
            message.push_str(detail);
        }
        if let Some(request_id) = self.evidence.request_id.as_deref() {
            message.push_str(&format!("；GitHub 请求 ID：{request_id}"));
        }
        if let Some(body) = self.body_snippet.as_deref() {
            message.push_str(&format!("；响应摘要：{body}"));
        }
        message
    }
}

#[derive(Debug)]
struct BoundedBody {
    bytes: Vec<u8>,
    truncated: bool,
}

fn safe_header_text(value: &reqwest::header::HeaderValue) -> Option<String> {
    let value = value.to_str().ok()?;
    let value: String = value
        .chars()
        .filter(|character| !character.is_control())
        .take(128)
        .collect();
    (!value.is_empty()).then_some(value)
}

fn parse_header_u64(headers: &HeaderMap, name: &str) -> Option<u64> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
}

fn classify_release_response(
    status: StatusCode,
    evidence: &RateLimitEvidence,
) -> GitHubReleaseErrorKind {
    if status == StatusCode::TOO_MANY_REQUESTS
        || (status == StatusCode::FORBIDDEN
            && (evidence.remaining == Some(0) || evidence.retry_after_present))
    {
        GitHubReleaseErrorKind::RateLimited
    } else if status == StatusCode::FORBIDDEN {
        GitHubReleaseErrorKind::Forbidden
    } else if status.is_server_error() {
        GitHubReleaseErrorKind::ServerError
    } else {
        GitHubReleaseErrorKind::InvalidResponse
    }
}

fn retry_wait_from_system_time(target: SystemTime, now: SystemTime) -> Option<RateLimitWait> {
    let delay = target.duration_since(now).ok()?;
    Some(RateLimitWait {
        delay: delay.max(MIN_RATE_LIMIT_COOLDOWN),
        retry_at: Some(target),
    })
}

fn parse_retry_after(value: &str, now: SystemTime) -> Option<RateLimitWait> {
    let value = value.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        let delay = Duration::from_secs(seconds);
        return Some(RateLimitWait {
            delay: delay.max(MIN_RATE_LIMIT_COOLDOWN),
            retry_at: (seconds > 0).then(|| now.checked_add(delay)).flatten(),
        });
    }

    let timestamp = chrono::DateTime::parse_from_rfc2822(value)
        .ok()?
        .timestamp();
    if timestamp < 0 {
        return None;
    }
    let target = UNIX_EPOCH.checked_add(Duration::from_secs(timestamp as u64))?;
    retry_wait_from_system_time(target, now)
}

fn rate_limit_wait(evidence: &RateLimitEvidence) -> RateLimitWait {
    let now = SystemTime::now();
    if let Some(retry_after) = evidence.retry_after.as_deref() {
        if let Some(wait) = parse_retry_after(retry_after, now) {
            return wait;
        }
    }
    if let Some(reset_epoch) = evidence.reset_epoch {
        if let Some(target) = UNIX_EPOCH.checked_add(Duration::from_secs(reset_epoch)) {
            if let Some(wait) = retry_wait_from_system_time(target, now) {
                return wait;
            }
        }
    }
    RateLimitWait {
        delay: DEFAULT_RATE_LIMIT_COOLDOWN,
        retry_at: None,
    }
}

fn format_wait_duration(delay: Duration) -> String {
    let seconds = delay
        .as_secs()
        .saturating_add(u64::from(delay.subsec_nanos() > 0))
        .max(1);
    if seconds >= 3600 {
        format!("约 {} 小时后可重试", seconds.div_ceil(3600))
    } else if seconds >= 60 {
        format!("约 {} 分钟后可重试", seconds.div_ceil(60))
    } else {
        format!("约 {} 秒后可重试", seconds)
    }
}

fn format_rate_limit_wait(wait: &RateLimitWait) -> String {
    let mut message = format!("（{}", format_wait_duration(wait.delay));
    if let Some(retry_at) = wait.retry_at {
        let local = chrono::DateTime::<chrono::Local>::from(retry_at);
        message.push_str(&format!("，预计本地时间 {}", local.format("%H:%M")));
    }
    message.push('）');
    message
}

fn bounded_body_snippet(body: &BoundedBody) -> Option<String> {
    if body.bytes.is_empty() {
        return None;
    }
    let text = String::from_utf8_lossy(&body.bytes);
    let mut snippet = String::new();
    for character in text.chars().take(MAX_RELEASE_ERROR_BODY_CHARS) {
        snippet.push(if character.is_control() {
            ' '
        } else {
            character
        });
    }
    if body.truncated || text.chars().count() > MAX_RELEASE_ERROR_BODY_CHARS {
        snippet.push('…');
    }
    Some(snippet)
}

async fn read_bounded_body(
    response: Response,
    limit: usize,
) -> Result<BoundedBody, reqwest::Error> {
    let capture_limit = limit.saturating_add(1);
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::with_capacity(capture_limit.min(16 * 1024));
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        let remaining = capture_limit.saturating_sub(bytes.len());
        if remaining == 0 {
            return Ok(BoundedBody {
                bytes,
                truncated: true,
            });
        }
        if chunk.len() > remaining {
            bytes.extend_from_slice(&chunk[..remaining]);
            return Ok(BoundedBody {
                bytes,
                truncated: true,
            });
        }
        bytes.extend_from_slice(&chunk);
        if bytes.len() == capture_limit {
            return Ok(BoundedBody {
                bytes,
                truncated: true,
            });
        }
    }
    Ok(BoundedBody {
        bytes,
        truncated: false,
    })
}

async fn non_success_error(response: Response) -> GitHubReleaseError {
    let status = response.status();
    let evidence = RateLimitEvidence::from_headers(response.headers());
    let kind = classify_release_response(status, &evidence);
    let retry = (kind == GitHubReleaseErrorKind::RateLimited).then(|| rate_limit_wait(&evidence));
    let (body_snippet, detail) =
        match read_bounded_body(response, MAX_RELEASE_ERROR_BODY_BYTES).await {
            Ok(body) => (bounded_body_snippet(&body), None),
            Err(error) => (None, Some(format!("读取 GitHub 错误响应失败：{error}"))),
        };
    GitHubReleaseError {
        kind,
        status: Some(status.as_u16()),
        evidence,
        retry,
        body_snippet,
        detail,
    }
}

fn release_check_cooldown() -> &'static Mutex<ReleaseCheckCooldown> {
    RELEASE_CHECK_COOLDOWN.get_or_init(|| Mutex::new(ReleaseCheckCooldown::default()))
}

fn active_cooldown(
    cooldown: &Mutex<ReleaseCheckCooldown>,
) -> Result<Option<RateLimitWait>, String> {
    cooldown
        .lock()
        .map_err(|_| "GitHub Release cooldown 状态锁异常".to_string())
        .map(|mut state| state.active_wait())
}

fn record_cooldown(
    cooldown: &Mutex<ReleaseCheckCooldown>,
    wait: &RateLimitWait,
) -> Result<(), String> {
    cooldown
        .lock()
        .map_err(|_| "GitHub Release cooldown 状态锁异常".to_string())
        .map(|mut state| state.block(wait))
}

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

fn github_release_check_client() -> Result<Client, String> {
    Client::builder()
        .user_agent("MioProxy-Core-Updater/0.9")
        .connect_timeout(RELEASE_CONNECT_TIMEOUT)
        .timeout(RELEASE_REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("创建 Mihomo Release 检查客户端失败：{error}"))
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

async fn latest_release_at(
    client: &Client,
    endpoint: &str,
    current: Option<&str>,
    cooldown: &Mutex<ReleaseCheckCooldown>,
) -> Result<Option<CoreRelease>, String> {
    if let Some(wait) = active_cooldown(cooldown)? {
        let mut error = GitHubReleaseError::new(GitHubReleaseErrorKind::RateLimited);
        error.retry = Some(wait);
        return Err(error.user_message());
    }

    let response = client
        .get(endpoint)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
        .send()
        .await
        .map_err(|error| GitHubReleaseError::network(error.to_string()).user_message())?;
    if !response.status().is_success() {
        let error = non_success_error(response).await;
        if let (GitHubReleaseErrorKind::RateLimited, Some(wait)) =
            (error.kind, error.retry.as_ref())
        {
            record_cooldown(cooldown, wait)?;
        }
        return Err(error.user_message());
    }
    let request_id = response
        .headers()
        .get("x-github-request-id")
        .and_then(safe_header_text);
    let body = read_bounded_body(response, MAX_RELEASE_JSON_BYTES)
        .await
        .map_err(|error| {
            GitHubReleaseError::network(format!("读取 Mihomo Release 元数据失败：{error}"))
                .user_message()
        })?;
    if body.truncated {
        let mut error = GitHubReleaseError::invalid("Mihomo Release 元数据过大，拒绝解析");
        error.evidence.request_id = request_id;
        return Err(error.user_message());
    }
    let release = parse_release(&body.bytes).map_err(|detail| {
        let mut error = GitHubReleaseError::invalid(detail);
        error.evidence.request_id = request_id;
        error.user_message()
    })?;
    if let Some(current) = current {
        let current = crate::update::parse_version(current)?;
        if release.version <= current {
            return Ok(None);
        }
    }
    Ok(Some(release))
}

pub(crate) async fn latest_release(current: Option<&str>) -> Result<Option<CoreRelease>, String> {
    let client = github_release_check_client()?;
    latest_release_at(
        &client,
        MIHOMO_RELEASE_ENDPOINT,
        current,
        release_check_cooldown(),
    )
    .await
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
        .arg(config::mihomo_path_for_external_process(data_dir))
        .args(["-f"])
        .arg(config::mihomo_path_for_external_process(config_path))
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
    use std::{io::Write, time::Duration};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
    };
    use zip::ZipWriter;

    const TEST_DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn release_json(digest: &str) -> Vec<u8> {
        release_json_for("v1.19.28", digest)
    }

    fn release_json_for(version: &str, digest: &str) -> Vec<u8> {
        let numeric_version = version.trim_start_matches('v');
        serde_json::json!({
            "tag_name": version,
            "prerelease": false,
            "assets": [{
                "name": format!("mihomo-windows-amd64-compatible-v{numeric_version}.zip"),
                "browser_download_url": format!("https://github.com/MetaCubeX/mihomo/releases/download/v{numeric_version}/mihomo-windows-amd64-compatible-v{numeric_version}.zip"),
                "digest": format!("sha256:{digest}")
            }]
        })
        .to_string()
        .into_bytes()
    }

    async fn read_request(stream: &mut TcpStream) -> Vec<u8> {
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let length = stream.read(&mut buffer).await.expect("read mock request");
            if length == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..length]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        request
    }

    async fn mock_release_response(
        status: u16,
        headers: &[(&str, &str)],
        body: Vec<u8>,
        delay: Duration,
    ) -> (String, tokio::task::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock GitHub endpoint");
        let address = listener.local_addr().expect("mock endpoint address");
        let endpoint = format!("http://{address}");
        let header_text = headers
            .iter()
            .map(|(name, value)| format!("{name}: {value}\r\n"))
            .collect::<String>();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept mock request");
            let request = read_request(&mut stream).await;
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            let reason = match status {
                200 => "OK",
                403 => "Forbidden",
                429 => "Too Many Requests",
                500 => "Internal Server Error",
                503 => "Service Unavailable",
                _ => "Mock Response",
            };
            let response = format!(
                "HTTP/1.1 {status} {reason}\r\n{header_text}Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.write_all(&body).await;
            request
        });
        (endpoint, server)
    }

    fn reset_epoch_after(seconds: u64) -> String {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_secs()
            .saturating_add(seconds)
            .to_string()
    }

    fn new_test_cooldown() -> Mutex<ReleaseCheckCooldown> {
        Mutex::new(ReleaseCheckCooldown::default())
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

    #[tokio::test]
    async fn checks_valid_release_json_with_public_github_headers() {
        let (endpoint, server) =
            mock_release_response(200, &[], release_json(TEST_DIGEST), Duration::ZERO).await;
        let client = github_release_check_client().expect("GitHub client");
        let cooldown = new_test_cooldown();
        let release = latest_release_at(&client, &endpoint, None, &cooldown)
            .await
            .expect("valid release response")
            .expect("new release");
        assert_eq!(release.version, Version::parse("1.19.28").unwrap());
        let request =
            String::from_utf8(server.await.expect("mock response task")).expect("UTF-8 request");
        let request = request.to_ascii_lowercase();
        assert!(request.contains("user-agent: mioproxy-core-updater/0.9"));
        assert!(request.contains("accept: application/vnd.github+json"));
        assert!(request.contains("x-github-api-version: 2022-11-28"));
    }

    #[tokio::test]
    async fn treats_equal_installed_and_latest_versions_as_current() {
        let (endpoint, server) = mock_release_response(
            200,
            &[],
            release_json_for("v1.19.30", TEST_DIGEST),
            Duration::ZERO,
        )
        .await;
        let client = github_release_check_client().expect("GitHub client");
        let cooldown = new_test_cooldown();
        let release = latest_release_at(&client, &endpoint, Some("v1.19.30"), &cooldown)
            .await
            .expect("current release response");
        assert!(release.is_none());
        server.await.expect("mock response task");
    }

    #[tokio::test]
    async fn classifies_zero_remaining_forbidden_as_rate_limited() {
        let reset = reset_epoch_after(120);
        let headers = [
            ("x-ratelimit-limit", "60"),
            ("x-ratelimit-remaining", "0"),
            ("x-ratelimit-reset", reset.as_str()),
            ("x-github-request-id", "req-zero-remaining"),
        ];
        let (endpoint, server) = mock_release_response(
            403,
            &headers,
            br#"{"message":"API rate limit exceeded"}"#.to_vec(),
            Duration::ZERO,
        )
        .await;
        let client = github_release_check_client().expect("GitHub client");
        let cooldown = new_test_cooldown();
        let message = latest_release_at(&client, &endpoint, None, &cooldown)
            .await
            .expect_err("403 with zero remaining must fail");
        assert!(message.contains("GitHub API 请求频率受限，请稍后再试"));
        assert!(message.contains("预计本地时间"));
        assert!(message.contains("GitHub 请求 ID：req-zero-remaining"));
        server.await.expect("mock response task");
    }

    #[tokio::test]
    async fn classifies_forbidden_with_retry_after_as_rate_limited() {
        let headers = [
            ("retry-after", "120"),
            ("x-github-request-id", "req-secondary-limit"),
        ];
        let (endpoint, server) = mock_release_response(
            403,
            &headers,
            br#"{"message":"secondary rate limit"}"#.to_vec(),
            Duration::ZERO,
        )
        .await;
        let client = github_release_check_client().expect("GitHub client");
        let cooldown = new_test_cooldown();
        let message = latest_release_at(&client, &endpoint, None, &cooldown)
            .await
            .expect_err("403 with Retry-After must fail");
        assert!(message.contains("GitHub API 请求频率受限，请稍后再试"));
        assert!(message.contains("约 2 分钟后可重试"));
        assert!(message.contains("GitHub 请求 ID：req-secondary-limit"));
        server.await.expect("mock response task");
    }

    #[tokio::test]
    async fn keeps_generic_forbidden_distinct_from_rate_limiting() {
        let headers = [("x-github-request-id", "req-forbidden")];
        let (endpoint, server) =
            mock_release_response(403, &headers, b"permission denied".to_vec(), Duration::ZERO)
                .await;
        let client = github_release_check_client().expect("GitHub client");
        let cooldown = new_test_cooldown();
        let message = latest_release_at(&client, &endpoint, None, &cooldown)
            .await
            .expect_err("generic 403 must fail");
        assert!(message.contains("GitHub 拒绝了 Mihomo Release 检查请求（HTTP 403）"));
        assert!(!message.contains("请求频率受限"));
        assert!(message.contains("GitHub 请求 ID：req-forbidden"));
        assert!(message.contains("响应摘要：permission denied"));
        server.await.expect("mock response task");
    }

    #[tokio::test]
    async fn classifies_too_many_requests_as_rate_limited() {
        let headers = [("retry-after", "120")];
        let (endpoint, server) =
            mock_release_response(429, &headers, b"too many requests".to_vec(), Duration::ZERO)
                .await;
        let client = github_release_check_client().expect("GitHub client");
        let cooldown = new_test_cooldown();
        let message = latest_release_at(&client, &endpoint, None, &cooldown)
            .await
            .expect_err("429 must fail");
        assert!(message.contains("GitHub API 请求频率受限，请稍后再试"));
        assert!(message.contains("约 2 分钟后可重试"));
        server.await.expect("mock response task");
    }

    #[tokio::test]
    async fn classifies_github_server_errors_without_reporting_no_update() {
        for status in [500, 503] {
            let (endpoint, server) = mock_release_response(
                status,
                &[],
                b"temporary upstream failure".to_vec(),
                Duration::ZERO,
            )
            .await;
            let client = github_release_check_client().expect("GitHub client");
            let cooldown = new_test_cooldown();
            let message = latest_release_at(&client, &endpoint, None, &cooldown)
                .await
                .expect_err("server error must fail");
            assert!(message.contains("GitHub Mihomo Release 服务暂时不可用"));
            assert!(message.contains(&format!("HTTP {status}")));
            assert!(!message.contains("当前已是最新"));
            server.await.expect("mock response task");
        }
    }

    #[tokio::test]
    async fn classifies_malformed_success_body_as_invalid_response() {
        let (endpoint, server) = mock_release_response(
            200,
            &[("x-github-request-id", "req-malformed")],
            b"{not valid release json".to_vec(),
            Duration::ZERO,
        )
        .await;
        let client = github_release_check_client().expect("GitHub client");
        let cooldown = new_test_cooldown();
        let message = latest_release_at(&client, &endpoint, None, &cooldown)
            .await
            .expect_err("malformed release JSON must fail");
        assert!(message.contains("GitHub Mihomo Release 响应无效"));
        assert!(message.contains("GitHub 请求 ID：req-malformed"));
        server.await.expect("mock response task");
    }

    #[tokio::test]
    async fn classifies_timeout_and_connection_failures_as_network_unavailable() {
        let (endpoint, server) = mock_release_response(
            200,
            &[],
            release_json(TEST_DIGEST),
            Duration::from_millis(200),
        )
        .await;
        let client = Client::builder()
            .timeout(Duration::from_millis(50))
            .build()
            .expect("short-timeout client");
        let cooldown = new_test_cooldown();
        let timeout_message = latest_release_at(&client, &endpoint, None, &cooldown)
            .await
            .expect_err("delayed response must time out");
        assert!(timeout_message.contains("无法连接 GitHub Mihomo Release 服务"));
        server.await.expect("mock response task");

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind unused endpoint");
        let unused_endpoint = format!("http://{}", listener.local_addr().expect("endpoint"));
        drop(listener);
        let cooldown = new_test_cooldown();
        let connection_message = latest_release_at(&client, &unused_endpoint, None, &cooldown)
            .await
            .expect_err("closed endpoint must fail");
        assert!(connection_message.contains("无法连接 GitHub Mihomo Release 服务"));
    }

    #[tokio::test]
    async fn bounds_non_success_response_body_diagnostics() {
        let body = format!("diagnostic-{}", "x".repeat(4096)).into_bytes();
        let (endpoint, server) = mock_release_response(403, &[], body, Duration::ZERO).await;
        let client = github_release_check_client().expect("GitHub client");
        let cooldown = new_test_cooldown();
        let message = latest_release_at(&client, &endpoint, None, &cooldown)
            .await
            .expect_err("403 must fail");
        assert!(message.contains("响应摘要：diagnostic-"));
        assert!(message.contains('…'));
        assert!(!message.contains(&"x".repeat(1024)));
        server.await.expect("mock response task");
    }

    #[tokio::test]
    async fn cooldown_prevents_repeated_immediate_rate_limit_requests() {
        let headers = [("retry-after", "60")];
        let (endpoint, server) =
            mock_release_response(429, &headers, b"too many requests".to_vec(), Duration::ZERO)
                .await;
        let client = github_release_check_client().expect("GitHub client");
        let cooldown = new_test_cooldown();
        let first_message = latest_release_at(&client, &endpoint, None, &cooldown)
            .await
            .expect_err("first 429 must fail");
        assert!(first_message.contains("请求频率受限"));
        server.await.expect("mock response task");

        let second_message = latest_release_at(&client, &endpoint, None, &cooldown)
            .await
            .expect_err("cooldown must reject immediate retry");
        assert!(second_message.contains("GitHub API 请求频率受限，请稍后再试"));
        assert!(second_message.contains("约 1 分钟后可重试"));
        assert!(!second_message.contains("无法连接 GitHub Mihomo Release 服务"));
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
