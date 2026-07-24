use std::sync::Arc;

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use chrono_config::Setting;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_settings).post(set_setting))
        .route(
            "/{key}",
            get(get_setting).put(put_setting).delete(delete_setting),
        )
}

#[derive(Deserialize)]
pub struct SettingBody {
    pub key: Option<String>,
    pub value_json: Value,
}

async fn list_settings(State(state): State<Arc<AppState>>) -> ApiResult<Json<Vec<Setting>>> {
    let store = lock_config(&state)?;
    Ok(Json(store.settings().list()?))
}

async fn get_setting(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
) -> ApiResult<Json<Setting>> {
    let store = lock_config(&state)?;
    store
        .settings()
        .get(&key)?
        .map(Json)
        .ok_or_else(|| ApiError::not_found(format!("settings '{key}' not found")))
}

async fn set_setting(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SettingBody>,
) -> ApiResult<Json<Setting>> {
    let key = body
        .key
        .clone()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad_request("key is required"))?;
    {
        let store = lock_config(&state)?;
        store.settings().set(&key, &body.value_json)?;
    }
    get_setting(State(state), Path(key)).await
}

async fn put_setting(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
    Json(body): Json<SettingBody>,
) -> ApiResult<Json<Setting>> {
    {
        let store = lock_config(&state)?;
        store.settings().set(&key, &body.value_json)?;
    }
    get_setting(State(state), Path(key)).await
}

async fn delete_setting(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
) -> ApiResult<Json<Value>> {
    {
        let store = lock_config(&state)?;
        store.settings().delete(&key)?;
    }
    Ok(Json(json!({ "ok": true, "key": key })))
}

fn lock_config(
    state: &AppState,
) -> ApiResult<std::sync::MutexGuard<'_, chrono_config::ConfigStore>> {
    state
        .config
        .lock()
        .map_err(|_| ApiError::internal("config lock poisoned"))
}
