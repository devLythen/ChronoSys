//! HTTP + WebSocket control plane for ChronoSys gateway.

pub mod api;
pub mod auth;
pub mod error;
pub mod state;

pub use state::{AgentControl, AgentQuery, AppState};

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

/// Build the full gateway HTTP router (API under `/api/v1` + static WebUI fallback).
pub fn build_router(state: Arc<AppState>) -> Router {
    let api = Router::new()
        .nest("/providers", api::providers::router())
        .nest("/accounts", api::accounts::router())
        .nest("/bots", api::bots::router())
        .nest("/personas", api::personas::router())
        .nest("/bindings", api::bindings::router())
        .nest("/sessions", api::sessions::router())
        .nest("/settings", api::settings::router())
        .nest("/audit", api::audit::router())
        .route("/health", get(api::health::health))
        .nest("/tools", api::tools::router())
        .route("/ws", get(api::ws::handler))
        .route("/internal/model-capabilities", post(update_model_caps));

    let ui_dir = state.webui_dist_path.clone();
    let index = ui_dir.join("index.html");
    let ui = ServeDir::new(ui_dir).fallback(ServeFile::new(index));

    Router::new()
        .nest("/api/v1", api)
        .fallback_service(ui)
        .layer(CorsLayer::permissive())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ))
        .with_state(state)
}

/// Accept model capabilities pushed by agent-host on startup and config reload.
async fn update_model_caps(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    if let Some(models) = body.get("models").cloned() {
        *state.model_caps.write().unwrap() = models;
    }
    Ok(Json(json!({"ok": true})))
}
