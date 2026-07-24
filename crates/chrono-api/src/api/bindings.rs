use std::sync::Arc;

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use chrono_config::Binding;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_bindings).post(create_binding))
        .route(
            "/{id}",
            get(get_binding).put(update_binding).delete(delete_binding),
        )
}

#[derive(Deserialize)]
pub struct BindingBody {
    pub id: Option<String>,
    pub account_id: String,
    pub chat_pattern: String,
    pub bot_profile_id: String,
    #[serde(default = "default_session_mode")]
    pub session_mode: String,
    #[serde(default)]
    pub priority: i64,
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
fn default_session_mode() -> String {
    "shared".into()
}

async fn list_bindings(State(state): State<Arc<AppState>>) -> ApiResult<Json<Vec<Binding>>> {
    let store = lock_config(&state)?;
    Ok(Json(store.bots().list_all_bindings()?))
}

async fn get_binding(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<Binding>> {
    let store = lock_config(&state)?;
    Ok(Json(store.bots().get_binding(&id)?))
}

async fn create_binding(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BindingBody>,
) -> ApiResult<Json<Binding>> {
    let id = body
        .id
        .clone()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad_request("id is required"))?;
    let binding = Binding {
        id: id.clone(),
        account_id: body.account_id,
        chat_pattern: body.chat_pattern,
        bot_profile_id: body.bot_profile_id,
        session_mode: body.session_mode,
        priority: body.priority,
        enabled: body.enabled,
        json_ext: body.json_ext,
        created_at: String::new(),
        updated_at: String::new(),
    };
    {
        let store = lock_config(&state)?;
        store.bots().insert_binding(&binding)?;
    }
    state.notify_reload();
    get_binding(State(state), Path(id)).await
}

async fn update_binding(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<BindingBody>,
) -> ApiResult<Json<Binding>> {
    let binding = Binding {
        id: id.clone(),
        account_id: body.account_id,
        chat_pattern: body.chat_pattern,
        bot_profile_id: body.bot_profile_id,
        session_mode: body.session_mode,
        priority: body.priority,
        enabled: body.enabled,
        json_ext: body.json_ext,
        created_at: String::new(),
        updated_at: String::new(),
    };
    {
        let store = lock_config(&state)?;
        store.bots().update_binding(&binding)?;
    }
    state.notify_reload();
    get_binding(State(state), Path(id)).await
}

async fn delete_binding(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    {
        let store = lock_config(&state)?;
        store.bots().delete_binding(&id)?;
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
