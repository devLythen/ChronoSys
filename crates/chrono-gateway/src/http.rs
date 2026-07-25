use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use chrono_api::{build_router, AgentControl, AppState};
use chrono_config::ConfigStore;
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::sync::mpsc as tokio_mpsc;

use crate::GatewayChild;

/// Resolve bind address and auth for the control plane.
///
/// - Default bind: `127.0.0.1:8787`
/// - Auth token from `CHRONO_AUTH_TOKEN` (optional on loopback)
/// - Non-loopback bind without token → refuse to start
pub fn resolve_bind_and_auth() -> Result<(SocketAddr, Option<String>)> {
    let host = std::env::var("CHRONO_API_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port: u16 = std::env::var("CHRONO_API_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8787);
    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .with_context(|| format!("invalid CHRONO_API_HOST/PORT: {host}:{port}"))?;

    let auth_token = std::env::var("CHRONO_AUTH_TOKEN").ok().filter(|s| !s.is_empty());
    let is_loopback = match addr.ip() {
        std::net::IpAddr::V4(v4) => v4.is_loopback(),
        std::net::IpAddr::V6(v6) => v6.is_loopback(),
    };
    if !is_loopback && auth_token.is_none() {
        bail!(
            "CHRONO_AUTH_TOKEN must be set when binding API to non-localhost address {addr}"
        );
    }
    Ok((addr, auth_token))
}

pub struct HttpServer {
    pub agent_ctrl_rx: tokio_mpsc::UnboundedReceiver<AgentControl>,
    pub agent_alive: Arc<AtomicBool>,
    pub adapter_count: Arc<AtomicUsize>,
}

/// Spawn the axum control-plane server. Returns the agent control receiver
/// for the gateway main loop and shared status flags.
pub async fn start_http_server(
    chrono_home: &std::path::Path,
    config: ConfigStore,
    child: Arc<GatewayChild>,
    pending_queries: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    model_caps: Arc<RwLock<Value>>,
) -> Result<HttpServer> {
    let (addr, auth_token) = resolve_bind_and_auth()?;
    let (agent_tx, agent_ctrl_rx) = tokio_mpsc::unbounded_channel::<AgentControl>();
    let agent_alive = Arc::new(AtomicBool::new(true));
    let adapter_count = Arc::new(AtomicUsize::new(0));

    let webui_dist = std::env::var("CHRONO_WEBUI_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("webui/dist"));
    if !webui_dist.exists() {
        eprintln!(
            "[gateway] webui dist not found at {} — UI routes will 404; API still serves",
            webui_dist.display()
        );
    }

    let state = Arc::new(AppState {
        config: Arc::new(Mutex::new(config)),
        agent_tx,
        chrono_home: chrono_home.to_path_buf(),
        sessions_db_path: chrono_home.join("state/sessions.db"),
        audit_log_path: chrono_home.join("logs/audit.jsonl"),
        auth_token,
        webui_dist_path: webui_dist,
        started_at: Instant::now(),
        adapter_count: adapter_count.clone(),
        agent_alive: agent_alive.clone(),
        child,
        pending_queries,
        model_caps,
    });

    let app = build_router(state);
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("bind control plane on {addr}"))?;
    gateway_log!(info, "control plane listening on http://{addr}");

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("[gateway] http server error: {e:#}");
        }
    });

    Ok(HttpServer {
        agent_ctrl_rx,
        agent_alive,
        adapter_count,
    })
}
