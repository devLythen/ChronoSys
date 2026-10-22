use std::sync::Arc;
use std::time::Duration;

use argon2::password_hash::{rand_core::OsRng, PasswordHash, SaltString};
use argon2::{Argon2, PasswordHasher, PasswordVerifier};
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::error::{ApiError, ApiResult};
use crate::state::{AppState, AuthSession};

const COOKIE_NAME: &str = "chrono_session";
const SESSION_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const MIN_PASSWORD_CHARS: usize = 8;
const MAX_PASSWORD_BYTES: usize = 256;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/status", get(status))
        .route("/setup", post(setup))
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/password", post(change_password))
}

#[derive(Serialize)]
struct AuthStatus {
    configured: bool,
    authenticated: bool,
    username: Option<String>,
}

#[derive(Deserialize)]
struct CredentialsBody {
    username: String,
    password: String,
}

#[derive(Deserialize)]
struct PasswordBody {
    current_password: String,
    new_password: String,
}

/// Public auth endpoints + health. Everything else under `/api/v1` requires a
/// valid session once onboarding has completed.
fn is_public_path(path: &str) -> bool {
    matches!(
        path,
        "/api/v1/health"
            | "/api/v1/auth/status"
            | "/api/v1/auth/setup"
            | "/api/v1/auth/login"
            | "/api/v1/auth/logout"
    )
}

pub async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    // CORS preflight requests never carry cookies.
    if request.method() == axum::http::Method::OPTIONS {
        return next.run(request).await;
    }

    let path = request.uri().path();
    if !path.starts_with("/api/v1") || is_public_path(path) {
        return next.run(request).await;
    }

    let configured = match admin_configured(&state) {
        Ok(configured) => configured,
        Err(error) => return error.into_response(),
    };
    if !configured {
        return (
            StatusCode::PRECONDITION_REQUIRED,
            Json(json!({ "error": "setup_required" })),
        )
            .into_response();
    }

    if current_session(&state, request.headers()).is_none() {
        return ApiError::unauthorized().into_response();
    }

    next.run(request).await
}

async fn status(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult<Json<AuthStatus>> {
    let configured = admin_configured(&state)?;
    let session = if configured {
        current_session(&state, &headers)
    } else {
        None
    };
    Ok(Json(AuthStatus {
        configured,
        authenticated: session.is_some(),
        username: session.map(|session| session.username),
    }))
}

async fn setup(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<CredentialsBody>,
) -> ApiResult<Response> {
    if admin_configured(&state)? {
        return Ok(error_response(StatusCode::CONFLICT, "already_configured"));
    }
    let username = validate_username(&body.username)?;
    validate_password(&body.password)?;
    let password_hash = hash_password(&body.password)?;

    // Hash outside the config lock; re-check to close the concurrent setup race.
    let inserted = {
        let store = lock_config(&state)?;
        if store.admin_credentials()?.is_some() {
            false
        } else {
            store.set_admin_credentials(&username, &password_hash)?;
            true
        }
    };
    if !inserted {
        return Ok(error_response(StatusCode::CONFLICT, "already_configured"));
    }

    let session = state.auth_sessions.create(&username, SESSION_TTL);
    Ok(auth_response(session, username, secure_cookie(&state, &headers)))
}

async fn login(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<CredentialsBody>,
) -> ApiResult<Response> {
    let credentials = {
        let store = lock_config(&state)?;
        store.admin_credentials()?
    };
    let Some(credentials) = credentials else {
        return Ok(error_response(StatusCode::PRECONDITION_REQUIRED, "setup_required"));
    };
    let username = body.username.trim();
    let valid = username == credentials.username && verify_password(&credentials.password_hash, &body.password);
    if !valid {
        tokio::time::sleep(Duration::from_millis(250)).await;
        return Err(ApiError::unauthorized());
    }

    let session = state
        .auth_sessions
        .create(&credentials.username, SESSION_TTL);
    Ok(auth_response(
        session,
        credentials.username,
        secure_cookie(&state, &headers),
    ))
}

async fn logout(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(session) = cookie_value(&headers) {
        state.auth_sessions.remove(&session);
    }
    let mut response = Json(json!({ "ok": true })).into_response();
    let secure = if secure_cookie(&state, &headers) { "; Secure" } else { "" };
    if let Ok(cookie) = HeaderValue::from_str(&format!(
        "{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{secure}"
    )) {
        response.headers_mut().insert(header::SET_COOKIE, cookie);
    }
    Ok(response)
}

async fn change_password(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<PasswordBody>,
) -> ApiResult<Response> {
    if current_session(&state, &headers).is_none() {
        return Err(ApiError::unauthorized());
    }
    let credentials = {
        let store = lock_config(&state)?;
        store.admin_credentials()?
    }
    .ok_or_else(|| ApiError {
        status: StatusCode::PRECONDITION_REQUIRED,
        message: "setup_required".into(),
    })?;

    if !verify_password(&credentials.password_hash, &body.current_password) {
        return Err(ApiError::unauthorized());
    }
    validate_password(&body.new_password)?;
    let password_hash = hash_password(&body.new_password)?;
    {
        let store = lock_config(&state)?;
        store.set_admin_credentials(&credentials.username, &password_hash)?;
    }
    state.auth_sessions.remove_all();
    let updated = state
        .auth_sessions
        .create(&credentials.username, SESSION_TTL);
    Ok(auth_response(
        updated,
        credentials.username,
        secure_cookie(&state, &headers),
    ))
}

fn admin_configured(state: &AppState) -> ApiResult<bool> {
    let store = lock_config(state)?;
    Ok(store.admin_credentials()?.is_some())
}

fn current_session(state: &AppState, headers: &HeaderMap) -> Option<AuthSession> {
    let id = cookie_value(headers)?;
    state.auth_sessions.get(&id)
}

fn cookie_value(headers: &HeaderMap) -> Option<String> {
    let cookie = headers.get(header::COOKIE)?.to_str().ok()?;
    cookie.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        (key == COOKIE_NAME && !value.is_empty()).then(|| value.to_string())
    })
}

fn auth_response(session: String, username: String, secure: bool) -> Response {
    let mut response = Json(AuthStatus {
        configured: true,
        authenticated: true,
        username: Some(username),
    })
    .into_response();
    let cookie = format!(
        "{COOKIE_NAME}={session}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}{}",
        SESSION_TTL.as_secs(),
        if secure { "; Secure" } else { "" }
    );
    if let Ok(cookie) = HeaderValue::from_str(&cookie) {
        response.headers_mut().insert(header::SET_COOKIE, cookie);
    }
    response
}

fn secure_cookie(state: &AppState, headers: &HeaderMap) -> bool {
    if headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(',')
                .next()
                .is_some_and(|proto| proto.trim().eq_ignore_ascii_case("https"))
        })
    {
        return true;
    }
    // Direct reverse-proxy requests usually carry the public Host. Do not set
    // Secure when the operator is testing through localhost over HTTP.
    let Some(public_url) = state.public_url.as_deref() else {
        return false;
    };
    let Ok(public) = url::Url::parse(public_url) else {
        return false;
    };
    let Some(public_host) = public.host_str() else {
        return false;
    };
    let Some(request_host) = headers.get(header::HOST).and_then(|value| value.to_str().ok()) else {
        return false;
    };
    let request_host = request_host
        .split(':')
        .next()
        .unwrap_or(request_host)
        .trim_matches(['[', ']']);
    public.scheme() == "https" && request_host.eq_ignore_ascii_case(public_host)
}

fn error_response(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

fn lock_config(state: &AppState) -> ApiResult<std::sync::MutexGuard<'_, chrono_config::ConfigStore>> {
    state
        .config
        .lock()
        .map_err(|_| ApiError::internal("config lock poisoned"))
}

fn validate_username(raw: &str) -> ApiResult<String> {
    let username = raw.trim();
    if username.is_empty() {
        return Err(ApiError::bad_request("username is required"));
    }
    if username.chars().count() > 64 {
        return Err(ApiError::bad_request("username must be <= 64 characters"));
    }
    Ok(username.to_string())
}

fn validate_password(password: &str) -> ApiResult<()> {
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(ApiError::bad_request(format!(
            "password must be at least {MIN_PASSWORD_CHARS} characters"
        )));
    }
    if password.len() > MAX_PASSWORD_BYTES {
        return Err(ApiError::bad_request("password is too long"));
    }
    Ok(())
}

fn hash_password(password: &str) -> ApiResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| ApiError::internal(format!("password hash failed: {error}")))
}

fn verify_password(hash: &str, password: &str) -> bool {
    PasswordHash::new(hash)
        .ok()
        .and_then(|parsed| {
            Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .ok()
        })
        .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_hash_roundtrip() {
        let hash = hash_password("correct horse battery").unwrap();
        assert!(verify_password(&hash, "correct horse battery"));
        assert!(!verify_password(&hash, "wrong password"));
        assert!(hash.starts_with("$argon2"));
    }

    #[test]
    fn password_policy_rejects_short_values() {
        assert!(validate_password("short").is_err());
        assert!(validate_password("long enough").is_ok());
    }
}
