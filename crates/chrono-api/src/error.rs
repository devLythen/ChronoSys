use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono_config::ConfigError;
use serde_json::json;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
}

impl ApiError {
    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: msg.into(),
        }
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: msg.into(),
        }
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: msg.into(),
        }
    }

    pub fn unauthorized() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: "unauthorized".into(),
        }
    }
}

impl From<ConfigError> for ApiError {
    fn from(err: ConfigError) -> Self {
        match err {
            ConfigError::NotFound { entity, id } => {
                Self::not_found(format!("{entity} '{id}' not found"))
            }
            ConfigError::InvalidState(msg) => Self::bad_request(msg),
            ConfigError::Sqlite(e) => Self::internal(format!("sqlite: {e}")),
        }
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(err: rusqlite::Error) -> Self {
        Self::internal(format!("sqlite: {err}"))
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(err: anyhow::Error) -> Self {
        Self::internal(format!("{err:#}"))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "error": self.message })),
        )
            .into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
