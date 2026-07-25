use std::sync::Arc;

use axum::extract::State;
use axum::http::{header, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::state::AppState;

/// If `auth_token` is set, require `Authorization: Bearer <token>`.
/// Health and static UI still go through this layer; open local-dev skips when token is None.
pub async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let Some(expected) = state.auth_token.as_deref() else {
        return next.run(request).await;
    };

    let path = request.uri().path();
    // Static WebUI and non-API routes stay open; API requires bearer token.
    if !path.starts_with("/api/v1") {
        return next.run(request).await;
    }
    // Allow unauthenticated health checks for liveness probes.
    if path == "/api/v1/health" {
        return next.run(request).await;
    }

    let authorized = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|token| token == expected);

    if !authorized {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthorized" })),
        )
            .into_response();
    }

    next.run(request).await
}
