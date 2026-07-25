use std::sync::Arc;

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use chrono_config::{LlmCredential, LlmModel, LlmProvider};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

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
        .route("/{id}/models/{model_id}/info", get(get_model_info))
        .route("/{id}/refresh-models", get(refresh_models))
}

#[derive(Serialize)]
pub struct ProviderView {
    #[serde(flatten)]
    pub provider: LlmProvider,
    pub secret_ref: Option<String>,
    pub models: Vec<LlmModel>,
}

#[derive(Deserialize)]
pub struct ProviderBody {
    pub id: Option<String>,
    pub kind: String,
    pub base_url: Option<String>,
    pub display_name: String,
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
    pub secret_ref: String,
    pub json_ext: Value,
    pub updated_at: String,
}

#[derive(Deserialize)]
pub struct ModelBody {
    pub model_id: String,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i64>,
    pub top_p: Option<f64>,
    pub thinking_level: Option<String>,
    pub extra_body_json: Option<Value>,
    #[serde(default)]
    pub json_ext: Value,
}

#[derive(Serialize)]
struct RefreshedModel {
    id: String,
}

fn empty_obj() -> Value {
    json!({})
}

async fn list_providers(State(state): State<Arc<AppState>>) -> ApiResult<Json<Vec<ProviderView>>> {
    let store = lock_config(&state)?;
    let providers = store.providers().list_providers()?;
    let mut out = Vec::with_capacity(providers.len());
    for p in providers {
        let secret_ref = store
            .providers()
            .get_credential(&p.id)
            .ok()
            .map(|c| c.secret_ref);
        let models = store.providers().list_models(&p.id).unwrap_or_default();
        out.push(ProviderView {
            provider: p,
            secret_ref,
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
    let secret_ref = store
        .providers()
        .get_credential(&id)
        .ok()
        .map(|c| c.secret_ref);
    let models = store.providers().list_models(&id).unwrap_or_default();
    Ok(Json(ProviderView {
        provider,
        secret_ref,
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
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        top_p: body.top_p,
        thinking_level: body.thinking_level,
        extra_body_json: body.extra_body_json,
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
        secret_ref: c.secret_ref,
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

#[derive(Deserialize)]
struct OpenAiModelsResponse {
    data: Vec<OpenAiModelEntry>,
}

#[derive(Deserialize)]
struct OpenAiModelEntry {
    id: String,
}

async fn refresh_models(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<RefreshedModel>>> {
    let (base_url, secret_ref) = {
        let store = lock_config(&state)?;
        let provider = store.providers().get_provider(&id)?;
        let base_url = provider
            .base_url
            .ok_or_else(|| ApiError::bad_request("provider has no base_url"))?;
        let credential = store.providers().get_credential(&id)?;
        (base_url, credential.secret_ref)
    };

    let api_key = resolve_secret(&secret_ref)?;

    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| ApiError::internal(format!("failed to fetch models: {e}")))?;

    if !response.status().is_success() {
        return Err(ApiError::internal(format!(
            "provider returned {}: {}",
            response.status().as_u16(),
            response.text().await.unwrap_or_default(),
        )));
    }

    let body: OpenAiModelsResponse = response
        .json()
        .await
        .map_err(|e| ApiError::internal(format!("failed to parse models response: {e}")))?;

    let models: Vec<RefreshedModel> = body
        .data
        .into_iter()
        .map(|m| RefreshedModel { id: m.id })
        .collect();

    Ok(Json(models))
}

async fn get_model_info(
    State(state): State<Arc<AppState>>,
    Path((provider_id, model_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let key = format!("{provider_id}/{model_id}");
    let caps = state.model_caps.read().unwrap();
    let info = caps.get(&key).cloned().unwrap_or(Value::Null);
    Ok(Json(info))
}
fn resolve_secret(secret_ref: &str) -> ApiResult<String> {
    let trimmed = secret_ref.trim();
    if trimmed.is_empty() {
        return Err(ApiError::bad_request("secret_ref must not be empty"));
    }
    Ok(trimmed.to_string())
}

