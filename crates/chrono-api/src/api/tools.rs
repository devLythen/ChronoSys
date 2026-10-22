use std::sync::Arc;

use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

use crate::error::ApiResult;
use crate::state::AppState;

/// Tool descriptor returned by the /tools endpoint.
/// Mirrors the tool registry in agent-host/src/tools.ts.
#[derive(Serialize)]
pub struct ToolInfo {
    pub name: String,
    pub label: String,
    pub description: String,
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/", get(list_tools))
}

/// Return the list of known platform tools that agent-host can register.
/// This is the canonical tool catalog — keep in sync with agent-host/src/tools.ts.
async fn list_tools() -> ApiResult<Json<Vec<ToolInfo>>> {
    Ok(Json(vec![
        ToolInfo {
            name: "message_send".into(),
            label: "Send / forward message".into(),
            description: "Preferred tool to send or forward a text message. \
                Omit chat_id to send to the current conversation; \
                set chat_id to deliver to another chat. \
                Use this for all intentional outbound messages. \
                Plain assistant body text (without this tool) can only reach the current chat as a fallback."
                .into(),
        },
        ToolInfo {
            name: "get_time".into(),
            label: "Get current time".into(),
            description: "Return the current date and time in the bot's configured timezone. \
                Use this instead of guessing when you need to know the local time."
                .into(),
        },
        ToolInfo {
            name: "sandbox_exec".into(),
            label: "Run command in sandbox".into(),
            description: "Run a shell command in the session's isolated Docker workspace. \
                Working directory is /workspace; network access is disabled unless the \
                operator enables it. Returns exit_code, stdout, stderr, and truncated."
                .into(),
        },
    ]))
}
