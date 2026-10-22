//! HTTP + WebSocket control plane for ChronoSys gateway.

pub mod api;
pub mod auth;
pub mod error;
pub mod state;

pub use state::{AgentControl, AgentQuery, AppState, WsEvent};

use std::sync::Arc;

use axum::http::{header::HeaderValue, Method};
use axum::routing::get;
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

/// Build the full gateway HTTP router (API under `/api/v1` + static WebUI fallback).
pub fn build_router(state: Arc<AppState>) -> Router {
    let api = Router::new()
        .nest("/auth", auth::router())
        .nest("/providers", api::providers::router())
        .nest("/accounts", api::accounts::router())
        .nest("/bots", api::bots::router())
        .nest("/personas", api::personas::router())
        .nest("/bindings", api::bindings::router())
        .nest("/sessions", api::sessions::router())
        .nest("/settings", api::settings::router())
        .nest("/audit", api::audit::router())
        .route("/health", get(api::health::health))
        .nest("/plugins", api::plugins::router())
        .nest("/tools", api::tools::router())
        .route("/ws", get(api::ws::handler));

    let ui_dir = state.webui_dist_path.clone();
    let index = ui_dir.join("index.html");
    let ui = ServeDir::new(ui_dir).fallback(ServeFile::new(index));

    Router::new()
        .nest("/api/v1", api)
        .fallback_service(ui)
        .layer(cors_layer(state.public_url.as_deref()))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ))
        .with_state(state)
}

/// Restrict browser CORS to the configured public origin plus local Vite dev
/// origins. Without `server.public_url`, preserve the permissive behavior.
fn cors_layer(public_url: Option<&str>) -> CorsLayer {
    let Some(raw) = public_url else {
        return CorsLayer::permissive();
    };
    let Ok(url) = url::Url::parse(raw) else {
        return CorsLayer::permissive();
    };
    if !matches!(url.scheme(), "http" | "https") {
        return CorsLayer::permissive();
    }
    let origin = url.origin().ascii_serialization();
    let Ok(origin) = HeaderValue::from_str(&origin) else {
        return CorsLayer::permissive();
    };
    let origins = vec![
        origin,
        HeaderValue::from_static("http://localhost:5173"),
        HeaderValue::from_static("http://127.0.0.1:5173"),
    ];
    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            axum::http::header::AUTHORIZATION,
            axum::http::header::CONTENT_TYPE,
            axum::http::header::ACCEPT,
            axum::http::header::ORIGIN,
        ])
        .allow_credentials(true)
}

