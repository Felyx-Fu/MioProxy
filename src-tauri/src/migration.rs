use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::config;

pub(crate) const CURRENT_SCHEMA_VERSION: u32 = 1;
const SCHEMA_FILE: &str = "config-schema.json";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SchemaState {
    pub config_schema_version: u32,
}

fn schema_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(SCHEMA_FILE))
}

fn read_schema_at(path: &Path) -> Result<Option<SchemaState>, String> {
    let Some(content) = config::read_text_file_at(path, "读取配置 schema")? else {
        return Ok(None);
    };
    serde_json::from_str(&content)
        .map(Some)
        .map_err(|error| format!("配置 schema 文件损坏：{error}；已保留原文件，不会覆盖用户数据"))
}

fn write_schema_at(path: &Path, state: SchemaState) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(&state).map_err(|error| error.to_string())?;
    config::write_atomic(path, &bytes)
}

fn migrate_state(state: Option<SchemaState>) -> Result<SchemaState, String> {
    let current = state.map(|value| value.config_schema_version).unwrap_or(0);
    if current > CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "配置 schema {current} 高于当前支持版本 {CURRENT_SCHEMA_VERSION}；拒绝迁移"
        ));
    }
    Ok(SchemaState {
        config_schema_version: CURRENT_SCHEMA_VERSION,
    })
}

pub(crate) fn ensure_current(app: &AppHandle) -> Result<SchemaState, String> {
    let path = schema_path(app)?;
    let state = migrate_state(read_schema_at(&path)?)?;
    write_schema_at(&path, state)?;
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::{migrate_state, SchemaState, CURRENT_SCHEMA_VERSION};

    #[test]
    fn missing_and_old_schema_versions_migrate_idempotently() {
        let first = migrate_state(None).unwrap();
        assert_eq!(first.config_schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(migrate_state(Some(first)).unwrap(), first);
        assert_eq!(
            migrate_state(Some(SchemaState {
                config_schema_version: 0,
            }))
            .unwrap()
            .config_schema_version,
            CURRENT_SCHEMA_VERSION
        );
    }

    #[test]
    fn future_schema_is_not_overwritten() {
        let error = migrate_state(Some(SchemaState {
            config_schema_version: CURRENT_SCHEMA_VERSION + 1,
        }))
        .unwrap_err();
        assert!(error.contains("拒绝迁移"));
    }
}
