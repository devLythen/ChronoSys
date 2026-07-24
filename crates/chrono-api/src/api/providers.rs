use std::sync::Arc;

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use chrono_config::{LlmCredential, LlmModel, LlmProvider};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::api::validate_secret_ref;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_providers).post(create_provider))
        .route(
            "/{id}",
            get(get_provider).put(update_provider).delete(delete_provider),
        )
        .route(
            "/{id}/credential",
            get(get_credential).put(upsert_credential).delete(delete_credential),
        )
        .route(
            "/{id}/models",
            get(list_models).post(upsert_model),
        )
        .route(
            "/{id}/models/{model_id}",
            get(get_model).delete(delete_model),
        )
}

#[derive(Serialize)]
pub struct ProviderView {
    #[serde(flatten)]
    pub provider: LlmProvider,
    pub has_credential: bool,
    pub models: Vec<LlmModel>,
}

#[derive(Deserialize)]
pub struct ProviderBody {
    pub id: Option<String>,
    pub kind: String,
    pub base_url: Option<String>,
    pub display_name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub json_ext: Value,
}

#[derive(Deserialize)]
pub struct CredentialBody {
    pub auth_kind: String,
    pub secret_ref: String,
    #[serde(default)]
    pub json_ext: Value,
}

#[derive(Serialize)]
pub struct CredentialView {
    pub provider_id: String,
    pub auth_kind: String,
    pub has_secret: bool,
    pub json_ext: Value,
    pub updated_at: String,
}

#[derive(Deserialize)]
pub struct ModelBody {
    pub model_id: String,
    pub display_name: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i64>,
    pub top_p: Option<f64>,
    pub extra_headers_json: Option<Value>,
    pub extra_body_json: Option<Value>,
    pub thinking_level: Option<String>,
    #[serde(default)]
    pub json_ext: Value,
}

fn default_true() -> bool {
    true
}

fn empty_obj() -> Value {
    json!({})
}

async fn list_providers(State(state): State<Arc<AppState>>) -> ApiResult<Json<Vec<ProviderView>>> {
    let store = lock_config(&state)?;
    let providers = store.providers().list_providers()?;
    let mut out = Vec::with_capacity(providers.len());
    for p in providers {
        let has_credential = store.providers().get_credential(&p.id).is_ok();
        let models = store.providers().list_models(&p.id).unwrap_or_default();
        out.push(ProviderView {
            provider: p,
            has_credential,
            models,
        });
    }
    Ok(Json(out))
}

async fn get_provider(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<ProviderView>> {
    let store = lock_config(&state)?;
    let provider = store.providers().get_provider(&id)?;
    let has_credential = store.providers().get_credential(&id).is_ok();
    let models = store.providers().list_models(&id).unwrap_or_default();
    Ok(Json(ProviderView {
        provider,
        has_credential,
        models,
    }))
}

async fn create_provider(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ProviderBody>,
) -> ApiResult<Json<ProviderView>> {
    let id = body
        .id
        .clone()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad_request("id is required"))?;
    let provider = LlmProvider {
        id: id.clone(),
        kind: body.kind,
        base_url: body.base_url,
        display_name: body.display_name,
        enabled: body.enabled,
        json_ext: if body.json_ext.is_null() {
            empty_obj()
        } else {
            body.json_ext
        },
        created_at: String::new(),
        updated_at: String::new(),
    };
    {
        let store = lock_config(&state)?;
        store.providers().insert_provider(&provider)?;
    }
    state.notify_reload();
    get_provider(State(state), Path(id)).await
}

async fn update_provider(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<ProviderBody>,
) -> ApiResult<Json<ProviderView>> {
    let provider = LlmProvider {
        id: id.clone(),
        kind: body.kind,
        base_url: body.base_url,
        display_name: body.display_name,
        enabled: body.enabled,
        json_ext: if body.json_ext.is_null() {
            empty_obj()
        } else {
            body.json_ext
        },
        created_at: String::new(),
        updated_at: String::new(),
    };
    {
        let store = lock_config(&state)?;
        store.providers().update_provider(&provider)?;
    }
    state.notify_reload();
    get_provider(State(state), Path(id)).await
}

async fn delete_provider(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    {
        let store = lock_config(&state)?;
        store.providers().delete_provider(&id)?;
    }
    state.notify_reload();
    Ok(Json(json!({ "ok": true, "id": id })))
}

async fn get_credential(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<CredentialView>> {
    let store = lock_config(&state)?;
    let c = store.providers().get_credential(&id)?;
    Ok(Json(mask_credential(c)))
}

async fn upsert_credential(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<CredentialBody>,
) -> ApiResult<Json<CredentialView>> {
    validate_secret_ref(&body.secret_ref).map_err(ApiError::bad_request)?;
    let c = LlmCredential {
        provider_id: id.clone(),
        auth_kind: body.auth_kind,
        secret_ref: body.secret_ref,
        json_ext: if body.json_ext.is_null() {
            empty_obj()
        } else {
            body.json_ext
        },
        updated_at: String::new(),
    };
    {
        let store = lock_config(&state)?;
        // ensure provider exists
        store.providers().get_provider(&id)?;
        store.providers().upsert_credential(&c)?;
    }
    state.notify_reload();
    get_credential(State(state), Path(id)).await
}

async fn delete_credential(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    {
        let store = lock_config(&state)?;
        store.providers().delete_credential(&id)?;
    }
    state.notify_reload();
    Ok(Json(json!({ "ok": true, "provider_id": id })))
}

async fn list_models(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<LlmModel>>> {
    let store = lock_config(&state)?;
    store.providers().get_provider(&id)?;
    Ok(Json(store.providers().list_models(&id)?))
}

async fn get_model(
    State(state): State<Arc<AppState>>,
    Path((id, model_id)): Path<(String, String)>,
) -> ApiResult<Json<LlmModel>> {
    let store = lock_config(&state)?;
    Ok(Json(store.providers().get_model(&id, &model_id)?))
}

async fn upsert_model(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<ModelBody>,
) -> ApiResult<Json<LlmModel>> {
    let model = LlmModel {
        provider_id: id.clone(),
        model_id: body.model_id.clone(),
        display_name: body.display_name,
        enabled: body.enabled,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        top_p: body.top_p,
        extra_headers_json: body.extra_headers_json,
        extra_body_json: body.extra_body_json,
        thinking_level: body.thinking_level,
        json_ext: if body.json_ext.is_null() {
            empty_obj()
        } else {
            body.json_ext
        },
        created_at: String::new(),
        updated_at: String::new(),
    };
    {
        let store = lock_config(&state)?;
        store.providers().get_provider(&id)?;
        store.providers().upsert_model(&model)?;
    }
    state.notify_reload();
    get_model(State(state), Path((id, body.model_id))).await
}

async fn delete_model(
    State(state): State<Arc<AppState>>,
    Path((id, model_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    {
        let store = lock_config(&state)?;
        store.providers().delete_model(&id, &model_id)?;
    }
    state.notify_reload();
    Ok(Json(json!({ "ok": true, "provider_id": id, "model_id": model_id })))
}

fn mask_credential(c: LlmCredential) -> CredentialView {
    CredentialView {
        provider_id: c.provider_id,
        auth_kind: c.auth_kind,
        has_secret: !c.secret_ref.is_empty(),
        json_ext: c.json_ext,
        updated_at: c.updated_at,
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
