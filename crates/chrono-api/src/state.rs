use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use chrono_config::ConfigStore;
use tokio::sync::mpsc;

/// Messages the API can send to the agent-host control loop.
#[derive(Debug, Clone)]
pub enum AgentControl {
    Steer { session_id: String, text: String },
    Abort { session_id: String },
    ReloadConfig,
}

/// Shared application state for the control-plane HTTP server.
pub struct AppState {
    pub config: Arc<Mutex<ConfigStore>>,
    pub agent_tx: mpsc::UnboundedSender<AgentControl>,
    pub sessions_db_path: PathBuf,
    pub audit_log_path: PathBuf,
    pub auth_token: Option<String>,
    pub webui_dist_path: PathBuf,
    pub started_at: Instant,
    /// Live platform adapters currently polling (updated by gateway sync).
    pub adapter_count: Arc<AtomicUsize>,
    pub agent_alive: Arc<AtomicBool>,
}

impl AppState {
    pub fn notify_reload(&self) {
        let _ = self.agent_tx.send(AgentControl::ReloadConfig);
    }
}
