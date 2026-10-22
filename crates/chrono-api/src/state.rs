use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use chrono_config::ConfigStore;
use parking_lot::Mutex as ParkingMutex;
use serde_json::Value;
use tokio::sync::broadcast;
use tokio::sync::mpsc as tokio_mpsc;
use tokio::sync::oneshot;

/// Messages the API can send to the agent-host control loop.
#[derive(Debug, Clone)]
pub enum AgentControl {
    ReloadConfig,
    SandboxReset { session_key: String },
}

/// Abstraction over IPC to the agent-host process for synchronous queries.
pub trait AgentQuery: Send + Sync {
    fn write_frame(&self, payload: &[u8]) -> anyhow::Result<()>;
}

/// A control-plane event delivered to WebSocket subscribers.
#[derive(Debug, Clone)]
pub struct WsEvent {
    pub topics: Vec<String>,
    pub payload: Value,
}

pub struct AppState {
    pub config: Arc<Mutex<ConfigStore>>,
    pub agent_tx: tokio_mpsc::UnboundedSender<AgentControl>,
    pub chrono_home: PathBuf,
    pub sessions_db_path: PathBuf,
    pub audit_log_path: PathBuf,
    pub auth_sessions: SessionStore,
    pub webui_dist_path: PathBuf,
    /// Optional public base URL from `server.public_url`; used for CORS.
    pub public_url: Option<String>,
    pub started_at: Instant,
    /// Live platform adapters currently polling (updated by gateway sync).
    pub adapter_count: Arc<AtomicUsize>,
    pub agent_alive: Arc<AtomicBool>,
    pub child: Arc<dyn AgentQuery>,
    pub pending_queries: Arc<ParkingMutex<HashMap<String, oneshot::Sender<Value>>>>,
    pub ws_events: broadcast::Sender<WsEvent>,
}

#[derive(Clone)]
pub struct AuthSession {
    pub username: String,
    pub expires_at: Instant,
}

/// In-memory WebUI sessions. Restarting the gateway logs everyone out; the
/// admin password hash persists in the config DB.
#[derive(Default)]
pub struct SessionStore {
    inner: Mutex<HashMap<String, AuthSession>>,
}

impl SessionStore {
    pub fn create(&self, username: &str, ttl: Duration) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let mut sessions = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        sessions.insert(
            id.clone(),
            AuthSession {
                username: username.to_string(),
                expires_at: Instant::now() + ttl,
            },
        );
        id
    }

    pub fn get(&self, id: &str) -> Option<AuthSession> {
        let mut sessions = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match sessions.get(id) {
            Some(session) if session.expires_at > Instant::now() => Some(session.clone()),
            Some(_) => {
                sessions.remove(id);
                None
            }
            None => None,
        }
    }

    pub fn remove(&self, id: &str) {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(id);
    }

    pub fn remove_all(&self) {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }
}

impl AppState {
    pub fn notify_reload(&self) {
        let _ = self.agent_tx.send(AgentControl::ReloadConfig);
    }

    /// Publish a best-effort real-time event. Slow or disconnected clients do
    /// not block the gateway event path.
    pub fn publish_ws(&self, topics: Vec<String>, payload: Value) {
        let _ = self.ws_events.send(WsEvent { topics, payload });
    }

    /// Send a query to agent-host via IPC and wait for the response.
    pub async fn query_agent(&self, msg: &Value) -> Result<Value> {
        let query_id = uuid::Uuid::new_v4().to_string();
        let mut msg = msg.clone();
        if let Value::Object(map) = &mut msg {
            map.insert("query_id".to_string(), Value::String(query_id.clone()));
        }
        let (tx, rx) = oneshot::channel();
        self.pending_queries.lock().insert(query_id, tx);
        self.child.write_frame(&serde_json::to_vec(&msg)?)?;
        tokio::time::timeout(Duration::from_secs(5), rx)
            .await
            .map_err(|_| anyhow::anyhow!("query timeout"))?
            .map_err(|_| anyhow::anyhow!("agent-host dropped response"))
    }
}
