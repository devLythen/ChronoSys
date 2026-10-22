use std::sync::Arc;

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

use crate::error::{ApiError, ApiResult};
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
async fn list_tools(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<ToolInfo>>> {
    let (sandbox_enabled, network_enabled, browser_enabled) = {
        let store = state
            .config
            .lock()
            .map_err(|_| ApiError::internal("config lock poisoned"))?;
        let settings = store.settings();
        let enabled = settings
            .get("sandbox.enabled")
            .ok()
            .flatten()
            .and_then(|setting| setting.value_json.as_bool())
            .unwrap_or(false);
        let network = settings
            .get("sandbox.network")
            .ok()
            .flatten()
            .and_then(|setting| setting.value_json.as_bool())
            .unwrap_or(false);
        let browser = settings
            .get("sandbox.browser")
            .ok()
            .flatten()
            .and_then(|setting| setting.value_json.as_str().map(|value| value == "playwright"))
            .unwrap_or(false);
        (enabled, network, browser)
    };

    Ok(Json(tool_catalog(
        sandbox_enabled,
        network_enabled,
        browser_enabled,
    )))
}

fn tool_catalog(
    sandbox_enabled: bool,
    network_enabled: bool,
    browser_enabled: bool,
) -> Vec<ToolInfo> {
    let mut tools = vec![
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
        ToolInfo {
            name: "sandbox_view_image".into(),
            label: "View sandbox image".into(),
            description: "Read an image from the sandbox workspace and return it as visual content. Supports png, jpeg, webp, and gif up to 6 MiB."
                .into(),
        },
        ToolInfo {
            name: "sandbox_send_file".into(),
            label: "Send sandbox file".into(),
            description: "Send a file from the session sandbox workspace to the current chat. \
                Paths must be inside /workspace."
                .into(),
        },
    ];
    if sandbox_enabled && network_enabled && browser_enabled {
        tools.push(ToolInfo {
            name: "sandbox_browser".into(),
            label: "Browse in sandbox".into(),
            description: "Run a deterministic Playwright action batch: goto, click, fill, wait_for, extract, screenshot, wait. \
                Each call starts a fresh browser; put dependent actions in one batch. \
                Only http(s) URLs are allowed; private/local hosts are blocked. \
                The sandbox image must provide node and Playwright, and sandbox.network must be enabled."
                .into(),
        });
    }
    tools
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_tool_requires_sandbox_network_and_playwright() {
        let base = tool_catalog(true, true, false);
        assert!(!base.iter().any(|tool| tool.name == "sandbox_browser"));
        assert!(!tool_catalog(false, true, true)
            .iter()
            .any(|tool| tool.name == "sandbox_browser"));
        assert!(!tool_catalog(true, false, true)
            .iter()
            .any(|tool| tool.name == "sandbox_browser"));
        assert!(tool_catalog(true, true, true)
            .iter()
            .any(|tool| tool.name == "sandbox_browser"));
    }
}
