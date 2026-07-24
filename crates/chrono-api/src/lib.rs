//! HTTP + WebSocket control plane for ChronoSys gateway.

pub mod api;
pub mod auth;
pub mod error;
pub mod state;

pub use state::{AgentControl, AppState};

use std::sync::Arc;

use axum::routing::get;
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

/// Build the full gateway HTTP router (API under `/api/v1` + static WebUI fallback).
pub fn build_router(state: Arc<AppState>) -> Router {
    let api = Router::new()
        .nest("/providers", api::providers::router())
        .nest("/accounts", api::accounts::router())
        .nest("/bots", api::bots::router())
        .nest("/bindings", api::bindings::router())
        .nest("/sessions", api::sessions::router())
        .nest("/settings", api::settings::router())
        .nest("/audit", api::audit::router())
        .route("/health", get(api::health::health))
        .route("/ws", get(api::ws::handler));

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
