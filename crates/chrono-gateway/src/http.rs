use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{Context, Result};
use chrono_api::{build_router, AgentControl, AppState};
use chrono_config::ConfigStore;
use parking_lot::Mutex as ParkingMutex;
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::sync::broadcast;
use tokio::sync::mpsc as tokio_mpsc;

use crate::GatewayChild;

/// Startup options for the control plane. CLI values take precedence over the
/// existing environment fallbacks.
#[derive(Clone, Debug, Default)]
pub struct HttpOptions {
    pub bind: Option<SocketAddr>,
    pub webui_dist: Option<PathBuf>,
}

/// Resolve the control-plane bind address. `--host` overrides the
/// `CHRONO_API_HOST` / `CHRONO_API_PORT` fallbacks.
pub fn resolve_bind(options: &HttpOptions) -> Result<SocketAddr> {
    match options.bind {
        Some(addr) => Ok(addr),
        None => {
            let host = std::env::var("CHRONO_API_HOST").unwrap_or_else(|_| "127.0.0.1".into());
            let port: u16 = std::env::var("CHRONO_API_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(8787);
            format!("{host}:{port}")
                .parse()
                .with_context(|| format!("invalid CHRONO_API_HOST/PORT: {host}:{port}"))
        }
    }
}

pub struct HttpServer {
    pub agent_ctrl_rx: tokio_mpsc::UnboundedReceiver<AgentControl>,
    pub agent_alive: Arc<AtomicBool>,
    pub adapter_count: Arc<AtomicUsize>,
    pub ws_events: broadcast::Sender<chrono_api::WsEvent>,
}

/// Spawn the axum control-plane server. Returns the agent control receiver
/// for the gateway main loop and shared status flags.
pub async fn start_http_server(
    chrono_home: &std::path::Path,
    config: ConfigStore,
    child: Arc<GatewayChild>,
    pending_queries: Arc<ParkingMutex<HashMap<String, oneshot::Sender<Value>>>>,
    options: HttpOptions,
) -> Result<HttpServer> {
    let addr = resolve_bind(&options)?;
    let (agent_tx, agent_ctrl_rx) = tokio_mpsc::unbounded_channel::<AgentControl>();
    let agent_alive = Arc::new(AtomicBool::new(true));
    let adapter_count = Arc::new(AtomicUsize::new(0));
    let (ws_events, _) = broadcast::channel(256);

    let public_url = config
        .settings()
        .get("server.public_url")
        .ok()
        .flatten()
        .and_then(|setting| setting.value_json.as_str().map(str::trim).filter(|url| !url.is_empty()).map(ToOwned::to_owned));
    let webui_url = webui_hint(addr, public_url.as_deref());
    let webui_dist = options
        .webui_dist
        .or_else(|| std::env::var("CHRONO_WEBUI_DIST").ok().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("webui/dist"));
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
        auth_sessions: chrono_api::state::SessionStore::default(),
        webui_dist_path: webui_dist,
        public_url,
        started_at: Instant::now(),
        adapter_count: adapter_count.clone(),
        agent_alive: agent_alive.clone(),
        child,
        pending_queries,
        ws_events: ws_events.clone(),
    });

    let app = build_router(state);
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("bind control plane on {addr}"))?;
    gateway_log!(
        info,
        "control plane listening on http://{addr}; WebUI {webui_url}"
    );

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("[gateway] http server error: {e:#}");
        }
    });

    Ok(HttpServer {
        agent_ctrl_rx,
        agent_alive,
        adapter_count,
        ws_events,
    })
}

/// User-facing WebUI URL for the startup banner. Wildcard binds are shown as
/// loopback; `server.public_url` overrides the display address.
fn webui_hint(addr: SocketAddr, public_url: Option<&str>) -> String {
    if let Some(url) = public_url {
        return url.to_string();
    }
    let display_ip = if addr.ip().is_unspecified() {
        match addr.ip() {
            std::net::IpAddr::V4(_) => std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
            std::net::IpAddr::V6(_) => std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST),
        }
    } else {
        addr.ip()
    };
    format!("http://{}", SocketAddr::new(display_ip, addr.port()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webui_hint_rewrites_wildcard_addresses() {
        assert_eq!(
            webui_hint("0.0.0.0:9000".parse().unwrap(), None),
            "http://127.0.0.1:9000"
        );
        assert_eq!(
            webui_hint("[::]:9000".parse().unwrap(), None),
            "http://[::1]:9000"
        );
        assert_eq!(
            webui_hint(
                "0.0.0.0:9000".parse().unwrap(),
                Some("https://chrono.example.com")
            ),
            "https://chrono.example.com"
        );
    }
}
