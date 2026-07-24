use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::Value;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/", get(list_audit))
}

#[derive(Deserialize)]
pub struct AuditQuery {
    #[serde(default = "default_limit")]
    pub limit: usize,
    pub account_id: Option<String>,
    pub session_id: Option<String>,
    pub event: Option<String>,
}

fn default_limit() -> usize {
    200
}

async fn list_audit(
    State(state): State<Arc<AppState>>,
    Query(q): Query<AuditQuery>,
) -> ApiResult<Json<Vec<Value>>> {
    let limit = q.limit.clamp(1, 2000);
    let path = &state.audit_log_path;
    if !path.exists() {
        return Ok(Json(vec![]));
    }

    let file = File::open(path).map_err(|e| ApiError::internal(format!("open audit log: {e}")))?;
    let lines = tail_lines(file, limit * 4)?; // oversample then filter

    let mut entries = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(account) = &q.account_id {
            if v.get("account_id").and_then(|x| x.as_str()) != Some(account.as_str()) {
                continue;
            }
        }
        if let Some(session) = &q.session_id {
            let sid = v
                .get("session_id")
                .or_else(|| v.get("session_key"))
                .and_then(|x| x.as_str());
            if sid != Some(session.as_str()) {
                continue;
            }
        }
        if let Some(event) = &q.event {
            if v.get("event").and_then(|x| x.as_str()) != Some(event.as_str()) {
                continue;
            }
        }
        entries.push(v);
        if entries.len() >= limit {
            break;
        }
    }
    // tail_lines returns oldest→newest of the tail window; reverse so newest first
    entries.reverse();
    if entries.len() > limit {
        entries.truncate(limit);
    }
    Ok(Json(entries))
}

/// Read up to `max` non-empty lines from the end of the file (oldest→newest).
fn tail_lines(mut file: File, max: usize) -> ApiResult<Vec<String>> {
    let len = file
        .seek(SeekFrom::End(0))
        .map_err(|e| ApiError::internal(format!("seek audit log: {e}")))?;
    if len == 0 {
        return Ok(vec![]);
    }

    // Read last ~256 KiB (or whole file).
    let window = 256 * 1024u64;
    let start = len.saturating_sub(window);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| ApiError::internal(format!("seek audit log: {e}")))?;

    let reader = BufReader::new(file);
    let mut lines: Vec<String> = reader
        .lines()
        .filter_map(|l| l.ok())
        .filter(|l| !l.trim().is_empty())
        .collect();

    // If we started mid-line, drop the first partial line.
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }

    if lines.len() > max {
        lines = lines.split_off(lines.len() - max);
    }
    Ok(lines)
}
