use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use anyhow::Result;
use chrono_config::ConfigStore;
use serde_json::Value;
use tokio::sync::mpsc as tokio_mpsc;
use tokio::sync::oneshot;

/// Messages the API can send to the agent-host control loop.
#[derive(Debug, Clone)]
pub enum AgentControl {
    Steer { session_id: String, text: String },
    Abort { session_id: String },
    ReloadConfig,
}

/// Abstraction over IPC to the agent-host process for synchronous queries.
pub trait AgentQuery: Send + Sync {
    fn write_frame(&self, payload: &[u8]) -> anyhow::Result<()>;
}

pub struct AppState {
    pub config: Arc<Mutex<ConfigStore>>,
    pub agent_tx: tokio_mpsc::UnboundedSender<AgentControl>,
    pub chrono_home: PathBuf,
    pub sessions_db_path: PathBuf,
    pub audit_log_path: PathBuf,
    pub auth_token: Option<String>,
    pub webui_dist_path: PathBuf,
    pub started_at: Instant,
    /// Live platform adapters currently polling (updated by gateway sync).
    pub adapter_count: Arc<AtomicUsize>,
    pub agent_alive: Arc<AtomicBool>,
    pub child: Arc<dyn AgentQuery>,
    pub pending_queries: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    /// In-memory cache of model capabilities, keyed by "provider_id/model_id".
    pub model_caps: Arc<RwLock<Value>>,
}

impl AppState {
    pub fn notify_reload(&self) {
        let _ = self.agent_tx.send(AgentControl::ReloadConfig);
    }

    /// Send a query to agent-host via IPC and wait for the response.
    pub async fn query_agent(&self, msg: &Value) -> Result<Value> {
        let query_id = uuid::Uuid::new_v4().to_string();
        let mut msg = msg.clone();
        if let Value::Object(ref mut map) = msg {
            map.insert("query_id".to_string(), Value::String(query_id.clone()));
        }
        let (tx, rx) = oneshot::channel();
        self.pending_queries.lock().unwrap().insert(query_id, tx);
        self.child.write_frame(&serde_json::to_vec(&msg)?)?;
        tokio::time::timeout(Duration::from_secs(5), rx)
            .await
            .map_err(|_| anyhow::anyhow!("query timeout"))?
            .map_err(|_| anyhow::anyhow!("agent-host dropped response"))
    }
}
