use std::sync::Arc;

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use chrono_config::Persona;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_personas).post(create_persona))
        .route(
            "/{id}",
            get(get_persona).put(update_persona).delete(delete_persona),
        )
}

#[derive(Serialize)]
pub struct PersonaView {
    pub id: String,
    pub system_prompt: String,
    pub tools_allowlist_json: Value,
    pub skills_allowlist_json: Value,
    pub json_ext: Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
pub struct PersonaBody {
    pub id: Option<String>,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default = "default_arr")]
    pub tools_allowlist_json: Value,
    #[serde(default = "default_arr")]
    pub skills_allowlist_json: Value,
    #[serde(default = "default_obj")]
    pub json_ext: Value,
}

fn default_obj() -> Value {
    json!({})
}

fn default_arr() -> Value {
    json!([])
}

fn view(p: Persona) -> PersonaView {
    PersonaView {
        id: p.id,
        system_prompt: p.system_prompt,
        tools_allowlist_json: p.tools_allowlist_json,
        skills_allowlist_json: p.skills_allowlist_json,
        json_ext: p.json_ext,
        created_at: p.created_at,
        updated_at: p.updated_at,
    }
}

async fn list_personas(State(state): State<Arc<AppState>>) -> ApiResult<Json<Vec<PersonaView>>> {
    let store = lock_config(&state)?;
    let personas = store.personas().list()?;
    Ok(Json(personas.into_iter().map(view).collect()))
}

async fn get_persona(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<PersonaView>> {
    let store = lock_config(&state)?;
    Ok(Json(view(store.personas().get(&id)?)))
}

async fn create_persona(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PersonaBody>,
) -> ApiResult<Json<PersonaView>> {
    let id = body
        .id
        .clone()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad_request("id is required"))?;

    let persona = Persona {
        id: id.clone(),
        system_prompt: body.system_prompt,
        tools_allowlist_json: normalize_obj(body.tools_allowlist_json),
        skills_allowlist_json: normalize_obj(body.skills_allowlist_json),
        json_ext: normalize_obj(body.json_ext),
        created_at: String::new(),
        updated_at: String::new(),
    };
    {
        let store = lock_config(&state)?;
        store.personas().insert(&persona)?;
    }
    state.notify_reload();
    get_persona(State(state), Path(id)).await
}

async fn update_persona(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<PersonaBody>,
) -> ApiResult<Json<PersonaView>> {
    let persona = Persona {
        id: id.clone(),
        system_prompt: body.system_prompt,
        tools_allowlist_json: normalize_obj(body.tools_allowlist_json),
        skills_allowlist_json: normalize_obj(body.skills_allowlist_json),
        json_ext: normalize_obj(body.json_ext),
        created_at: String::new(),
        updated_at: String::new(),
    };
    {
        let store = lock_config(&state)?;
        store.personas().update(&persona)?;
    }
    state.notify_reload();
    get_persona(State(state), Path(id)).await
}

async fn delete_persona(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    {
        let store = lock_config(&state)?;
        store.personas().delete(&id)?;
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
