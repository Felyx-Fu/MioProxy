use std::{
    path::{Path, PathBuf},
    sync::{atomic::Ordering, OnceLock},
};

use chrono::Utc;
use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, ResourceId, Runtime, Webview};

use crate::{config, AppLifecycle};

pub(crate) const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const CHECKPOINT_FILE: &str = "update-checkpoint.json";
const PREFERENCES_FILE: &str = "update-preferences.json";
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

fn update_check_disabled_by(value: Option<&str>) -> bool {
    value == Some("1")
}

fn update_check_disabled() -> bool {
    let value = std::env::var("MIOPROXY_DISABLE_UPDATE_CHECK").ok();
    update_check_disabled_by(value.as_deref())
}

pub(crate) fn register_app_handle(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
}

fn registered_app_handle() -> Result<AppHandle, String> {
    APP_HANDLE
        .get()
        .cloned()
        .ok_or_else(|| "MioProxy AppHandle 尚未初始化".to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum UpdatePhase {
    Preparing,
    Installing,
    Restarting,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCheckpoint {
    pub previous_version: String,
    pub target_version: String,
    pub system_proxy_was_enabled: bool,
    #[serde(default)]
    pub system_proxy_was_managed: bool,
    pub tun_was_enabled: bool,
    #[serde(default)]
    pub service_was_running: bool,
    #[serde(default)]
    pub core_was_running: bool,
    #[serde(default)]
    pub tun_profile_id: Option<String>,
    pub update_started_at: String,
    pub phase: UpdatePhase,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateStatus {
    pub current_version: String,
    pub updating: bool,
    pub checkpoint: Option<UpdateCheckpoint>,
    pub recovery_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdatePreferences {
    pub check_on_startup: bool,
    pub auto_download: bool,
}

impl Default for UpdatePreferences {
    fn default() -> Self {
        Self {
            check_on_startup: true,
            auto_download: false,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateMetadata {
    rid: ResourceId,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
}

fn checkpoint_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(CHECKPOINT_FILE))
}

fn preferences_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(PREFERENCES_FILE))
}

fn read_preferences_at(path: &Path) -> Result<UpdatePreferences, String> {
    let Some(content) = config::read_text_file_at(path, "读取更新设置")? else {
        return Ok(UpdatePreferences::default());
    };
    serde_json::from_str(&content).map_err(|error| format!("更新设置格式无效：{error}"))
}

fn write_preferences_at(path: &Path, preferences: &UpdatePreferences) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(preferences)
        .map_err(|error| format!("序列化更新设置失败：{error}"))?;
    config::write_atomic(path, &bytes)
}

fn read_checkpoint_at(path: &Path) -> Result<Option<UpdateCheckpoint>, String> {
    let Some(content) = config::read_text_file_at(path, "读取更新检查点")? else {
        return Ok(None);
    };
    serde_json::from_str(&content)
        .map(Some)
        .map_err(|error| format!("更新检查点格式无效：{error}；不会继续执行更新恢复"))
}

fn write_checkpoint_at(path: &Path, checkpoint: &UpdateCheckpoint) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(checkpoint)
        .map_err(|error| format!("序列化更新检查点失败：{error}"))?;
    config::write_atomic(path, &bytes)
}

fn clear_checkpoint_at(path: &Path) -> Result<(), String> {
    config::remove_file(path, "删除更新检查点")
}

pub(crate) fn parse_version(value: &str) -> Result<Version, String> {
    Version::parse(value.trim().trim_start_matches('v'))
        .map_err(|error| format!("版本号无效：{value}（{error}）"))
}

pub(crate) fn ensure_upgrade(current: &str, target: &str) -> Result<(), String> {
    let current = parse_version(current)?;
    let target = parse_version(target)?;
    if target <= current {
        return Err(format!(
            "拒绝安装非升级版本：当前 {}，目标 {}",
            current, target
        ));
    }
    Ok(())
}

pub(crate) fn checkpoint_for_app<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<UpdateCheckpoint>, String> {
    read_checkpoint_at(&checkpoint_path(app)?)
}

pub(crate) fn write_checkpoint(
    app: &AppHandle,
    checkpoint: &UpdateCheckpoint,
) -> Result<(), String> {
    write_checkpoint_at(&checkpoint_path(app)?, checkpoint)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CheckpointRecovery {
    VersionMismatch,
    CompleteUpgrade,
    MarkInterrupted,
    NoAction,
}

fn checkpoint_recovery(checkpoint: &UpdateCheckpoint) -> CheckpointRecovery {
    if checkpoint.target_version != CURRENT_VERSION {
        return CheckpointRecovery::VersionMismatch;
    }
    if checkpoint.previous_version != CURRENT_VERSION {
        return CheckpointRecovery::CompleteUpgrade;
    }
    if matches!(
        checkpoint.phase,
        UpdatePhase::Preparing | UpdatePhase::Installing | UpdatePhase::Restarting
    ) {
        return CheckpointRecovery::MarkInterrupted;
    }
    CheckpointRecovery::NoAction
}

pub(crate) fn mark_phase<R: Runtime>(app: &AppHandle<R>, phase: UpdatePhase) -> Result<(), String> {
    let path = checkpoint_path(app)?;
    let Some(mut checkpoint) = read_checkpoint_at(&path)? else {
        return Err("更新检查点不存在，拒绝修改更新阶段".to_string());
    };
    checkpoint.phase = phase;
    write_checkpoint_at(&path, &checkpoint)
}

pub(crate) fn mark_failed<R: Runtime>(app: &AppHandle<R>, error: &str) -> Result<(), String> {
    let path = checkpoint_path(app)?;
    if let Some(mut checkpoint) = read_checkpoint_at(&path)? {
        checkpoint.phase = UpdatePhase::Failed;
        write_checkpoint_at(&path, &checkpoint)?;
    }
    if let Some(lifecycle) = app.try_state::<AppLifecycle>() {
        lifecycle.updating.store(false, Ordering::SeqCst);
    }
    Err(error.to_string())
}

pub(crate) fn recover_checkpoint<R: Runtime>(app: &AppHandle<R>) -> Result<Option<String>, String> {
    let path = checkpoint_path(app)?;
    let Some(checkpoint) = read_checkpoint_at(&path)? else {
        return Ok(None);
    };

    match checkpoint_recovery(&checkpoint) {
        CheckpointRecovery::VersionMismatch => Ok(Some(format!(
            "更新检查点目标版本 {} 与当前 GUI {} 不一致；已阻止自动恢复 TUN",
            checkpoint.target_version, CURRENT_VERSION
        ))),
        CheckpointRecovery::CompleteUpgrade => {
            let mut completed = checkpoint;
            completed.phase = UpdatePhase::Completed;
            write_checkpoint_at(&path, &completed)?;
            Ok(None)
        }
        CheckpointRecovery::MarkInterrupted => {
            let mut failed = checkpoint;
            failed.phase = UpdatePhase::Failed;
            write_checkpoint_at(&path, &failed)?;
            Ok(Some(
                "上次更新在版本切换前中断；已阻止自动恢复代理/TUN，请重新检查更新状态".to_string(),
            ))
        }
        CheckpointRecovery::NoAction => Ok(None),
    }
}

pub(crate) async fn recover_after_startup(app: AppHandle) {
    let checkpoint = match checkpoint_for_app(&app) {
        Ok(checkpoint) => checkpoint,
        Err(error) => {
            eprintln!("读取更新恢复检查点失败：{error}");
            return;
        }
    };
    let Some(checkpoint) = checkpoint else {
        return;
    };

    let recovery = checkpoint_recovery(&checkpoint);
    let result = match recovery {
        CheckpointRecovery::CompleteUpgrade => restore_previous_state(&app, &checkpoint).await,
        CheckpointRecovery::MarkInterrupted => recover_after_update_failure(&app).await,
        CheckpointRecovery::VersionMismatch | CheckpointRecovery::NoAction => Ok(()),
    };

    match result {
        Ok(()) => {
            if recovery == CheckpointRecovery::CompleteUpgrade {
                match checkpoint_path(&app) {
                    Ok(path) => {
                        if let Err(error) = clear_checkpoint_at(&path) {
                            eprintln!("更新成功后删除检查点失败：{error}");
                        }
                    }
                    Err(error) => eprintln!("更新成功后无法定位检查点：{error}"),
                }
            }
        }
        Err(error) => {
            eprintln!("更新启动恢复失败：{error}");
            let _ = mark_failed(&app, &error);
        }
    }
}

fn checkpoint_error(checkpoint: &UpdateCheckpoint) -> Option<String> {
    if checkpoint.target_version != CURRENT_VERSION {
        return Some(format!(
            "更新检查点目标版本 {} 与当前 GUI {} 不一致；已阻止自动恢复 TUN",
            checkpoint.target_version, CURRENT_VERSION
        ));
    }
    if checkpoint.phase == UpdatePhase::Failed {
        return Some("上次更新未完成，已保持安全网络状态，请重新检查更新".to_string());
    }
    None
}

#[derive(Debug, Clone)]
struct UpdateRuntimeSnapshot {
    system_proxy_was_enabled: bool,
    system_proxy_was_managed: bool,
    service_was_running: bool,
    core_was_running: bool,
    tun_was_enabled: bool,
    tun_profile_id: Option<String>,
}

async fn capture_runtime_snapshot(app: &AppHandle) -> Result<UpdateRuntimeSnapshot, String> {
    let service = crate::service::request_service_status(app).await?;
    let local_tun_enabled = crate::tun::is_active(app);
    let (service_was_running, service_core_was_running, service_tun_was_enabled, profile_id) =
        service
            .as_ref()
            .map(|status| {
                (
                    true,
                    status.owns_core && status.core.running,
                    status.tun_status != "disabled",
                    status.tun_profile_id.clone(),
                )
            })
            .unwrap_or((false, false, false, None));
    let core_was_running = if service_was_running {
        service_core_was_running
    } else {
        crate::mihomo::owns_core(app) && crate::mihomo::is_running().await
    };
    let tun_was_enabled = local_tun_enabled || service_tun_was_enabled;
    let tun_profile_id = profile_id.or_else(|| crate::tun::active_profile_id(app));
    Ok(UpdateRuntimeSnapshot {
        system_proxy_was_enabled: crate::system_proxy::is_enabled_for_update(app)?,
        system_proxy_was_managed: crate::system_proxy::is_managed_for_update(app)?,
        service_was_running,
        core_was_running,
        tun_was_enabled,
        tun_profile_id,
    })
}

async fn recover_after_update_failure(app: &AppHandle) -> Result<(), String> {
    let Some(checkpoint) = checkpoint_for_app(app)? else {
        return Ok(());
    };
    restore_previous_state(app, &checkpoint).await
}

async fn restore_previous_state(
    app: &AppHandle,
    checkpoint: &UpdateCheckpoint,
) -> Result<(), String> {
    let mut errors = Vec::new();

    if checkpoint.service_was_running {
        if let Err(error) = crate::service::resume_after_update_failure(app, true).await {
            errors.push(error);
        } else if checkpoint.core_was_running {
            match crate::service::request_core(app, crate::service::ServiceCommand::Start).await {
                Ok(Some(status)) if status.running => {}
                Ok(Some(_)) => errors.push("更新后 Service Mihomo 未恢复 Running".to_string()),
                Ok(None) => errors.push("更新后 Service IPC 未恢复，拒绝恢复 TUN".to_string()),
                Err(error) => errors.push(format!("更新后恢复 Service Mihomo 失败：{error}")),
            }
        }
        if errors.is_empty() && checkpoint.tun_was_enabled {
            match checkpoint.tun_profile_id.clone() {
                Some(profile_id) => {
                    match crate::service::request_tun(app, true, Some(profile_id), false).await {
                        Ok(Some(snapshot)) if snapshot.status == crate::tun::TunStatus::Running => {
                        }
                        Ok(Some(snapshot)) => errors.push(format!(
                            "更新后 Service TUN 未恢复 Running（当前 {:?}）",
                            snapshot.status
                        )),
                        Ok(None) => {
                            errors.push("更新后 Service IPC 未恢复，拒绝恢复 TUN".to_string())
                        }
                        Err(error) => errors.push(format!("更新后恢复 Service TUN 失败：{error}")),
                    }
                }
                None => errors.push("更新检查点缺少 TUN Profile，拒绝恢复 TUN".to_string()),
            }
        }
    } else if checkpoint.core_was_running {
        if let Err(error) = crate::mihomo::start_owned_for_lifecycle(app).await {
            errors.push(format!("更新后恢复 GUI Mihomo 失败：{error}"));
        } else if checkpoint.tun_was_enabled {
            match checkpoint.tun_profile_id.clone() {
                Some(profile_id) => {
                    if let Err(error) = crate::tun::set_enabled_for_lifecycle(app, profile_id).await
                    {
                        errors.push(format!("更新后恢复 GUI TUN 失败：{error}"));
                    }
                }
                None => errors.push("更新检查点缺少 GUI TUN Profile，拒绝恢复 TUN".to_string()),
            }
        }
    }

    if let Err(error) = crate::system_proxy::restore_after_update_success(app) {
        errors.push(format!("更新后恢复 System Proxy 快照失败：{error}"));
    } else if errors.is_empty()
        && checkpoint.system_proxy_was_enabled
        && checkpoint.system_proxy_was_managed
    {
        if let Err(error) = crate::system_proxy::set_enabled(app.clone(), true).await {
            errors.push(format!("更新后恢复 MioProxy System Proxy 失败：{error}"));
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

#[tauri::command]
pub(crate) async fn update_prepare(
    app: AppHandle,
    target_version: String,
) -> Result<UpdateStatus, String> {
    ensure_upgrade(CURRENT_VERSION, &target_version)?;
    let lifecycle = app.state::<AppLifecycle>();
    if lifecycle.updating.swap(true, Ordering::SeqCst) {
        return Err("已有更新正在准备，拒绝并发安装".to_string());
    }

    let snapshot = match capture_runtime_snapshot(&app).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            lifecycle.updating.store(false, Ordering::SeqCst);
            return Err(error);
        }
    };
    let checkpoint = UpdateCheckpoint {
        previous_version: CURRENT_VERSION.to_string(),
        target_version,
        system_proxy_was_enabled: snapshot.system_proxy_was_enabled,
        system_proxy_was_managed: snapshot.system_proxy_was_managed,
        tun_was_enabled: snapshot.tun_was_enabled,
        service_was_running: snapshot.service_was_running,
        core_was_running: snapshot.core_was_running,
        tun_profile_id: snapshot.tun_profile_id,
        update_started_at: Utc::now().to_rfc3339(),
        phase: UpdatePhase::Preparing,
    };
    if let Err(error) = write_checkpoint(&app, &checkpoint) {
        lifecycle.updating.store(false, Ordering::SeqCst);
        return Err(error);
    }

    let result = async {
        crate::system_proxy::disable_for_update(&app)?;
        crate::service::prepare_for_update(&app).await?;
        crate::tun::restore_for_lifecycle(&app, &app.state::<crate::tun::TunState>()).await?;
        crate::mihomo::stop_owned_for_update(&app).await?;
        crate::service::verify_stopped_for_update()?;
        if crate::tun::is_active(&app) {
            return Err("GUI TUN 仍处于活动状态，拒绝启动更新安装器".to_string());
        }
        if crate::mihomo::owns_core(&app) {
            return Err("GUI 仍拥有 Mihomo 子进程，拒绝启动更新安装器".to_string());
        }
        if crate::system_proxy::is_enabled_for_update(&app)? {
            return Err("System Proxy 仍处于开启状态，拒绝启动更新安装器".to_string());
        }
        mark_phase(&app, UpdatePhase::Installing)
    }
    .await;

    if let Err(error) = result {
        let _ = mark_failed(&app, &error);
        lifecycle.updating.store(false, Ordering::SeqCst);
        if let Err(recovery_error) = recover_after_update_failure(&app).await {
            crate::diagnostics::record_event(&app, "error", "update", &error);
            return Err(format!(
                "{error}；更新失败后的网络状态恢复也失败：{recovery_error}"
            ));
        }
        crate::diagnostics::record_event(&app, "error", "update", &error);
        return Err(error);
    }
    crate::diagnostics::record_event(
        &app,
        "info",
        "update",
        "Application update entered installing phase",
    );
    update_status(app).await
}

pub(crate) fn before_updater_exit(app: &AppHandle) -> Result<(), String> {
    let checkpoint = checkpoint_for_app(app)?
        .ok_or_else(|| "更新检查点不存在，拒绝启动更新安装器".to_string())?;
    if checkpoint.phase != UpdatePhase::Installing {
        return Err(format!(
            "更新检查点阶段为 {:?}，不是 installing，拒绝启动更新安装器",
            checkpoint.phase
        ));
    }
    crate::system_proxy::disable_for_update(app)?;
    crate::service::verify_stopped_for_update()?;
    if crate::tun::is_active(app) {
        return Err("更新安装器启动前检测到 GUI TUN 仍活动".to_string());
    }
    if crate::mihomo::owns_core(app) {
        return Err("更新安装器启动前检测到 GUI 仍拥有 Mihomo".to_string());
    }
    mark_phase(app, UpdatePhase::Restarting)
}

#[tauri::command]
pub(crate) async fn update_check<R: Runtime>(
    webview: Webview<R>,
) -> Result<Option<UpdateMetadata>, String> {
    if update_check_disabled() {
        return Ok(None);
    }

    use tauri_plugin_updater::UpdaterExt;

    let hook_app = registered_app_handle()?;
    let updater = webview
        .updater_builder()
        .on_before_exit(move || {
            if let Err(error) = before_updater_exit(&hook_app) {
                eprintln!("更新安装器退出前安全检查失败：{error}");
                let _ = mark_failed(&hook_app, &error);
                std::process::exit(1);
            }
            hook_app.cleanup_before_exit();
        })
        .build()
        .map_err(|error| format!("创建更新检查器失败：{error}"))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|error| format!("检查更新失败：{error}"))?
    else {
        return Ok(None);
    };
    ensure_upgrade(&update.current_version, &update.version)?;
    let date = update.date.and_then(|date| {
        date.format(&time::format_description::well_known::Rfc3339)
            .ok()
    });
    let rid = webview.resources_table().add(update.clone());
    Ok(Some(UpdateMetadata {
        rid,
        current_version: update.current_version,
        version: update.version,
        date,
        body: update.body,
        raw_json: update.raw_json,
    }))
}

#[tauri::command]
pub(crate) async fn update_status(app: AppHandle) -> Result<UpdateStatus, String> {
    let checkpoint = checkpoint_for_app(&app)?;
    let recovery_error = checkpoint.as_ref().and_then(checkpoint_error);
    let updating = app
        .try_state::<AppLifecycle>()
        .is_some_and(|lifecycle| lifecycle.updating.load(Ordering::SeqCst));
    Ok(UpdateStatus {
        current_version: CURRENT_VERSION.to_string(),
        updating,
        checkpoint,
        recovery_error,
    })
}

#[tauri::command]
pub(crate) fn update_preferences_status(app: AppHandle) -> Result<UpdatePreferences, String> {
    read_preferences_at(&preferences_path(&app)?)
}

#[tauri::command]
pub(crate) fn update_preferences_set(
    app: AppHandle,
    check_on_startup: bool,
    auto_download: bool,
) -> Result<UpdatePreferences, String> {
    crate::ensure_mutations_allowed(&app)?;
    let preferences = UpdatePreferences {
        check_on_startup,
        auto_download,
    };
    write_preferences_at(&preferences_path(&app)?, &preferences)?;
    Ok(preferences)
}

#[tauri::command]
pub(crate) async fn update_mark_failed(
    app: AppHandle,
    error: String,
) -> Result<UpdateStatus, String> {
    let path = checkpoint_path(&app)?;
    if let Some(mut checkpoint) = read_checkpoint_at(&path)? {
        checkpoint.phase = UpdatePhase::Failed;
        write_checkpoint_at(&path, &checkpoint)?;
    }
    if let Some(lifecycle) = app.try_state::<AppLifecycle>() {
        lifecycle.updating.store(false, Ordering::SeqCst);
    }
    crate::diagnostics::record_event(&app, "error", "update", &error);
    let recovery_error = recover_after_update_failure(&app)
        .await
        .err()
        .map(|recovery| format!("{error}；更新失败后的状态恢复失败：{recovery}"));
    let status = update_status(app)
        .await
        .map_err(|status_error| format!("{error}；读取更新状态失败：{status_error}"))?;
    if let Some(recovery_error) = recovery_error {
        return Err(recovery_error);
    }
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "mioproxy-update-{name}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock before unix epoch")
                .as_nanos()
        ))
    }

    #[test]
    fn accepts_only_strict_semver_upgrades() {
        assert!(ensure_upgrade("0.7.0", "0.8.0").is_ok());
        assert!(ensure_upgrade("v0.7.0", "v0.8.1").is_ok());
        assert!(ensure_upgrade("0.8.0", "0.8.0").is_err());
        assert!(ensure_upgrade("0.8.1", "0.8.0").is_err());
        assert!(ensure_upgrade("0.7.0", "not-semver").is_err());
    }

    #[test]
    fn update_check_disable_override_is_explicit() {
        assert!(!update_check_disabled_by(None));
        assert!(!update_check_disabled_by(Some("")));
        assert!(!update_check_disabled_by(Some("0")));
        assert!(!update_check_disabled_by(Some("true")));
        assert!(update_check_disabled_by(Some("1")));
    }

    #[test]
    fn checkpoint_serializes_camel_case_and_round_trips() {
        let checkpoint = UpdateCheckpoint {
            previous_version: "0.7.0".to_string(),
            target_version: "0.8.0".to_string(),
            system_proxy_was_enabled: true,
            system_proxy_was_managed: false,
            tun_was_enabled: false,
            service_was_running: false,
            core_was_running: false,
            tun_profile_id: None,
            update_started_at: "2026-08-09T00:00:00Z".to_string(),
            phase: UpdatePhase::Preparing,
        };
        let value = serde_json::to_value(&checkpoint).expect("serialize checkpoint");
        assert_eq!(value["previousVersion"], "0.7.0");
        assert_eq!(value["systemProxyWasEnabled"], true);
        assert_eq!(value["phase"], "preparing");
        assert_eq!(
            serde_json::from_value::<UpdateCheckpoint>(value).expect("deserialize checkpoint"),
            checkpoint
        );
    }

    #[test]
    fn checkpoint_write_is_atomic_and_recoverable() {
        let path = temp_path("checkpoint");
        let checkpoint = UpdateCheckpoint {
            previous_version: "0.7.0".to_string(),
            target_version: "0.8.0".to_string(),
            system_proxy_was_enabled: false,
            system_proxy_was_managed: false,
            tun_was_enabled: true,
            service_was_running: false,
            core_was_running: false,
            tun_profile_id: None,
            update_started_at: Utc::now().to_rfc3339(),
            phase: UpdatePhase::Installing,
        };
        write_checkpoint_at(&path, &checkpoint).expect("write checkpoint");
        assert_eq!(
            read_checkpoint_at(&path).expect("read checkpoint"),
            Some(checkpoint)
        );
        clear_checkpoint_at(&path).expect("clear checkpoint");
        assert!(!path.exists());
    }

    #[test]
    fn checkpoint_recovery_marks_interrupted_updates_and_completes_version_switches() {
        let base = UpdateCheckpoint {
            previous_version: CURRENT_VERSION.to_string(),
            target_version: CURRENT_VERSION.to_string(),
            system_proxy_was_enabled: false,
            system_proxy_was_managed: false,
            tun_was_enabled: false,
            service_was_running: false,
            core_was_running: false,
            tun_profile_id: None,
            update_started_at: Utc::now().to_rfc3339(),
            phase: UpdatePhase::Installing,
        };
        assert_eq!(
            checkpoint_recovery(&base),
            CheckpointRecovery::MarkInterrupted
        );

        let mut completed = base.clone();
        completed.previous_version = "0.7.0".to_string();
        assert_eq!(
            checkpoint_recovery(&completed),
            CheckpointRecovery::CompleteUpgrade
        );

        let mut mismatch = base;
        mismatch.target_version = "1.0.1".to_string();
        assert_eq!(
            checkpoint_recovery(&mismatch),
            CheckpointRecovery::VersionMismatch
        );
    }

    #[test]
    fn update_preferences_default_to_safe_manual_install_behavior() {
        let preferences = UpdatePreferences::default();
        assert!(preferences.check_on_startup);
        assert!(!preferences.auto_download);
    }

    #[test]
    fn update_preferences_serialize_as_camel_case() {
        let preferences = UpdatePreferences {
            check_on_startup: false,
            auto_download: true,
        };
        let value = serde_json::to_value(&preferences).expect("serialize preferences");
        assert_eq!(value["checkOnStartup"], false);
        assert_eq!(value["autoDownload"], true);
    }
}
