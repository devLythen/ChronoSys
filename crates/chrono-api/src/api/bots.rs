use std::sync::Arc;

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use chrono_config::BotProfile;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_bots).post(create_bot))
        .route(
            "/{id}",
            get(get_bot).put(update_bot).delete(delete_bot),
        )
}

#[derive(Deserialize)]
pub struct BotBody {
    pub id: Option<String>,
    pub display_name: String,
    #[serde(default)]
    pub system_prompt: String,
    pub model_ref: String,
    #[serde(default = "default_tools")]
    pub tools_allowlist_json: Value,
    #[serde(default = "default_arr")]
    pub skills_allowlist_json: Value,
    #[serde(default = "default_obj")]
    pub policy_json: Value,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_obj")]
    pub json_ext: Value,
}

fn default_true() -> bool {
    true
}
fn default_obj() -> Value {
    json!({})
}
fn default_arr() -> Value {
    json!([])
}
fn default_tools() -> Value {
    json!(["message_send"])
}

async fn list_bots(State(state): State<Arc<AppState>>) -> ApiResult<Json<Vec<BotProfile>>> {
    let store = lock_config(&state)?;
    Ok(Json(store.bots().list_bots()?))
}

async fn get_bot(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<BotProfile>> {
    let store = lock_config(&state)?;
    Ok(Json(store.bots().get_bot(&id)?))
}

async fn create_bot(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BotBody>,
) -> ApiResult<Json<BotProfile>> {
    let id = body
        .id
        .clone()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad_request("id is required"))?;
    let bot = BotProfile {
        id: id.clone(),
        display_name: body.display_name,
        system_prompt: body.system_prompt,
        model_ref: body.model_ref,
        tools_allowlist_json: body.tools_allowlist_json,
        skills_allowlist_json: body.skills_allowlist_json,
        policy_json: body.policy_json,
        enabled: body.enabled,
        json_ext: body.json_ext,
        created_at: String::new(),
        updated_at: String::new(),
    };
    {
        let store = lock_config(&state)?;
        store.bots().insert_bot(&bot)?;
    }
    state.notify_reload();
    get_bot(State(state), Path(id)).await
}

async fn update_bot(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<BotBody>,
) -> ApiResult<Json<BotProfile>> {
    let bot = BotProfile {
        id: id.clone(),
        display_name: body.display_name,
        system_prompt: body.system_prompt,
        model_ref: body.model_ref,
        tools_allowlist_json: body.tools_allowlist_json,
        skills_allowlist_json: body.skills_allowlist_json,
        policy_json: body.policy_json,
        enabled: body.enabled,
        json_ext: body.json_ext,
        created_at: String::new(),
        updated_at: String::new(),
    };
    {
        let store = lock_config(&state)?;
        store.bots().update_bot(&bot)?;
    }
    state.notify_reload();
    get_bot(State(state), Path(id)).await
}

async fn delete_bot(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    {
        let store = lock_config(&state)?;
        store.bots().delete_bot(&id)?;
    }
    state.notify_reload();
    Ok(Json(json!({ "ok": true, "id": id })))
}

fn lock_config(
    state: &AppState,
) -> ApiResult<std::sync::MutexGuard<'_, chrono_config::ConfigStore>> {
    state
        .config
        .lock()
        .map_err(|_| ApiError::internal("config lock poisoned"))
}
