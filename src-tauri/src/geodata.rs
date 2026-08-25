use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use reqwest::Client;
use serde_yaml::Value;
use sha2::{Digest, Sha256};

use crate::config::{read_binary_file_at, remove_file, write_atomic};

const GEOSITE_FILE: &str = "GeoSite.dat";
const GEOIP_FILE: &str = "GeoIP.dat";
const DEFAULT_GEOSITE_URL: &str =
    "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat";
const DEFAULT_GEOIP_URL: &str =
    "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.dat";
const BUNDLED_GEOSITE_SHA256: &str =
    "8c9e9ec13807174ffb3582d95655e00559af3fb30253b5e30c0385e46366d9dc";
const BUNDLED_GEOIP_SHA256: &str =
    "8ebcb11333f7deed4bf2740f2ce3249aa8997ef03d437150c7ae373c011cd72a";
const MAX_DOWNLOAD_BYTES: usize = 64 * 1024 * 1024;
const MIN_VALID_BYTES: usize = 1024;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct RequiredGeodata {
    geosite: bool,
    geoip: bool,
}

impl RequiredGeodata {
    fn any(self) -> bool {
        self.geosite || self.geoip
    }

    fn files(self) -> impl Iterator<Item = (&'static str, bool)> {
        [(GEOSITE_FILE, self.geosite), (GEOIP_FILE, self.geoip)]
            .into_iter()
            .filter(|(_, required)| *required)
    }
}

#[derive(Debug)]
pub(crate) struct GeodataReplacement {
    previous: Vec<(PathBuf, Option<Vec<u8>>)>,
}

impl GeodataReplacement {
    pub(crate) fn restore(self) -> Result<(), String> {
        let mut errors = Vec::new();
        for (path, bytes) in self.previous {
            let result = match bytes {
                Some(bytes) => write_atomic(&path, &bytes),
                None => remove_file(&path, "恢复缺失的 geodata 文件"),
            };
            if let Err(error) = result {
                errors.push(format!("{}: {error}", path.display()));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("；"))
        }
    }
}

fn required_from_value(value: &Value) -> RequiredGeodata {
    let mut required = RequiredGeodata::default();
    let Some(rules) = value.get("rules").and_then(Value::as_sequence) else {
        return required;
    };
    for rule in rules.iter().filter_map(Value::as_str) {
        let kind = rule.split(',').next().unwrap_or_default().trim();
        if kind.eq_ignore_ascii_case("GEOSITE") {
            required.geosite = true;
        } else if kind.eq_ignore_ascii_case("GEOIP") {
            required.geoip = true;
        }
    }
    required
}

fn required_from_candidate(candidate: &str) -> Result<RequiredGeodata, String> {
    let value = serde_yaml::from_str::<Value>(candidate)
        .map_err(|error| format!("读取候选 Runtime 的 geodata 规则失败：{error}"))?;
    Ok(required_from_value(&value))
}

fn configured_url(value: &Value, key: &str, default: &str) -> Result<(String, bool), String> {
    let Some(candidate) = value
        .get("geox-url")
        .and_then(Value::as_mapping)
        .and_then(|mapping| mapping.get(Value::String(key.to_string())))
        .and_then(Value::as_str)
    else {
        return Ok((default.to_string(), false));
    };
    let url = candidate.trim();
    let parsed = reqwest::Url::parse(url).map_err(|_| format!("geodata {key} URL 无效"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(format!("geodata {key} URL 必须是 http 或 https 地址"));
    }
    Ok((url.to_string(), true))
}

fn digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn is_nonempty_geodata(bytes: &[u8]) -> bool {
    bytes.len() >= MIN_VALID_BYTES
        && !bytes.starts_with(b"<!DOCTYPE")
        && !bytes.starts_with(b"<html")
}

fn expected_bundled_digest(file: &str) -> &'static str {
    match file {
        GEOSITE_FILE => BUNDLED_GEOSITE_SHA256,
        GEOIP_FILE => BUNDLED_GEOIP_SHA256,
        _ => "",
    }
}

fn bundled_bytes(file: &str, bundled_dirs: &[PathBuf]) -> Result<Option<Vec<u8>>, String> {
    for directory in bundled_dirs {
        let path = directory.join(file);
        let Some(bytes) = read_binary_file_at(&path, "读取内置 geodata")? else {
            continue;
        };
        if is_nonempty_geodata(&bytes) && digest(&bytes) == expected_bundled_digest(file) {
            return Ok(Some(bytes));
        }
    }
    Ok(None)
}

fn validate_downloaded_geodata(
    file: &str,
    bytes: &[u8],
    expected_sha256: Option<&str>,
) -> Result<(), String> {
    if bytes.len() > MAX_DOWNLOAD_BYTES || !is_nonempty_geodata(bytes) {
        return Err(format!("下载的 {file} 不像有效 geodata 文件"));
    }
    if let Some(expected) = expected_sha256 {
        let actual = digest(bytes);
        if actual != expected {
            return Err(format!(
                "下载的 {file} SHA-256 {actual} 与 MioProxy 固定摘要 {expected} 不匹配"
            ));
        }
    }
    Ok(())
}

async fn download_geodata(
    file: &str,
    url: &str,
    expected_sha256: Option<&str>,
) -> Result<Vec<u8>, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|error| format!("创建 geodata 下载器失败：{error}"))?;
    let response = client
        .get(url)
        .header("User-Agent", "MioProxy/0.9")
        .send()
        .await
        .map_err(|error| format!("下载 {file} 失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("下载 {file} 响应失败：{error}"))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取下载的 {file} 失败：{error}"))?;
    validate_downloaded_geodata(file, &bytes, expected_sha256)?;
    Ok(bytes.to_vec())
}

fn active_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    read_binary_file_at(path, "读取现有 geodata")
}

fn candidate_value(candidate: &str) -> Result<Value, String> {
    serde_yaml::from_str(candidate).map_err(|error| format!("读取候选 Runtime 失败：{error}"))
}

async fn replacement_for(
    data_dir: &Path,
    candidate: &str,
    bundled_dirs: &[PathBuf],
) -> Result<GeodataReplacement, String> {
    let value = candidate_value(candidate)?;
    let required = required_from_value(&value);
    if !required.any() {
        return Ok(GeodataReplacement {
            previous: Vec::new(),
        });
    }
    let stage_dir = data_dir
        .join("updates")
        .join("geodata")
        .join(format!("stage-{}", uuid_suffix()));
    fs::create_dir_all(&stage_dir)
        .map_err(|error| format!("创建 geodata staging 目录失败：{error}"))?;
    let mut replacement = GeodataReplacement {
        previous: Vec::new(),
    };
    let result = async {
        for (file, _) in required.files() {
            let active_path = data_dir.join(file);
            let previous = active_bytes(&active_path)?;
            let bytes = if let Some(bytes) = bundled_bytes(file, bundled_dirs)? {
                bytes
            } else {
                let key = if file == GEOSITE_FILE {
                    "geosite"
                } else {
                    "geoip"
                };
                let default = if file == GEOSITE_FILE {
                    DEFAULT_GEOSITE_URL
                } else {
                    DEFAULT_GEOIP_URL
                };
                let (url, explicitly_configured) = configured_url(&value, key, default)?;
                let expected_sha256 = if explicitly_configured {
                    None
                } else {
                    Some(expected_bundled_digest(file))
                };
                download_geodata(file, &url, expected_sha256).await?
            };
            if !is_nonempty_geodata(&bytes) {
                return Err(format!("{file} staging 内容无效"));
            }
            let staged_path = stage_dir.join(file);
            write_atomic(&staged_path, &bytes)?;
            let staged =
                active_bytes(&staged_path)?.ok_or_else(|| format!("{file} staging 文件丢失"))?;
            if !is_nonempty_geodata(&staged) {
                return Err(format!("{file} staging 校验失败"));
            }
            replacement.previous.push((active_path.clone(), previous));
            write_atomic(&active_path, &staged)?;
        }
        Ok::<(), String>(())
    }
    .await;
    let _ = fs::remove_dir_all(&stage_dir);
    if let Err(error) = result {
        let restore_error = replacement.restore().err();
        return Err(match restore_error {
            Some(restore_error) => {
                format!("替换 geodata 失败：{error}；恢复旧 geodata 失败：{restore_error}")
            }
            None => format!("替换 geodata 失败：{error}"),
        });
    }
    Ok(replacement)
}

fn uuid_suffix() -> String {
    let mut bytes = [0u8; 12];
    if getrandom::fill(&mut bytes).is_err() {
        return "fallback".to_string();
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) async fn ensure_for_candidate(
    data_dir: &Path,
    candidate_path: &Path,
    bundled_dirs: &[PathBuf],
) -> Result<(), String> {
    let candidate = crate::config::read_text_file_at(candidate_path, "读取候选 Runtime")?
        .ok_or_else(|| "候选 Runtime 不存在，无法准备 geodata".to_string())?;
    let required = required_from_candidate(&candidate)?;
    if !required.any() {
        return Ok(());
    }
    let missing = required.files().any(|(file, _)| {
        let path = data_dir.join(file);
        active_bytes(&path)
            .ok()
            .flatten()
            .is_none_or(|bytes| !is_nonempty_geodata(&bytes))
    });
    if missing {
        let _ = replacement_for(data_dir, &candidate, bundled_dirs).await?;
    }
    Ok(())
}

pub(crate) async fn replace_after_validation_failure(
    data_dir: &Path,
    candidate_path: &Path,
    bundled_dirs: &[PathBuf],
) -> Result<GeodataReplacement, String> {
    let candidate = crate::config::read_text_file_at(candidate_path, "读取候选 Runtime")?
        .ok_or_else(|| "候选 Runtime 不存在，无法恢复 geodata".to_string())?;
    replacement_for(data_dir, &candidate, bundled_dirs).await
}

pub(crate) fn is_geodata_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("geosite.dat")
        || lower.contains("geoip.dat")
        || lower.contains("geodata")
        || lower.contains("geosite")
        || lower.contains("geoip")
}

pub(crate) fn validation_category(error: &str) -> &'static str {
    let lower = error.to_ascii_lowercase();
    if lower.contains(r"\\?\")
        || lower.contains(r"\?\")
        || lower.contains("filename, directory name")
        || lower.contains("syntax is incorrect")
    {
        "Windows 路径"
    } else if lower.contains("invalid geosite") || lower.contains("invalid geoip") {
        "损坏的 geodata"
    } else if lower.contains("not found")
        || lower.contains("no such file")
        || lower.contains("cannot find")
        || lower.contains("missing")
        || lower.contains("download")
        || lower.contains("下载")
        || lower.contains("staging")
        || lower.contains("geodata")
    {
        "缺少 geodata"
    } else {
        "订阅语法或 Mihomo 配置"
    }
}

pub(crate) fn bundled_search_dirs(core_path: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(parent) = core_path.parent() {
        dirs.push(parent.to_path_buf());
        dirs.push(parent.join("resources").join("binaries"));
    }
    dirs
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use std::{fs, path::PathBuf, process::Command};

    #[cfg(windows)]
    use crate::config::mihomo_path_for_external_process;

    use super::{
        configured_url, is_geodata_error, required_from_candidate, uuid_suffix,
        validate_downloaded_geodata, validation_category, RequiredGeodata, BUNDLED_GEOSITE_SHA256,
        DEFAULT_GEOSITE_URL, GEOIP_FILE, GEOSITE_FILE,
    };

    #[test]
    fn detects_geosite_and_geoip_rules_without_rewriting_them() {
        let required =
            required_from_candidate("rules:\n  - GEOSITE,private,DIRECT\n  - GEOIP,CN,DIRECT\n")
                .unwrap();
        assert_eq!(
            required,
            RequiredGeodata {
                geosite: true,
                geoip: true
            }
        );
    }

    #[test]
    fn classifies_the_installed_windows_geosite_failure_as_a_path_error() {
        let error = r"Invalid GeoSite.dat: remove \\?\C:\Users\fukan\AppData\Roaming\dev.MioProxy/GeoSite.dat: The filename, directory name, or volume label syntax is incorrect.";
        assert!(is_geodata_error(error));
        assert_eq!(validation_category(error), "Windows 路径");
    }

    #[test]
    fn default_geodata_recovery_is_pinned_but_custom_geox_url_is_not() {
        let default_value = serde_yaml::from_str::<serde_yaml::Value>("{}").unwrap();
        let (default_url, explicitly_configured) =
            configured_url(&default_value, "geosite", DEFAULT_GEOSITE_URL).unwrap();
        assert_eq!(default_url, DEFAULT_GEOSITE_URL);
        assert!(!explicitly_configured);

        let custom_value = serde_yaml::from_str::<serde_yaml::Value>(
            "geox-url:\n  geosite: https://example.test/geosite.dat\n",
        )
        .unwrap();
        let (custom_url, explicitly_configured) =
            configured_url(&custom_value, "geosite", DEFAULT_GEOSITE_URL).unwrap();
        assert_eq!(custom_url, "https://example.test/geosite.dat");
        assert!(explicitly_configured);

        let mismatched = vec![b'G'; 1024];
        assert!(validate_downloaded_geodata(
            GEOSITE_FILE,
            &mismatched,
            Some(BUNDLED_GEOSITE_SHA256)
        )
        .is_err());
        assert!(validate_downloaded_geodata(GEOSITE_FILE, &mismatched, None).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn appdata_geosite_and_geoip_rules_validate_without_extended_path() {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let mihomo = manifest_dir
            .join("binaries")
            .join("mihomo-x86_64-pc-windows-msvc.exe");
        let bundled_geosite = manifest_dir.join("binaries").join("GeoSite.dat");
        let bundled_geoip = manifest_dir.join("binaries").join("GeoIP.dat");
        if !mihomo.exists() || !bundled_geosite.exists() || !bundled_geoip.exists() {
            eprintln!("skipping Mihomo integration test: setup-mihomo assets are absent");
            return;
        }

        let root = std::env::temp_dir().join(format!("mioproxy-geodata-test-{}", uuid_suffix()));
        fs::create_dir_all(&root).unwrap();
        fs::copy(&bundled_geosite, root.join(GEOSITE_FILE)).unwrap();
        fs::copy(&bundled_geoip, root.join(GEOIP_FILE)).unwrap();
        let config = root.join("config.yaml");
        fs::write(
            &config,
            "mixed-port: 7890\nmode: rule\ngeodata-mode: true\nlog-level: silent\nipv6: false\nrules:\n  - GEOSITE,private,DIRECT\n  - GEOIP,CN,DIRECT\n",
        )
        .unwrap();

        let extended_root = PathBuf::from(format!(r"\\?\{}", root.display()));
        let normalized_root = mihomo_path_for_external_process(&extended_root);
        let normalized_text = normalized_root.to_string_lossy();
        assert!(!normalized_text.starts_with(r"\\?\"));
        assert!(!normalized_text.contains('/'));

        let output = Command::new(mihomo)
            .args(["-t", "-d"])
            .arg(&normalized_root)
            .args(["-f"])
            .arg(&config)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "Mihomo rejected AppData-style geodata runtime: status={:?}, code={:?}, root={}, config={}\nstdout:\n{}\nstderr:\n{}",
            output.status,
            output.status.code(),
            root.display(),
            config.display(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        fs::remove_dir_all(root).unwrap();
    }
}
