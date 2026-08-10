use std::{
    fs,
    io::{self, Read, Write},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, TcpListener},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use std::os::windows::{
    ffi::OsStrExt,
    fs::{MetadataExt, OpenOptionsExt},
};

#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};

#[cfg(windows)]
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
};

use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_yaml::{Mapping, Value};
use tauri::{AppHandle, Manager};

use crate::{mihomo, outbound, profiles};

const OVERRIDE_FILE: &str = "local-override.yaml";
const RUNTIME_OVERRIDE_FILE: &str = "runtime-override.yaml";
const ACTIVE_BASE_FILE: &str = "active-profile-base.yaml";
const CANDIDATE_FILE: &str = "config.candidate.yaml";
const RUNTIME_LISTENER_FILE: &str = "runtime-listener-state.json";
const ACTIVE_PROFILE_FILE: &str = "active-profile.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ListenerOwner {
    MioProxyManaged,
    External,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TcpListenerDiagnostic {
    pub address_family: String,
    pub local_address: String,
    pub local_port: u16,
    pub state: String,
    pub owning_pid: Option<u32>,
    pub owner: ListenerOwner,
}

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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub base_value: Value,
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

fn runtime_override_path_at(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join(RUNTIME_OVERRIDE_FILE)
}

fn active_base_path_at(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join(ACTIVE_BASE_FILE)
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        ensure_not_reparse(parent)?;
    }
    ensure_not_reparse(path)?;

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("无法生成临时文件名：{}", path.display()))?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("无法确定临时文件目录：{}", path.display()))?;
    let mut temp = None;
    for _ in 0..8 {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|e| format!("生成临时文件名失败：{e}"))?;
        let suffix = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let candidate = parent.join(format!(".{file_name}.{suffix}.tmp"));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut file) => {
                let result = file
                    .write_all(bytes)
                    .and_then(|_| file.flush())
                    .and_then(|_| file.sync_all());
                if let Err(error) = result {
                    drop(file);
                    let _ = fs::remove_file(&candidate);
                    return Err(error.to_string());
                }
                if let Err(error) = ensure_not_reparse(&candidate) {
                    drop(file);
                    let _ = fs::remove_file(&candidate);
                    return Err(error);
                }
                temp = Some(candidate);
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    let temp = temp.ok_or_else(|| "无法创建唯一临时文件".to_string())?;
    if let Err(error) = replace_file(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    Ok(())
}

#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

#[cfg(windows)]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

#[cfg(windows)]
fn ensure_not_reparse(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(format!("拒绝写入 Reparse Point 路径：{}", path.display()));
    }
    Ok(())
}

#[cfg(not(windows))]
fn ensure_not_reparse(_path: &Path) -> Result<(), String> {
    Ok(())
}

pub(crate) fn read_text_file_at(path: &Path, label: &str) -> Result<Option<String>, String> {
    #[cfg(not(windows))]
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err(format!("拒绝读取 Reparse Point 路径：{}", path.display()));
        }
    }

    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("{label}失败：{error}")),
    };
    #[cfg(windows)]
    {
        let metadata = file
            .metadata()
            .map_err(|e| format!("检查 {label} 路径失败：{e}"))?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!("拒绝读取 Reparse Point 路径：{}", path.display()));
        }
    }
    let mut content = String::new();
    file.read_to_string(&mut content)
        .map_err(|e| format!("{label}失败：{e}"))?;
    Ok(Some(content))
}

pub(crate) fn remove_file(path: &Path, label: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_not_reparse(parent)?;
    }
    ensure_not_reparse(path)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("{label}失败：{error}")),
    }
}

#[cfg(windows)]
fn replace_file(temp: &Path, path: &Path) -> Result<(), String> {
    let source = temp
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err(io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(temp: &Path, path: &Path) -> Result<(), String> {
    fs::rename(temp, path).map_err(|e| e.to_string())
}

fn empty_mapping() -> Value {
    Value::Mapping(Mapping::new())
}

fn read_override_value_at(data_dir: &Path) -> Result<(Value, String), String> {
    let path = override_path_at(data_dir);
    let Some(content) = read_text_file_at(&path, "读取本地 Override")? else {
        return Ok((empty_mapping(), String::new()));
    };
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

fn read_runtime_override_value_at(data_dir: &Path) -> Result<Value, String> {
    let path = runtime_override_path_at(data_dir);
    let Some(content) = read_text_file_at(&path, "读取 Runtime Override")? else {
        return Ok(empty_mapping());
    };
    if content.trim().is_empty() {
        return Ok(empty_mapping());
    }
    let value = serde_yaml::from_str::<Value>(&content)
        .map_err(|e| format!("Runtime Override YAML 无效：{e}"))?;
    let Some(map) = value.as_mapping() else {
        return Err("Runtime Override 根节点必须是 YAML 对象".to_string());
    };
    if map
        .keys()
        .any(|key| !matches!(key.as_str(), Some("tun") | Some("dns")))
    {
        return Err("Runtime Override 只能包含 MioProxy 管理的 tun 或 dns 字段".to_string());
    }
    Ok(value)
}

fn read_override_value(app: &AppHandle) -> Result<(Value, String), String> {
    read_override_value_at(&app_data_dir(app)?)
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

fn mapping_value_mut<'a>(map: &'a mut Mapping, key: &str) -> Option<&'a mut Value> {
    map.get_mut(value_key(key))
}

fn configured_port(map: &Mapping, key: &str) -> Option<u16> {
    mapping_value(map, key)
        .and_then(Value::as_i64)
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port != 0)
}

fn listener_owner(owning_pid: Option<u32>, managed_pid: Option<u32>) -> ListenerOwner {
    match owning_pid {
        Some(pid) if Some(pid) == managed_pid => ListenerOwner::MioProxyManaged,
        Some(_) => ListenerOwner::External,
        None => ListenerOwner::Unknown,
    }
}

#[cfg(windows)]
pub(crate) fn windows_tcp_listener_diagnostics(
    port: u16,
    managed_pid: Option<u32>,
) -> Result<Vec<TcpListenerDiagnostic>, String> {
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
    const AF_INET: u32 = 2;
    const AF_INET6: u32 = 23;

    unsafe fn table_size(family: u32) -> Result<u32, String> {
        let mut size = 0;
        let result = GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut size,
            0,
            family,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        );
        if result == ERROR_INSUFFICIENT_BUFFER {
            Ok(size)
        } else {
            Err(format!("读取 Windows TCP 监听表大小失败：{result}"))
        }
    }

    unsafe fn read_table(family: u32, size: u32) -> Result<Vec<u8>, String> {
        let mut buffer = vec![0u8; size as usize];
        let mut actual_size = size;
        let result = GetExtendedTcpTable(
            buffer.as_mut_ptr().cast(),
            &mut actual_size,
            0,
            family,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        );
        if result == 0 {
            Ok(buffer)
        } else {
            Err(format!("读取 Windows TCP 监听表失败：{result}"))
        }
    }

    unsafe fn rows<T: Copy>(buffer: &[u8]) -> Result<Vec<T>, String> {
        if buffer.len() < std::mem::size_of::<u32>() {
            return Err("Windows TCP 监听表无效".to_string());
        }
        let count = *(buffer.as_ptr().cast::<u32>()) as usize;
        let row_size = std::mem::size_of::<T>();
        let rows_size = count
            .checked_mul(row_size)
            .ok_or_else(|| "Windows TCP 监听表大小溢出".to_string())?;
        let offset = std::mem::size_of::<u32>();
        if buffer.len() < offset + rows_size {
            return Err("Windows TCP 监听表长度无效".to_string());
        }
        Ok((0..count)
            .map(|index| {
                std::ptr::read_unaligned(buffer.as_ptr().add(offset + index * row_size).cast::<T>())
            })
            .collect())
    }

    let mut listeners = Vec::new();
    let v4 = unsafe { read_table(AF_INET, table_size(AF_INET)?)? };
    for row in unsafe { rows::<MIB_TCPROW_OWNER_PID>(&v4)? } {
        let local_port = u16::from_be((row.dwLocalPort & 0xffff) as u16);
        if local_port != port {
            continue;
        }
        let owning_pid = (row.dwOwningPid != 0).then_some(row.dwOwningPid);
        listeners.push(TcpListenerDiagnostic {
            address_family: "ipv4".to_string(),
            local_address: IpAddr::V4(Ipv4Addr::from(row.dwLocalAddr.to_ne_bytes())).to_string(),
            local_port,
            state: "listen".to_string(),
            owning_pid,
            owner: listener_owner(owning_pid, managed_pid),
        });
    }
    let v6 = unsafe { read_table(AF_INET6, table_size(AF_INET6)?)? };
    for row in unsafe { rows::<MIB_TCP6ROW_OWNER_PID>(&v6)? } {
        let local_port = u16::from_be((row.dwLocalPort & 0xffff) as u16);
        if local_port != port {
            continue;
        }
        let owning_pid = (row.dwOwningPid != 0).then_some(row.dwOwningPid);
        let address = IpAddr::V6(Ipv6Addr::from(row.ucLocalAddr));
        let local_address = if row.dwLocalScopeId == 0 {
            address.to_string()
        } else {
            format!("{address}%{}", row.dwLocalScopeId)
        };
        listeners.push(TcpListenerDiagnostic {
            address_family: "ipv6".to_string(),
            local_address,
            local_port,
            state: "listen".to_string(),
            owning_pid,
            owner: listener_owner(owning_pid, managed_pid),
        });
    }
    Ok(listeners)
}

#[cfg(not(windows))]
pub(crate) fn windows_tcp_listener_diagnostics(
    _port: u16,
    _managed_pid: Option<u32>,
) -> Result<Vec<TcpListenerDiagnostic>, String> {
    Ok(Vec::new())
}

#[cfg(windows)]
fn windows_tcp_listener_uses_port(port: u16) -> Result<bool, String> {
    Ok(!windows_tcp_listener_diagnostics(port, None)?.is_empty())
}

fn port_is_available(port: u16) -> Result<bool, String> {
    #[cfg(windows)]
    if windows_tcp_listener_uses_port(port)? {
        return Ok(false);
    }
    fn can_bind(address: &str, port: u16) -> bool {
        TcpListener::bind((address, port)).is_ok()
    }
    Ok(can_bind("127.0.0.1", port)
        && can_bind("0.0.0.0", port)
        && can_bind("::1", port)
        && can_bind("::", port))
}

fn scan_available_port<F>(preferred: u16, mut available: F) -> Result<Option<u16>, String>
where
    F: FnMut(u16) -> Result<bool, String>,
{
    for offset in 0..=100 {
        let candidate = preferred.saturating_add(offset);
        if candidate != 0 && available(candidate)? {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

fn select_available_port(preferred: u16) -> Result<u16, String> {
    if let Some(port) = scan_available_port(preferred, port_is_available)? {
        return Ok(port);
    }
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|error| format!("无法为 MioProxy 分配可用 mixed-port：{error}"))
}

fn select_available_port_from(preferred: u16, minimum: Option<u16>) -> Result<u16, String> {
    select_available_port(minimum.map_or(preferred, |port| preferred.max(port)))
}

fn controller_port(controller: &str) -> Result<u16, String> {
    controller
        .rsplit_once(':')
        .and_then(|(_, port)| port.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .ok_or_else(|| "MioProxy Controller 地址无效".to_string())
}

/// Applies MioProxy-owned listener settings to a generated runtime config.
/// The source profile is never changed. This is called only before starting a
/// MioProxy-owned core, so an occupied listener is a real external conflict.
pub(crate) fn prepare_runtime_resources_at(
    config_path: &Path,
    controller: &str,
    secret: &str,
) -> Result<u16, String> {
    prepare_runtime_resources_from_at(config_path, controller, secret, None)
}

pub(crate) fn prepare_runtime_resources_from_at(
    config_path: &Path,
    controller: &str,
    secret: &str,
    minimum_mixed_port: Option<u16>,
) -> Result<u16, String> {
    let content = read_text_file_at(config_path, "读取 MioProxy 运行配置")?
        .ok_or_else(|| "MioProxy 运行配置不存在".to_string())?;
    let mut value = serde_yaml::from_str::<Value>(&content)
        .map_err(|error| format!("MioProxy 运行配置无效：{error}"))?;
    let map = value
        .as_mapping_mut()
        .ok_or_else(|| "MioProxy 运行配置根节点必须是 YAML 对象".to_string())?;

    let preferred = configured_port(map, "mixed-port").unwrap_or(7890);
    let mixed_port = select_available_port_from(preferred, minimum_mixed_port)?;
    let controller_port = controller_port(controller)?;
    if !port_is_available(controller_port)? {
        return Err(format!(
            "MioProxy Controller 端口 {controller_port} 已被占用；请先处理该资源冲突"
        ));
    }
    for key in ["port", "socks-port", "redir-port", "tproxy-port"] {
        if let Some(port) = configured_port(map, key) {
            if port != mixed_port && !port_is_available(port)? {
                return Err(format!("MioProxy {key} 端口 {port} 已被占用"));
            }
        }
    }

    map.insert(value_key("mixed-port"), Value::Number(mixed_port.into()));
    map.insert(
        value_key("external-controller"),
        Value::String(controller.to_string()),
    );
    map.insert(value_key("secret"), Value::String(secret.to_string()));
    let yaml = serde_yaml::to_string(&value).map_err(|error| error.to_string())?;
    if yaml != content {
        write_atomic(config_path, yaml.as_bytes())?;
    }
    Ok(mixed_port)
}

#[derive(Deserialize, Serialize)]
struct RuntimeListenerState {
    mixed_port: u16,
}

#[derive(Deserialize, Serialize)]
struct ActiveProfileState {
    profile_id: String,
}

pub(crate) fn active_profile_id_at(data_dir: &Path) -> Result<Option<String>, String> {
    let path = data_dir.join(ACTIVE_PROFILE_FILE);
    let Some(content) = read_text_file_at(&path, "读取活动 Profile")? else {
        return Ok(None);
    };
    let state = serde_json::from_str::<ActiveProfileState>(&content)
        .map_err(|error| format!("活动 Profile 状态损坏：{error}"))?;
    if state.profile_id.trim().is_empty() {
        return Err("活动 Profile 状态无效".to_string());
    }
    Ok(Some(state.profile_id))
}

pub(crate) fn set_active_profile_id_at(data_dir: &Path, profile_id: &str) -> Result<(), String> {
    let value = serde_json::to_vec(&ActiveProfileState {
        profile_id: profile_id.to_string(),
    })
    .map_err(|error| error.to_string())?;
    write_atomic(&data_dir.join(ACTIVE_PROFILE_FILE), &value)
}

pub(crate) fn clear_active_profile_if_matches_at(
    data_dir: &Path,
    profile_id: &str,
) -> Result<(), String> {
    if active_profile_id_at(data_dir)?.as_deref() == Some(profile_id) {
        remove_file(
            &data_dir.join(ACTIVE_PROFILE_FILE),
            "清理已删除 Profile 的活动来源指针",
        )?;
    }
    Ok(())
}

fn read_active_base_at(data_dir: &Path) -> Result<Option<Value>, String> {
    let path = active_base_path_at(data_dir);
    let Some(content) = read_text_file_at(&path, "读取活动 Profile 基线")? else {
        return Ok(None);
    };
    let value = serde_yaml::from_str::<Value>(&content)
        .map_err(|error| format!("活动 Profile 基线损坏：{error}"))?;
    if !value.is_mapping() {
        return Err("活动 Profile 基线根节点必须是 YAML 对象".to_string());
    }
    Ok(Some(value))
}

fn read_active_base_or_migrate_at(data_dir: &Path) -> Result<Option<Value>, String> {
    if let Some(value) = read_active_base_at(data_dir)? {
        return Ok(Some(value));
    }
    let Some(content) = read_text_file_at(&config_path_at(data_dir), "读取旧 Runtime 配置")?
    else {
        return Ok(None);
    };
    let value = serde_yaml::from_str::<Value>(&content)
        .map_err(|error| format!("旧 Runtime 配置损坏：{error}"))?;
    validate_config(&value)?;
    write_active_base_at(data_dir, &value)?;
    Ok(Some(value))
}

fn write_active_base_at(data_dir: &Path, value: &Value) -> Result<(), String> {
    let yaml = serde_yaml::to_string(value)
        .map_err(|error| format!("生成活动 Profile 基线失败：{error}"))?;
    write_atomic(&active_base_path_at(data_dir), yaml.as_bytes())
}

fn restore_optional_file(path: &Path, content: Option<&str>, label: &str) -> Result<(), String> {
    match content {
        Some(content) => write_atomic(path, content.as_bytes()),
        None => remove_file(path, label),
    }
}

pub(crate) fn commit_runtime_state_at(
    data_dir: &Path,
    profile_id: &str,
    base_value: &Value,
    runtime_yaml: &str,
) -> Result<(), String> {
    let stable_path = config_path_at(data_dir);
    let base_path = active_base_path_at(data_dir);
    let active_path = data_dir.join(ACTIVE_PROFILE_FILE);
    let previous_stable = read_text_file_at(&stable_path, "读取旧 Runtime 配置")?;
    let previous_base = read_text_file_at(&base_path, "读取旧活动 Profile 基线")?;
    let previous_active = read_text_file_at(&active_path, "读取旧活动 Profile 状态")?;

    let commit = write_active_base_at(data_dir, base_value)
        .and_then(|_| write_atomic(&stable_path, runtime_yaml.as_bytes()))
        .and_then(|_| set_active_profile_id_at(data_dir, profile_id));
    if let Err(error) = commit {
        let mut rollback_errors = Vec::new();
        if let Err(rollback) = restore_optional_file(
            &base_path,
            previous_base.as_deref(),
            "回滚活动 Profile 基线",
        ) {
            rollback_errors.push(rollback);
        }
        if let Err(rollback) = restore_optional_file(
            &stable_path,
            previous_stable.as_deref(),
            "回滚 Runtime 配置",
        ) {
            rollback_errors.push(rollback);
        }
        if let Err(rollback) = restore_optional_file(
            &active_path,
            previous_active.as_deref(),
            "回滚活动 Profile 状态",
        ) {
            rollback_errors.push(rollback);
        }
        return Err(if rollback_errors.is_empty() {
            error
        } else {
            format!("{error}；回滚持久状态失败：{}", rollback_errors.join("；"))
        });
    }
    Ok(())
}

pub(crate) fn restore_active_runtime_config_at(data_dir: &Path) -> Result<bool, String> {
    let Some(mut value) = read_active_base_or_migrate_at(data_dir)? else {
        return Ok(false);
    };
    apply_runtime_layers(data_dir, &mut value)?;
    let yaml = serde_yaml::to_string(&value)
        .map_err(|error| format!("生成活动 Runtime 配置失败：{error}"))?;
    write_atomic(&config_path_at(data_dir), yaml.as_bytes())?;
    Ok(true)
}

pub(crate) fn active_runtime_value_at(data_dir: &Path) -> Result<Option<Value>, String> {
    let Some(mut value) = read_active_base_or_migrate_at(data_dir)? else {
        return Ok(None);
    };
    apply_runtime_layers(data_dir, &mut value)?;
    Ok(Some(value))
}

pub(crate) fn restore_active_profile_config_at(data_dir: &Path) -> Result<bool, String> {
    restore_active_runtime_config_at(data_dir)
}

pub(crate) fn clear_actual_runtime_mixed_port_at(data_dir: &Path) -> Result<(), String> {
    let path = data_dir.join(RUNTIME_LISTENER_FILE);
    if path.exists() {
        remove_file(&path, "清理 MioProxy runtime listener state")?;
    }
    Ok(())
}

pub(crate) fn commit_actual_runtime_mixed_port_at(
    data_dir: &Path,
    mixed_port: u16,
) -> Result<(), String> {
    let value = serde_json::to_vec(&RuntimeListenerState { mixed_port })
        .map_err(|error| error.to_string())?;
    write_atomic(&data_dir.join(RUNTIME_LISTENER_FILE), &value)
}

pub(crate) fn actual_runtime_mixed_port_at(data_dir: &Path) -> Option<u16> {
    let path = data_dir.join(RUNTIME_LISTENER_FILE);
    let content = read_text_file_at(&path, "读取 MioProxy runtime listener state").ok()??;
    serde_json::from_str::<RuntimeListenerState>(&content)
        .ok()
        .map(|state| state.mixed_port)
}

pub(crate) fn runtime_mixed_port_at(data_dir: &Path) -> Option<u16> {
    let path = config_path_at(data_dir);
    let content = read_text_file_at(&path, "读取 MioProxy 运行配置").ok()??;
    let value = serde_yaml::from_str::<Value>(&content).ok()?;
    value
        .as_mapping()
        .and_then(|map| configured_port(map, "mixed-port"))
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
            "proxy-server-nameserver",
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

pub(crate) fn validate_profile_yaml(source: &str) -> Result<(), String> {
    let value =
        serde_yaml::from_str::<Value>(source).map_err(|e| format!("Profile YAML 无效：{e}"))?;
    validate_config(&value)
}

pub(crate) fn build_value_at(data_dir: &Path, profile_id: &str) -> Result<BuiltConfig, String> {
    let profiles_path = data_dir.join("profiles.json");
    let profiles_content = read_text_file_at(&profiles_path, "读取 Profile 数据")?
        .ok_or_else(|| "读取 Profile 数据失败：文件不存在".to_string())?;
    let profile = serde_json::from_str::<Vec<profiles::Profile>>(&profiles_content)
        .map_err(|e| format!("Profile 数据损坏：{e}"))?
        .into_iter()
        .find(|candidate| candidate.id == profile_id)
        .ok_or_else(|| "找不到这个 Profile".to_string())?;
    let source_path = profile
        .file_path
        .as_ref()
        .ok_or_else(|| "请先下载这个 Profile".to_string())?;
    let source_path = profile_source_path_at(data_dir, source_path)?;
    let source = read_text_file_at(&source_path, "读取 Profile YAML")?
        .ok_or_else(|| "读取 Profile YAML 失败：文件不存在".to_string())?;
    if source.trim().is_empty() {
        return Err("Profile YAML 为空".to_string());
    }
    let mut base =
        serde_yaml::from_str::<Value>(&source).map_err(|e| format!("Profile YAML 无效：{e}"))?;
    let (override_value, override_content) = read_override_value_at(data_dir)?;
    merge_values(&mut base, override_value);
    validate_config(&base)?;
    let base_value = base.clone();
    apply_runtime_layers(data_dir, &mut base)?;
    Ok(BuiltConfig {
        profile,
        base_value,
        value: base,
        override_active: !override_content.trim().is_empty(),
    })
}

fn apply_runtime_layers(data_dir: &Path, base: &mut Value) -> Result<(), String> {
    let runtime_override = read_runtime_override_value_at(data_dir)?;
    let tun_enabled = runtime_override
        .as_mapping()
        .and_then(|map| mapping_value(map, "tun"))
        .and_then(Value::as_mapping)
        .and_then(|tun| mapping_value(tun, "enable"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    merge_values(base, runtime_override);
    let map = base
        .as_mapping_mut()
        .ok_or_else(|| "Profile YAML 根节点必须是 YAML 对象".to_string())?;
    let existing_tun = map.remove(value_key("tun")).unwrap_or_else(empty_mapping);
    let mut tun = existing_tun;
    let tun_map = tun
        .as_mapping_mut()
        .ok_or_else(|| "最终配置的 tun 必须是 YAML 对象".to_string())?;
    tun_map.insert(value_key("enable"), Value::Bool(tun_enabled));
    map.insert(value_key("tun"), tun);
    map.insert(
        value_key("external-controller"),
        Value::String(mihomo::CONTROLLER.to_string()),
    );
    map.insert(
        value_key("secret"),
        Value::String(mihomo::secret().to_string()),
    );
    if let Some(port) = runtime_mixed_port_at(data_dir) {
        map.insert(value_key("mixed-port"), Value::Number(port.into()));
    }
    apply_auto_outbound_compatibility(map);
    validate_config(base)?;
    Ok(())
}

fn apply_auto_outbound_compatibility(map: &mut Mapping) -> outbound::OutboundCompatibility {
    let compatibility = outbound::resolve().unwrap_or_default();
    apply_auto_outbound_compatibility_with(map, &compatibility);
    compatibility
}

fn apply_auto_outbound_compatibility_with(
    map: &mut Mapping,
    compatibility: &outbound::OutboundCompatibility,
) {
    if !compatibility.foreign_tun_detected {
        return;
    }
    if mapping_value(map, "interface-name").is_none() {
        if let Some(interface) = compatibility.selected.as_ref() {
            map.insert(
                value_key("interface-name"),
                Value::String(interface.alias.clone()),
            );
        }
    }
    if mapping_value(map, "dns").is_none() {
        map.insert(value_key("dns"), Value::Mapping(Mapping::new()));
    }
    let Some(dns) = mapping_value_mut(map, "dns").and_then(Value::as_mapping_mut) else {
        return;
    };
    if mapping_value(dns, "proxy-server-nameserver").is_none() {
        let resolvers = ["default-nameserver", "nameserver"]
            .into_iter()
            .find_map(|key| {
                mapping_value(dns, key)
                    .and_then(Value::as_sequence)
                    .filter(|values| !values.is_empty())
                    .cloned()
            })
            .unwrap_or_else(|| vec![Value::String("system".to_string())]);
        dns.insert(
            value_key("proxy-server-nameserver"),
            Value::Sequence(resolvers),
        );
    }
}

fn profile_source_path_at(
    data_dir: &Path,
    source_path: &str,
) -> Result<std::path::PathBuf, String> {
    let profiles_dir = data_dir.join("profiles");
    ensure_not_reparse(&profiles_dir)?;
    let source_path = Path::new(source_path);
    if !source_path.is_absolute() || is_network_path(source_path) {
        return Err("Profile 文件必须位于应用数据目录的 profiles 文件夹内".to_string());
    }
    ensure_not_reparse(source_path)?;
    let profiles_root =
        fs::canonicalize(&profiles_dir).map_err(|e| format!("解析 Profile 目录失败：{e}"))?;
    let canonical_source =
        fs::canonicalize(source_path).map_err(|e| format!("解析 Profile 文件失败：{e}"))?;
    if !canonical_source.starts_with(&profiles_root) {
        return Err("Profile 文件必须位于应用数据目录的 profiles 文件夹内".to_string());
    }
    Ok(canonical_source)
}

#[cfg(windows)]
fn is_network_path(path: &Path) -> bool {
    let value = path.as_os_str().to_string_lossy().to_ascii_lowercase();
    value.starts_with(r"\\.\")
        || value.starts_with(r"\\?\unc\")
        || (value.starts_with(r"\\") && !value.starts_with(r"\\?\"))
}

#[cfg(not(windows))]
fn is_network_path(_path: &Path) -> bool {
    false
}

pub(crate) fn tun_enabled_in_value(value: &Value) -> bool {
    value
        .as_mapping()
        .and_then(|map| mapping_value(map, "tun"))
        .and_then(Value::as_mapping)
        .and_then(|tun| mapping_value(tun, "enable"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
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

async fn ensure_override_editable(
    app: &AppHandle,
) -> Result<tokio::sync::MutexGuard<'static, ()>, String> {
    crate::ensure_mutations_allowed(app)?;
    Ok(crate::tun::lock_transitions().await)
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
    let mut value = read_runtime_override_value_at(data_dir)?;
    let map = value
        .as_mapping_mut()
        .ok_or_else(|| "Runtime Override 根节点必须是 YAML 对象".to_string())?;
    if !enabled {
        map.remove(value_key("tun"));
        map.remove(value_key("dns"));
        if map.is_empty() {
            return remove_file(
                &runtime_override_path_at(data_dir),
                "清理 TUN Runtime Override",
            );
        }
        let content = serde_yaml::to_string(&value)
            .map_err(|e| format!("生成 Runtime Override YAML 失败：{e}"))?;
        return write_atomic(&runtime_override_path_at(data_dir), content.as_bytes());
    }
    let existing_tun = map.remove(value_key("tun")).unwrap_or_else(empty_mapping);
    let mut tun = existing_tun;
    let tun_map = tun
        .as_mapping_mut()
        .ok_or_else(|| "Runtime Override 的 tun 必须是 YAML 对象".to_string())?;
    tun_map.insert(value_key("enable"), Value::Bool(enabled));
    let existing_dns = map.remove(value_key("dns")).unwrap_or_else(empty_mapping);
    let mut dns = existing_dns;
    let dns_map = dns
        .as_mapping_mut()
        .ok_or_else(|| "Runtime Override 的 dns 必须是 YAML 对象".to_string())?;
    dns_map.insert(value_key("enable"), Value::Bool(true));
    map.insert(value_key("dns"), dns);
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
    map.insert(value_key("tun"), tun);
    let content = serde_yaml::to_string(&value)
        .map_err(|e| format!("生成 Runtime Override YAML 失败：{e}"))?;
    validate_config(&value)?;
    write_atomic(&runtime_override_path_at(data_dir), content.as_bytes())
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
pub async fn override_set(app: AppHandle, content: String) -> Result<OverrideSnapshot, String> {
    let _transition = ensure_override_editable(&app).await?;
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
pub async fn config_preview(app: AppHandle, profile_id: String) -> Result<ConfigPreview, String> {
    let _registry = crate::profiles::lock_registry().await;
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
    let data_dir = app_data_dir(&app)?;
    let built = build_value_at(&data_dir, &profile_id)?;
    let profile_name = built.profile.name.clone();
    let override_active = built.override_active;
    let expected_tun = tun_enabled_in_value(&built.value);
    let yaml = serde_yaml::to_string(&built.value).map_err(|e| format!("生成最终配置失败：{e}"))?;
    let stable = config_path(&app)?;
    let candidate = candidate_path(&app)?;
    let previous_stable = read_text_file_at(&stable, "读取当前 Runtime 配置")?
        .ok_or_else(|| "当前 Runtime 配置不存在，拒绝无回滚点应用 Profile".to_string())?;
    write_atomic(&candidate, yaml.as_bytes())?;
    if let Err(error) = mihomo::ensure_managed_core(&app).await {
        let _ = remove_file(&candidate, "清理候选配置");
        return Err(format!("Core 尚未 Ready，无法应用 Profile：{error}"));
    }
    if let Err(error) = mihomo::api_put(
        "/configs?force=true",
        json!({ "path": candidate.display().to_string() }),
    )
    .await
    {
        let _ = remove_file(&candidate, "清理候选配置");
        return Err(format!("Mihomo 配置校验失败，已保留当前配置：{error}"));
    }
    let finish = async {
        verify_controller_runtime(Some(expected_tun)).await?;
        commit_runtime_state_at(&data_dir, &profile_id, &built.base_value, &yaml)
    }
    .await;
    if let Err(error) = finish {
        let stable_restore = write_atomic(&stable, previous_stable.as_bytes());
        let controller_restore = if stable_restore.is_ok() {
            mihomo::api_put(
                "/configs?force=true",
                json!({ "path": stable.display().to_string() }),
            )
            .await
            .map(|_| ())
        } else {
            Err("旧 Runtime 配置文件恢复失败".to_string())
        };
        let _ = remove_file(&candidate, "清理候选配置");
        return Err(match (stable_restore, controller_restore) {
            (Ok(()), Ok(())) => format!("应用 Profile 事务失败，已回滚：{error}"),
            (stable_result, controller_result) => format!(
                "应用 Profile 事务失败：{error}；Runtime 回滚：{}；Controller 回滚：{}",
                stable_result.err().unwrap_or_else(|| "成功".to_string()),
                controller_result
                    .err()
                    .unwrap_or_else(|| "成功".to_string())
            ),
        });
    }
    let _ = remove_file(&candidate, "清理候选配置");
    Ok(ConfigApplyResult {
        profile_id,
        profile_name,
        path: stable.display().to_string(),
        controller_validated: true,
        override_active,
    })
}

pub(crate) async fn verify_controller_runtime(expected_tun: Option<bool>) -> Result<(), String> {
    let configs = mihomo::api_get("/configs")
        .await
        .map_err(|error| format!("Controller 配置回读失败：{error}"))?;
    let proxies = mihomo::api_get("/proxies")
        .await
        .map_err(|error| format!("Controller 代理组回读失败：{error}"))?;
    if !proxies.is_object() {
        return Err("Controller /proxies 返回格式无效".to_string());
    }
    if let Some(expected) = expected_tun {
        let actual = configs
            .get("tun")
            .and_then(|tun| tun.as_object())
            .and_then(|tun| tun.get("enable"))
            .and_then(|enabled| enabled.as_bool())
            .unwrap_or(false);
        if actual != expected {
            return Err(format!(
                "Controller TUN 回读不一致：期望 {expected}，实际 {actual}"
            ));
        }
    }
    Ok(())
}

pub async fn apply_profile(app: AppHandle, profile_id: String) -> Result<String, String> {
    crate::ensure_mutations_allowed(&app)?;
    let _transition = crate::tun::lock_transitions().await;
    crate::tun::ensure_profile_apply_allowed(&app)?;
    let _registry = crate::profiles::lock_registry().await;
    let result =
        if let Some(result) = crate::service::request_apply_profile(&app, &profile_id).await? {
            result
        } else {
            let result = apply_config(app.clone(), profile_id.clone()).await?;
            crate::tun::rebind_active_profile(&app, &profile_id)?;
            result
        };
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
    crate::ensure_mutations_allowed(&app)?;
    let _transition = crate::tun::lock_transitions().await;
    crate::tun::ensure_profile_apply_allowed(&app)?;
    let _registry = crate::profiles::lock_registry().await;
    if let Some(result) = crate::service::request_apply_profile(&app, &profile_id).await? {
        return Ok(result);
    }
    let result = apply_config(app.clone(), profile_id.clone()).await?;
    crate::tun::rebind_active_profile(&app, &profile_id)?;
    Ok(result)
}

#[tauri::command]
pub async fn dns_get(app: AppHandle, profile_id: String) -> Result<DnsSettings, String> {
    let _registry = crate::profiles::lock_registry().await;
    let (_, value, _) = build_value(&app, &profile_id)?;
    let dns = value.as_mapping().and_then(|map| mapping_value(map, "dns"));
    Ok(settings_from_value(dns.unwrap_or(&Value::Null)))
}

#[tauri::command]
pub async fn dns_set(app: AppHandle, settings: DnsSettings) -> Result<OverrideSnapshot, String> {
    let _transition = ensure_override_editable(&app).await?;
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
        net::TcpListener,
        sync::{Mutex, MutexGuard, OnceLock},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{
        active_profile_id_at, actual_runtime_mixed_port_at, apply_auto_outbound_compatibility_with,
        build_value_at, clear_actual_runtime_mixed_port_at, commit_actual_runtime_mixed_port_at,
        commit_runtime_state_at, listener_owner, merge_values, port_is_available,
        prepare_runtime_resources_at, restore_active_runtime_config_at, runtime_mixed_port_at,
        scan_available_port, select_available_port, set_active_profile_id_at, set_tun_enabled_at,
        validate_config, ListenerOwner,
    };
    #[cfg(windows)]
    use super::{windows_tcp_listener_diagnostics, windows_tcp_listener_uses_port};
    use crate::{
        mihomo,
        outbound::{Confidence, InterfaceKind, OutboundCompatibility, OutboundInterface},
    };
    use serde_yaml::{Mapping, Value};

    fn network_test_guard() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
    }

    fn foreign_compatibility(alias: &str) -> OutboundCompatibility {
        OutboundCompatibility {
            foreign_tun_detected: true,
            selected: Some(OutboundInterface {
                alias: alias.to_string(),
                if_index: 4,
                kind: InterfaceKind::Physical,
                confidence: Confidence::High,
                reason: "test".to_string(),
            }),
            reason: None,
        }
    }

    #[test]
    fn leaves_runtime_unbound_without_a_foreign_tun() {
        let mut map = Mapping::new();
        apply_auto_outbound_compatibility_with(&mut map, &OutboundCompatibility::default());
        assert!(map.get("interface-name").is_none());
        assert!(map.get("dns").is_none());
    }

    #[test]
    fn injects_owned_interface_and_system_node_dns_for_foreign_tun() {
        let mut map = Mapping::new();
        apply_auto_outbound_compatibility_with(&mut map, &foreign_compatibility("Ethernet"));
        assert_eq!(map["interface-name"].as_str(), Some("Ethernet"));
        assert_eq!(
            map["dns"]["proxy-server-nameserver"][0].as_str(),
            Some("system")
        );
    }

    #[test]
    fn derives_node_dns_from_user_resolvers() {
        let mut map = serde_yaml::from_str::<Value>(
            "dns:\n  default-nameserver: [192.0.2.53]\n  nameserver: [system]\n",
        )
        .unwrap()
        .as_mapping()
        .unwrap()
        .clone();
        apply_auto_outbound_compatibility_with(&mut map, &foreign_compatibility("Ethernet"));
        assert_eq!(
            map["dns"]["proxy-server-nameserver"][0].as_str(),
            Some("192.0.2.53")
        );
    }

    #[test]
    fn preserves_user_interface_and_node_dns_settings() {
        let mut map = serde_yaml::from_str::<Value>(
            "interface-name: UserAdapter\ndns:\n  proxy-server-nameserver: [https://user.example/dns-query]\n",
        )
        .unwrap()
        .as_mapping()
        .unwrap()
        .clone();
        apply_auto_outbound_compatibility_with(&mut map, &foreign_compatibility("Ethernet"));
        assert_eq!(map["interface-name"].as_str(), Some("UserAdapter"));
        assert_eq!(
            map["dns"]["proxy-server-nameserver"][0].as_str(),
            Some("https://user.example/dns-query")
        );
    }

    #[test]
    fn persists_the_active_profile_id_without_touching_profile_source() {
        let data_dir = std::env::temp_dir().join(format!(
            "mioproxy-active-profile-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&data_dir).unwrap();
        set_active_profile_id_at(&data_dir, "profile-1").unwrap();
        assert_eq!(
            active_profile_id_at(&data_dir).unwrap().as_deref(),
            Some("profile-1")
        );
        let _ = fs::remove_dir_all(data_dir);
    }

    #[test]
    fn merges_nested_override_without_mutating_unrelated_values() {
        let mut base = serde_yaml::from_str::<Value>(
            "dns:\n  enable: false\n  nameserver: [1.1.1.1]\nrules: ['MATCH,DIRECT']\n",
        )
        .unwrap();
        let override_value = serde_yaml::from_str::<Value>("dns:\n  enable: true\n").unwrap();
        merge_values(&mut base, override_value);
        assert_eq!(base["dns"]["enable"].as_bool(), Some(true));
        assert_eq!(base["dns"]["nameserver"][0].as_str(), Some("1.1.1.1"));
        assert_eq!(base["rules"][0].as_str(), Some("MATCH,DIRECT"));
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
    fn treats_ipv6_listener_as_a_port_conflict() {
        let _guard = network_test_guard();
        let listener = TcpListener::bind(("::", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        #[cfg(windows)]
        {
            let listeners = windows_tcp_listener_diagnostics(port, None).unwrap();
            assert!(listeners.iter().any(|entry| {
                entry.address_family == "ipv6"
                    && entry.local_port == port
                    && entry.state == "listen"
                    && entry.owning_pid == Some(std::process::id())
            }));
            assert!(windows_tcp_listener_uses_port(port).unwrap());
        }
        assert!(!port_is_available(port).unwrap());
    }

    #[test]
    fn treats_ipv4_listener_as_a_port_conflict() {
        let _guard = network_test_guard();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        #[cfg(windows)]
        {
            let listeners = windows_tcp_listener_diagnostics(port, None).unwrap();
            assert!(listeners.iter().any(|entry| {
                entry.address_family == "ipv4"
                    && entry.local_address == "127.0.0.1"
                    && entry.local_port == port
                    && entry.owning_pid == Some(std::process::id())
            }));
        }
        assert!(!port_is_available(port).unwrap());
    }

    #[test]
    fn detects_a_listener_owned_by_the_managed_pid() {
        let _guard = network_test_guard();
        let listener = TcpListener::bind(("::1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        #[cfg(windows)]
        assert!(
            windows_tcp_listener_diagnostics(port, Some(std::process::id()))
                .unwrap()
                .iter()
                .any(|entry| entry.owner == ListenerOwner::MioProxyManaged)
        );
    }

    #[test]
    fn unknown_listener_pid_is_occupied_and_never_managed() {
        assert_eq!(listener_owner(None, Some(42)), ListenerOwner::Unknown);
        assert_eq!(listener_owner(Some(43), Some(42)), ListenerOwner::External);
    }

    #[test]
    fn skips_three_consecutive_occupied_ports() {
        let selected = scan_available_port(20_000, |port| Ok(port >= 20_003)).unwrap();
        assert_eq!(selected, Some(20_003));
    }

    #[test]
    fn commits_actual_port_only_after_health() {
        let data_dir = std::env::temp_dir().join(format!(
            "mioproxy-runtime-listener-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&data_dir).unwrap();
        assert_eq!(actual_runtime_mixed_port_at(&data_dir), None);
        commit_actual_runtime_mixed_port_at(&data_dir, 7893).unwrap();
        assert_eq!(actual_runtime_mixed_port_at(&data_dir), Some(7893));
        clear_actual_runtime_mixed_port_at(&data_dir).unwrap();
        assert_eq!(actual_runtime_mixed_port_at(&data_dir), None);
        let _ = fs::remove_dir_all(data_dir);
    }

    #[test]
    fn selects_a_different_port_when_ipv6_owns_the_preferred_port() {
        let _guard = network_test_guard();
        let listener = TcpListener::bind(("::", 0)).unwrap();
        let preferred = listener.local_addr().unwrap().port();
        let selected = select_available_port(preferred).unwrap();
        assert_ne!(selected, preferred);
    }

    #[test]
    fn records_the_selected_runtime_mixed_port() {
        let _guard = network_test_guard();
        let data_dir = std::env::temp_dir().join(format!(
            "mioproxy-runtime-port-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&data_dir).unwrap();
        let occupied = TcpListener::bind(("::", 0)).unwrap();
        let preferred = occupied.local_addr().unwrap().port();
        let controller_probe = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let controller_port = controller_probe.local_addr().unwrap().port();
        drop(controller_probe);
        fs::write(
            data_dir.join("config.yaml"),
            format!("mixed-port: {preferred}\nproxies: []\nproxy-groups: []\nrules: []\n"),
        )
        .unwrap();

        let selected = prepare_runtime_resources_at(
            &data_dir.join("config.yaml"),
            &format!("127.0.0.1:{controller_port}"),
            "test-secret",
        )
        .unwrap();
        assert_ne!(selected, preferred);
        assert_eq!(runtime_mixed_port_at(&data_dir), Some(selected));
        let _ = fs::remove_dir_all(data_dir);
    }

    #[test]
    fn runtime_tun_layer_preserves_source_and_local_override() {
        let data_dir = std::env::temp_dir().join(format!(
            "mioproxy-config-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let profiles_dir = data_dir.join("profiles");
        fs::create_dir_all(&profiles_dir).unwrap();
        let source_path = profiles_dir.join("profile.yaml");
        let source = "mixed-port: 7890\ntun:\n  enable: true\nproxies: []\nproxy-groups: []\nrules: [MATCH,DIRECT]\n";
        fs::write(&source_path, source).unwrap();
        fs::write(
            data_dir.join("profiles.json"),
            serde_json::to_vec(&serde_json::json!([{
                "id": "profile-1",
                "name": "Layering",
                "url": "https://example.invalid/profile",
                "filePath": source_path,
            }]))
            .unwrap(),
        )
        .unwrap();
        let override_path = data_dir.join("local-override.yaml");
        let local_override = "dns:\n  enable: false\n  nameserver: [system]\n";
        fs::write(&override_path, local_override).unwrap();

        let off = build_value_at(&data_dir, "profile-1").unwrap();
        assert_eq!(off.value["tun"]["enable"].as_bool(), Some(false));
        set_tun_enabled_at(&data_dir, true).unwrap();
        let both = build_value_at(&data_dir, "profile-1").unwrap();
        assert_eq!(both.value["mixed-port"].as_i64(), Some(7890));
        assert_eq!(both.value["tun"]["enable"].as_bool(), Some(true));
        assert_eq!(both.value["tun"]["auto-route"].as_bool(), Some(true));
        set_tun_enabled_at(&data_dir, false).unwrap();
        let proxy_only = build_value_at(&data_dir, "profile-1").unwrap();
        assert_eq!(proxy_only.value["mixed-port"].as_i64(), Some(7890));
        assert_eq!(proxy_only.value["tun"]["enable"].as_bool(), Some(false));
        assert_eq!(fs::read_to_string(&override_path).unwrap(), local_override);
        assert_eq!(fs::read_to_string(&source_path).unwrap(), source);
        let _ = fs::remove_dir_all(data_dir);
    }

    #[test]
    fn downloaded_source_update_does_not_change_active_runtime() {
        let data_dir = std::env::temp_dir().join(format!(
            "mioproxy-active-generation-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let profiles_dir = data_dir.join("profiles");
        fs::create_dir_all(&profiles_dir).unwrap();
        let source_path = profiles_dir.join("profile.yaml");
        fs::write(
            &source_path,
            "mixed-port: 7890\nrules: [DOMAIN,old.example,DIRECT]\n",
        )
        .unwrap();
        fs::write(
            data_dir.join("profiles.json"),
            serde_json::to_vec(&serde_json::json!([{
                "id": "profile-1",
                "name": "Pinned",
                "url": "https://example.invalid/profile",
                "filePath": source_path,
            }]))
            .unwrap(),
        )
        .unwrap();
        let built = build_value_at(&data_dir, "profile-1").unwrap();
        let yaml = serde_yaml::to_string(&built.value).unwrap();
        commit_runtime_state_at(&data_dir, "profile-1", &built.base_value, &yaml).unwrap();

        fs::write(
            &source_path,
            "mixed-port: 7890\nrules: [DOMAIN,new.example,PROXY]\n",
        )
        .unwrap();
        restore_active_runtime_config_at(&data_dir).unwrap();
        let runtime = fs::read_to_string(data_dir.join("config.yaml")).unwrap();
        assert!(runtime.contains("old.example"));
        assert!(!runtime.contains("new.example"));
        let _ = fs::remove_dir_all(data_dir);
    }

    #[test]
    fn restores_stable_config_without_tun_after_core_exit() {
        let data_dir = std::env::temp_dir().join(format!(
            "mioproxy-config-recovery-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&data_dir).unwrap();
        fs::write(
            data_dir.join("config.yaml"),
            "mixed-port: 7890\ntun:\n  enable: true\nproxies: []\nproxy-groups: []\nrules: [MATCH,DIRECT]\n",
        )
        .unwrap();

        restore_active_runtime_config_at(&data_dir).unwrap();
        let restored = fs::read_to_string(data_dir.join("config.yaml")).unwrap();
        let value = serde_yaml::from_str::<Value>(&restored).unwrap();
        assert_eq!(value["tun"]["enable"].as_bool(), Some(false));
        assert_eq!(
            value["external-controller"].as_str(),
            Some(mihomo::CONTROLLER)
        );

        let _ = fs::remove_dir_all(data_dir);
    }
}
