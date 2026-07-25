use std::sync::Arc;

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use chrono_config::PlatformAccount;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_accounts).post(create_account))
        .route(
            "/{id}",
            get(get_account).put(update_account).delete(delete_account),
        )
}

#[derive(Serialize)]
pub struct AccountView {
    pub id: String,
    pub platform: String,
    pub adapter_id: String,
    pub enabled: bool,
    pub secret_ref: String,
    pub adapter_config_json: Value,
    pub json_ext: Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
pub struct AccountBody {
    pub id: Option<String>,
    pub platform: String,
    pub adapter_id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub secret_ref: Option<String>,
    #[serde(default)]
    pub adapter_config_json: Value,
    #[serde(default)]
    pub json_ext: Value,
}

fn default_true() -> bool {
    true
}

fn mask(a: PlatformAccount) -> AccountView {
    AccountView {
        id: a.id,
        platform: a.platform,
        adapter_id: a.adapter_id,
        enabled: a.enabled,
        secret_ref: a.secret_ref,
        adapter_config_json: a.adapter_config_json,
        json_ext: a.json_ext,
        created_at: a.created_at,
        updated_at: a.updated_at,
    }
}

async fn list_accounts(State(state): State<Arc<AppState>>) -> ApiResult<Json<Vec<AccountView>>> {
    let store = lock_config(&state)?;
    let accounts = store.accounts().list_accounts()?;
    Ok(Json(accounts.into_iter().map(mask).collect()))
}

async fn get_account(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<AccountView>> {
    let store = lock_config(&state)?;
    Ok(Json(mask(store.accounts().get_account(&id)?)))
}

async fn create_account(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AccountBody>,
) -> ApiResult<Json<AccountView>> {
    let id = body
        .id
        .clone()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad_request("id is required"))?;
    let secret_ref = body
        .secret_ref
        .clone()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad_request("secret_ref is required"))?;

    let account = PlatformAccount {
        id: id.clone(),
        platform: body.platform,
        adapter_id: body.adapter_id,
        enabled: body.enabled,
        secret_ref,
        adapter_config_json: normalize_obj(body.adapter_config_json),
        json_ext: normalize_obj(body.json_ext),
        created_at: String::new(),
        updated_at: String::new(),
    };
    {
        let store = lock_config(&state)?;
        store.accounts().insert_account(&account)?;
    }
    state.notify_reload();
    get_account(State(state), Path(id)).await
}

async fn update_account(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<AccountBody>,
) -> ApiResult<Json<AccountView>> {
    let existing = {
        let store = lock_config(&state)?;
        store.accounts().get_account(&id)?
    };
    let secret_ref = match body.secret_ref {
        Some(s) if !s.is_empty() => {
            s
        }
        _ => existing.secret_ref,
    };
    let account = PlatformAccount {
        id: id.clone(),
        platform: body.platform,
        adapter_id: body.adapter_id,
        enabled: body.enabled,
        secret_ref,
        adapter_config_json: normalize_obj(body.adapter_config_json),
        json_ext: normalize_obj(body.json_ext),
        created_at: String::new(),
        updated_at: String::new(),
    };
    {
        let store = lock_config(&state)?;
        store.accounts().update_account(&account)?;
    }
    state.notify_reload();
    get_account(State(state), Path(id)).await
}

async fn delete_account(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    {
        let store = lock_config(&state)?;
        store.accounts().delete_account(&id)?;
    }
    state.notify_reload();
    Ok(Json(json!({ "ok": true, "id": id })))
}

fn normalize_obj(v: Value) -> Value {
    if v.is_null() {
        json!({})
    } else {
        v
    }
}

fn lock_config(
    state: &AppState,
) -> ApiResult<std::sync::MutexGuard<'_, chrono_config::ConfigStore>> {
    state
        .config
        .lock()
        .map_err(|_| ApiError::internal("config lock poisoned"))
}
