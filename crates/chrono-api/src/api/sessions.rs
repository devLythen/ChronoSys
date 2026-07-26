use std::sync::Arc;

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_sessions))
        .route("/{session_id}", get(get_session))
}

#[derive(Serialize)]
pub struct SessionSummary {
    pub session_id: String,
    pub route_key: String,
    pub session_key: String,
    pub bot_profile_id: String,
    pub updated_at: String,
    pub created_at: String,
    pub message_count: usize,
    pub active: bool,
}

#[derive(Serialize)]
pub struct SessionDetail {
    pub session_id: String,
    pub route_key: String,
    pub session_key: String,
    pub bot_profile_id: String,
    pub messages: Value,
    pub created_at: String,
    pub updated_at: String,
    pub active: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SessionsSchema {
    V2,
    Legacy,
    Empty,
}
fn open_sessions_ro(path: &std::path::Path) -> ApiResult<Connection> {
    if !path.exists() {
        return Err(ApiError::not_found("sessions database not found"));
    }
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(ApiError::from)
}

fn detect_schema(conn: &Connection) -> SessionsSchema {
    let has_active = conn
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='active_sessions'")
        .and_then(|mut s| s.exists([]))
        .unwrap_or(false);
    let has_conv = conn
        .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_sessions'",
        )
        .and_then(|mut s| s.exists([]))
        .unwrap_or(false);
    if !has_conv {
        return SessionsSchema::Empty;
    }
    if has_active {
        return SessionsSchema::V2;
    }
    // Distinguish v2 without active rows vs legacy: check columns.
    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(conversation_sessions)")
        .ok()
        .and_then(|mut stmt| {
            stmt.query_map([], |r| r.get::<_, String>(1))
                .ok()
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();
    if cols.iter().any(|c| c == "session_id") {
        SessionsSchema::V2
    } else if cols.iter().any(|c| c == "logical_key" || c == "generation") {
        SessionsSchema::Legacy
    } else {
        SessionsSchema::Empty
    }
}

fn message_count(messages_json: &str) -> usize {
    serde_json::from_str::<Vec<Value>>(messages_json)
        .map(|v| v.len())
        .unwrap_or(0)
}

async fn list_sessions(State(state): State<Arc<AppState>>) -> ApiResult<Json<Vec<SessionSummary>>> {
    let path = state.sessions_db_path.clone();
    if !path.exists() {
        return Ok(Json(vec![]));
    }
    let conn = open_sessions_ro(&path)?;
    match detect_schema(&conn) {
        SessionsSchema::Empty => Ok(Json(vec![])),
        SessionsSchema::V2 => list_sessions_v2(&conn),
        SessionsSchema::Legacy => list_sessions_legacy(&conn),
    }
}

fn list_sessions_v2(conn: &Connection) -> ApiResult<Json<Vec<SessionSummary>>> {
    let mut out = Vec::new();

    // Prefer active sessions when the table exists.
    let has_active = conn
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='active_sessions'")
        .and_then(|mut s| s.exists([]))
        .unwrap_or(false);

    if has_active {
        let mut stmt = conn.prepare(
            "SELECT a.session_id, c.route_key, c.session_key, c.bot_profile_id,
                    c.updated_at, c.created_at, c.messages_json
             FROM active_sessions a
             JOIN conversation_sessions c ON c.session_id = a.session_id
             ORDER BY c.updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let messages_json: String = row.get(6)?;
            Ok(SessionSummary {
                session_id: row.get(0)?,
                route_key: row.get(1)?,
                session_key: row.get(2)?,
                bot_profile_id: row.get(3)?,
                updated_at: row.get(4)?,
                created_at: row.get(5)?,
                message_count: message_count(&messages_json),
                active: true,
            })
        })?;
        for r in rows {
            out.push(r?);
        }
        if !out.is_empty() {
            return Ok(Json(out));
        }
    }

    // Fall back to all conversation sessions.
    let mut stmt = conn.prepare(
        "SELECT session_id, route_key, session_key, bot_profile_id,
                updated_at, created_at, messages_json
         FROM conversation_sessions
         ORDER BY updated_at DESC
         LIMIT 200",
    )?;
    let rows = stmt.query_map([], |row| {
        let messages_json: String = row.get(6)?;
        Ok(SessionSummary {
            session_id: row.get(0)?,
            route_key: row.get(1)?,
            session_key: row.get(2)?,
            bot_profile_id: row.get(3)?,
            updated_at: row.get(4)?,
            created_at: row.get(5)?,
            message_count: message_count(&messages_json),
            active: false,
        })
    })?;
    for r in rows {
        out.push(r?);
    }
    Ok(Json(out))
}

fn list_sessions_legacy(conn: &Connection) -> ApiResult<Json<Vec<SessionSummary>>> {
    let mut out = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT logical_key, session_key, bot_profile_id, generation,
                updated_at, created_at, messages_json
         FROM conversation_sessions
         ORDER BY updated_at DESC
         LIMIT 200",
    )?;
    let rows = stmt.query_map([], |row| {
        let logical_key: String = row.get(0)?;
        let generation: i64 = row.get(3)?;
        let messages_json: String = row.get(6)?;
        // Synthesize a stable id for legacy rows so detail URLs work.
        let session_id = format!("{logical_key}#{generation}");
        Ok(SessionSummary {
            session_id,
            route_key: logical_key,
            session_key: row.get(1)?,
            bot_profile_id: row.get(2)?,
            updated_at: row.get(4)?,
            created_at: row.get(5)?,
            message_count: message_count(&messages_json),
            active: true,
        })
    })?;
    for r in rows {
        out.push(r?);
    }
    Ok(Json(out))
}

async fn get_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> ApiResult<Json<SessionDetail>> {
    let conn = open_sessions_ro(&state.sessions_db_path)?;
    match detect_schema(&conn) {
        SessionsSchema::Empty => Err(ApiError::not_found(format!(
            "session '{session_id}' not found"
        ))),
        SessionsSchema::V2 => get_session_v2(&conn, &session_id),
        SessionsSchema::Legacy => get_session_legacy(&conn, &session_id),
    }
}

fn get_session_v2(conn: &Connection, session_id: &str) -> ApiResult<Json<SessionDetail>> {
    let row = conn
        .query_row(
            "SELECT session_id, route_key, session_key, bot_profile_id,
                    messages_json, created_at, updated_at
             FROM conversation_sessions WHERE session_id=?1",
            params![session_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                ApiError::not_found(format!("session '{session_id}' not found"))
            }
            other => ApiError::from(other),
        })?;

    let (session_id, route_key, session_key, bot_profile_id, messages_json, created_at, updated_at) =
        row;
    let messages: Value = serde_json::from_str(&messages_json).unwrap_or_else(|_| json!([]));
    let active: bool = conn
        .query_row(
            "SELECT 1 FROM active_sessions WHERE session_id=?1",
            params![&session_id],
            |_| Ok(true),
        )
        .unwrap_or(false);

    Ok(Json(SessionDetail {
        session_id,
        route_key,
        session_key,
        bot_profile_id,
        messages,
        created_at,
        updated_at,
        active,
    }))
}

fn get_session_legacy(conn: &Connection, session_id: &str) -> ApiResult<Json<SessionDetail>> {
    // Accept either raw logical_key or "logical_key#generation".
    let (logical_key, generation) = if let Some((lk, gen)) = session_id.rsplit_once('#') {
        if let Ok(g) = gen.parse::<i64>() {
            (lk.to_string(), Some(g))
        } else {
            (session_id.to_string(), None)
        }
    } else {
        (session_id.to_string(), None)
    };

    let row = if let Some(gen) = generation {
        conn.query_row(
            "SELECT logical_key, session_key, bot_profile_id, generation,
                    messages_json, created_at, updated_at
             FROM conversation_sessions WHERE logical_key=?1 AND generation=?2",
            params![logical_key, gen],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            },
        )
    } else {
        conn.query_row(
            "SELECT logical_key, session_key, bot_profile_id, generation,
                    messages_json, created_at, updated_at
             FROM conversation_sessions WHERE logical_key=?1
             ORDER BY generation DESC LIMIT 1",
            params![logical_key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            },
        )
    }
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => {
            ApiError::not_found(format!("session '{session_id}' not found"))
        }
        other => ApiError::from(other),
    })?;

    let (logical_key, session_key, bot_profile_id, generation, messages_json, created_at, updated_at) =
        row;
    let messages: Value = serde_json::from_str(&messages_json).unwrap_or_else(|_| json!([]));
    let sid = format!("{logical_key}#{generation}");

    Ok(Json(SessionDetail {
        session_id: sid,
        route_key: logical_key,
        session_key,
        bot_profile_id,
        messages,
        created_at,
        updated_at,
        active: true,
    }))
}
