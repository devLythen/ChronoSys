use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::Json;
use serde::Serialize;

use crate::error::ApiResult;
use crate::state::AppState;

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub uptime_secs: u64,
    pub agent_host: &'static str,
    pub adapter_count: usize,
    pub session_count: usize,
    pub account_count: usize,
    pub bot_count: usize,
}

pub async fn health(State(state): State<Arc<AppState>>) -> ApiResult<Json<HealthResponse>> {
    let uptime = state.started_at.elapsed();
    let agent_host = if state.agent_alive.load(Ordering::Relaxed) {
        "alive"
    } else {
        "dead"
    };

    let (account_count, bot_count) = {
        let store = state.config.lock().map_err(|_| {
            crate::error::ApiError::internal("config lock poisoned")
        })?;
        let accounts = store.accounts().list_accounts().map(|v| v.len()).unwrap_or(0);
        let bots = store.bots().list_bots().map(|v| v.len()).unwrap_or(0);
        (accounts, bots)
    };

    let session_count = count_active_sessions(&state.sessions_db_path).unwrap_or(0);

    Ok(Json(HealthResponse {
        status: "ok",
        uptime_secs: duration_secs(uptime),
        agent_host,
        adapter_count: state.adapter_count.load(Ordering::Relaxed),
        session_count,
        account_count,
        bot_count,
    }))
}

fn duration_secs(d: Duration) -> u64 {
    d.as_secs()
}

fn count_active_sessions(path: &std::path::Path) -> Result<usize, rusqlite::Error> {
    if !path.exists() {
        return Ok(0);
    }
    let conn = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let has_active = conn
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='active_sessions'")
        .and_then(|mut s| s.exists([]))
        .unwrap_or(false);
    if has_active {
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM active_sessions", [], |r| r.get(0))
            .unwrap_or(0);
        return Ok(count as usize);
    }
    let has_conv = conn
        .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_sessions'",
        )
        .and_then(|mut s| s.exists([]))
        .unwrap_or(false);
    if !has_conv {
        return Ok(0);
    }
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM conversation_sessions", [], |r| r.get(0))
        .unwrap_or(0);
    Ok(count as usize)
}
