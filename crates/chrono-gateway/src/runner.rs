use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use chrono_api::AgentControl;
use chrono_config::{Binding, BotProfile, ConfigStore, PlatformAccount};
use chrono_ipc::adapter::{PlatformAdapter, RoutedEvent};
use chrono_ipc::{ChronoEvent, ToolIpcMessage};
use chrono_sandbox::SandboxManager;
use parking_lot::Mutex as ParkingMutex;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::adapters::build_adapter;
use crate::http;
use crate::sandbox_tool::{load_sandbox_config, SandboxToolBackend};
use crate::tool_router::{PlatformBackend, ToolBackend, ToolContext, ToolRouter};
use crate::GatewayChild;

// ── audit ─────────────────────────────────────────────────────────

pub struct AuditLog {
    file: Option<std::fs::File>,
}

impl AuditLog {
    pub fn open(chrono_home: &Path) -> Result<Self> {
        let dir = chrono_home.join("logs");
        fs::create_dir_all(&dir).context("create logs dir")?;
        let path = dir.join("audit.jsonl");
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .context("open audit log")?;
        Ok(Self { file: Some(file) })
    }

    pub fn write(&mut self, entry: &Value) {
        if let Some(ref mut f) = self.file {
            let line = serde_json::to_string(entry).unwrap_or_default();
            let _ = writeln!(f, "{line}");
            let _ = f.sync_all();
        }
    }
}

// ── rate limiter ──────────────────────────────────────────────────

struct RateLimiter {
    buckets: HashMap<String, (Instant, u32)>,
}

impl RateLimiter {
    fn new() -> Self {
        Self {
            buckets: HashMap::new(),
        }
    }

    fn check(&mut self, account_id: &str, max_rpm: u32) -> bool {
        let now = Instant::now();
        let entry = self
            .buckets
            .entry(account_id.to_string())
            .or_insert_with(|| (now, max_rpm));
        let elapsed_secs = (now - entry.0).as_secs_f64();
        if elapsed_secs >= 60.0 {
            *entry = (now, 1);
            return true;
        }
        let refill = (elapsed_secs / 60.0 * max_rpm as f64) as u32;
        let tokens = (entry.1 + refill).min(max_rpm);
        entry.0 = now;
        if tokens > 0 {
            entry.1 = tokens - 1;
            true
        } else {
            entry.1 = 0;
            false
        }
    }
}

// ── resolved binding ──────────────────────────────────────────────

struct ResolvedBinding {
    #[allow(dead_code)]
    bot_profile_id: String,
    session_mode: String,
    policy_json: Value,
}

/// Fingerprint of adapter-relevant account fields (restart when this changes).
fn account_fingerprint(a: &PlatformAccount) -> String {
    format!(
        "{}|{}|{}|{}",
        a.platform, a.enabled, a.secret_ref, a.adapter_id
    )
}

struct LiveAdapter {
    fingerprint: String,
    adapter: Arc<dyn PlatformAdapter>,
    task: JoinHandle<()>,
}

struct GatewayState {
    child: Arc<GatewayChild>,
    adapters: HashMap<String, LiveAdapter>,
    bindings: HashMap<String, Vec<Binding>>,
    bot_profiles: HashMap<String, BotProfile>,
    audit: AuditLog,
    rate_limiter: RateLimiter,
    sandbox: Arc<SandboxManager>,
}

struct AttachmentJob {
    event: ChronoEvent,
    adapter: Option<Arc<dyn PlatformAdapter>>,
    sandbox: Arc<SandboxManager>,
    child: Arc<dyn chrono_api::AgentQuery>,
    ws_events: tokio::sync::broadcast::Sender<chrono_api::WsEvent>,
    inbox_root: PathBuf,
    account_id: String,
    sandbox_key: String,
    chat_id: String,
    message_id: String,
}

impl GatewayState {
    fn resolve_binding(&self, account_id: &str, event: &ChronoEvent) -> Option<ResolvedBinding> {
        let bindings = self.bindings.get(account_id)?;
        let (chat_id, chat_kind) = match event {
            ChronoEvent::InboundMessage { chat, .. } => (&chat.id, &chat.kind),
        };
        for b in bindings {
            let matches = match b.chat_pattern.as_str() {
                "*" => true,
                "dm:*" => matches!(chat_kind, chrono_ipc::ChatKind::Dm),
                "group:*" => matches!(chat_kind, chrono_ipc::ChatKind::Group),
                pattern if pattern.starts_with("chat:") => &pattern[5..] == chat_id,
                _ => false,
            };
            if matches {
                let policy_json = self
                    .bot_profiles
                    .get(&b.bot_profile_id)
                    .map(|bp| &bp.policy_json)
                    .cloned()
                    .unwrap_or_default();
                return Some(ResolvedBinding {
                    bot_profile_id: b.bot_profile_id.clone(),
                    session_mode: b.session_mode.clone(),
                    policy_json,
                });
            }
        }
        None
    }

    fn is_mentioned(&self, event: &ChronoEvent, bot_username: &str) -> bool {
        match event {
            ChronoEvent::InboundMessage { chat, message, .. } => {
                if matches!(chat.kind, chrono_ipc::ChatKind::Dm) {
                    return true;
                }
                let needle = format!("@{}", bot_username);
                message.text.contains(&needle)
            }
        }
    }
}

// ── tool dispatch ─────────────────────────────────────────────────
//
// Tool calls are dispatched by `crate::tool_router::ToolRouter` in a spawned
// task. Never hold `GatewayState` across an adapter/sandbox await: a slow
// platform or sandbox tool must not stall inbound routing, config reloads, or
// WebSocket delivery.

fn session_context(session_id: &str) -> (&str, &str) {
    let mut parts = session_id.splitn(3, ':');
    let account_id = parts.next().unwrap_or("unknown");
    let chat_id = parts.next().unwrap_or("");
    (account_id, chat_id)
}

async fn dispatch_async(
    router: ToolRouter,
    request: ToolIpcMessage,
    account_id: String,
    chat_id: String,
    session_id: String,
    state: Arc<ParkingMutex<GatewayState>>,
    child: Arc<GatewayChild>,
    ws_events: tokio::sync::broadcast::Sender<chrono_api::WsEvent>,
) {
    let tool_name = match &request {
        ToolIpcMessage::Request { name, .. } => name.clone(),
        ToolIpcMessage::Response { .. } => String::new(),
    };
    let outcome = router
        .execute(
            &request,
            &ToolContext {
                account_id: &account_id,
                chat_id: &chat_id,
                session_key: &session_id,
            },
        )
        .await;

    {
        let mut state = state.lock();
        let detail = match &outcome.response {
            ToolIpcMessage::Response {
                ok: false,
                error: Some(error),
                ..
            } => error.message.clone(),
            _ if outcome.timed_out => "timeout".to_string(),
            _ => "ok".to_string(),
        };
        state.audit.write(&json!({
            "ts": chrono_now(),
            "event": "tool.response",
            "account_id": account_id,
            "session_key": session_id,
            "tool_name": tool_name,
            "backend": outcome.backend,
            "ok": matches!(&outcome.response, ToolIpcMessage::Response { ok: true, .. }),
            "timed_out": outcome.timed_out,
            "elapsed_ms": outcome.elapsed_ms,
            "detail": detail,
        }));
    }

    if let Some(platform) = &outcome.platform {
        let topics = vec![
            format!("sessions:{session_id}"),
            format!("platform:{platform}"),
        ];
        let payload = json!({
            "type": "platform.outbound",
            "platform": platform,
            "account_id": account_id,
            "session_key": session_id,
            "tool": tool_name,
            "response": outcome.response,
        });
        let _ = ws_events.send(chrono_api::WsEvent { topics, payload });
    }

    let body = serde_json::to_vec(&outcome.response).unwrap_or_default();
    if let Err(error) = child.write_frame(&body) {
        eprintln!("[gateway] failed to write tool response: {error}");
    }
}

// ── main gateway loop ─────────────────────────────────────────────

/// Start the gateway control plane.
///
/// Boot does **not** resolve platform secrets. Adapters attach from the config
/// DB (WebUI-managed) and re-sync on every `ReloadConfig`.
pub async fn run_gateway(
    chrono_home: PathBuf,
    bun_path: String,
    agent_host_dir: PathBuf,
    config_store: ConfigStore,
    http_options: http::HttpOptions,
) -> Result<()> {
    let child = GatewayChild::spawn(&bun_path, &agent_host_dir, &chrono_home)
        .context("spawn agent-host")?;
    let child = Arc::new(child);

    let pending_queries = Arc::new(ParkingMutex::new(HashMap::new()));

    // 2. Audit log
    let audit = AuditLog::open(&chrono_home).context("open audit log")?;

    // Sandbox: fail-closed defaults; settings are reloaded on every config sync.
    let sandbox_config = load_sandbox_config(&config_store);
    let sandbox_enabled = sandbox_config.enabled;
    let sandbox = Arc::new(SandboxManager::new(chrono_home.clone(), sandbox_config));
    if sandbox_enabled {
        if let Err(error) = sandbox.cleanup_orphans().await {
            gateway_log!(warn, "sandbox orphan cleanup skipped: {error}");
        }
    }

    let state = Arc::new(ParkingMutex::new(GatewayState {
        child: child.clone(),
        adapters: HashMap::new(),
        bindings: HashMap::new(),
        bot_profiles: HashMap::new(),
        audit,
        rate_limiter: RateLimiter::new(),
        sandbox: sandbox.clone(),
    }));

    // 3. Control plane HTTP (config CRUD from WebUI)
    let http::HttpServer {
        mut agent_ctrl_rx,
        agent_alive,
        adapter_count,
        ws_events,
    } = http::start_http_server(
        &chrono_home,
        config_store,
        child.clone(),
        pending_queries.clone(),
        http_options,
    )
    .await
    .context("start control plane")?;

    // 4. Adapter events → main loop
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<RoutedEvent>();

    // 5. Initial config + adapters from DB (secrets only resolved here)
    if let Err(e) = sync_from_config(&state, &chrono_home, &event_tx, &adapter_count) {
        gateway_log!(warn, "initial config sync: {e:#}");
    }

    let reaper_sandbox = sandbox.clone();
    let reaper_task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            reaper_sandbox.reap_idle().await;
        }
    });

    // 6. stdout reader (tool dispatch)
    let stdout_child = child.clone();
    let stdout_state = state.clone();
    let stdout_pending = pending_queries.clone();
    let stdout_alive = agent_alive.clone();
    let stdout_ws_events = ws_events.clone();
    let stdout_handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || loop {
        let payload = match stdout_child.read_frame() {
            Ok(p) => p,
            Err(e) => {
                gateway_log!(error, "agent stdout read error: {e}");
                stdout_alive.store(false, Ordering::Relaxed);
                break;
            }
        };

        if let Ok(tool_msg) = serde_json::from_slice::<ToolIpcMessage>(&payload) {
            if let ToolIpcMessage::Request { session_id, .. } = &tool_msg {
                let session_id = session_id.clone();
                let (account_id, chat_id) = session_context(&session_id);
                let (adapter, sandbox) = {
                    let state = stdout_state.lock();
                    (
                        state
                            .adapters
                            .get(account_id)
                            .map(|live| live.adapter.clone()),
                        state.sandbox.clone(),
                    )
                };
                let adapter_for_sandbox = adapter.clone();
                let platform = adapter.map(|adapter| {
                    Arc::new(PlatformBackend::new(adapter)) as Arc<dyn ToolBackend>
                });
                let sandbox = Some(Arc::new(SandboxToolBackend::new(
                    sandbox,
                    adapter_for_sandbox,
                )) as Arc<dyn ToolBackend>);
                let router = ToolRouter::new(platform, sandbox);
                stdout_handle.spawn(dispatch_async(
                    router,
                    tool_msg,
                    account_id.to_string(),
                    chat_id.to_string(),
                    session_id,
                    stdout_state.clone(),
                    stdout_child.clone(),
                    stdout_ws_events.clone(),
                ));
            }
            continue;
        }

        if let Ok(obj) = serde_json::from_slice::<Value>(&payload) {
            // Check for pending query responses
            if let Some(query_id) = obj.get("query_id").and_then(|v| v.as_str()) {
                let mut pq = stdout_pending.lock();
                if let Some(tx) = pq.remove(query_id) {
                    let _ = tx.send(obj);
                }
                continue;
            }
        }

        if let Ok(value) = serde_json::from_slice::<Value>(&payload) {
            let msg_type = value
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            match msg_type {
                "done" => {}
                "error" => {
                    let message = value
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    gateway_log!(error, "agent error: {message}");
                }
                "host_command_sync" => {
                    if let Some(commands) = value.get("commands").and_then(|v| v.as_array()) {
                        let commands = commands.clone();
                        let state = stdout_state.lock();
                        let adapters: Vec<_> = state.adapters.values().map(|live| live.adapter.clone()).collect();
                        eprintln!("[gateway] syncing commands to {} adapter(s)", adapters.len());
                        tokio::spawn(async move {
                            for adapter in &adapters { let _ = adapter.sync_commands(&commands).await; }
                        });
                    }
                }
                "sandbox.reset" => {
                    if let Some(session_key) = value.get("session_key").and_then(|v| v.as_str()) {
                        let session_key = session_key.to_string();
                        let sandbox = { stdout_state.lock().sandbox.clone() };
                        if sandbox.config().destroy_on_new {
                            stdout_handle.spawn(async move {
                                if let Err(error) = sandbox.destroy(&session_key).await {
                                    eprintln!(
                                        "[gateway] sandbox reset failed for {session_key}: {error}"
                                    );
                                }
                            });
                        }
                    }
                }
                other => {
                    eprintln!("[gateway] unknown message type from agent-host: {other}");
                }
            }
        }
    });

    // 7. Main loop
    gateway_log!(info, "control plane ready (adapters managed from config DB / WebUI)");
    loop {
        agent_alive.store(child.is_alive(), Ordering::Relaxed);

        tokio::select! {
            routed = event_rx.recv() => {
                match routed {
                    Some(routed) => {
                        if let Err(e) = handle_inbound_event(&state, routed, &ws_events, &chrono_home) {
                            eprintln!("[gateway] inbound handler error: {e:#}");
                        }
                    }
                    None => {
                        eprintln!("[gateway] event channel closed, shutting down");
                        break;
                    }
                }
            }
            ctrl = agent_ctrl_rx.recv() => {
                match ctrl {
                    Some(ctrl) => {
                        if let Err(e) = handle_agent_control(
                            &state,
                            &chrono_home,
                            &event_tx,
                            &adapter_count,
                            ctrl,
                        ) {
                            eprintln!("[gateway] control handler error: {e:#}");
                        }
                    }
                    None => {
                        eprintln!("[gateway] control channel closed");
                    }
                }
            }
        }
    }

    // Stop adapters and sandbox containers on shutdown
    reaper_task.abort();
    sandbox.shutdown().await;
    {
        let mut state = state.lock();
        for (id, live) in state.adapters.drain() {
            live.task.abort();
            eprintln!("[gateway] stopped adapter for account {id}");
        }
    }
    adapter_count.store(0, Ordering::Relaxed);

    Ok(())
}

/// Load bindings/bots and (re)start adapters to match enabled accounts in DB.
fn sync_from_config(
    state: &Arc<ParkingMutex<GatewayState>>,
    chrono_home: &Path,
    event_tx: &mpsc::UnboundedSender<RoutedEvent>,
    adapter_count: &Arc<AtomicUsize>,
) -> Result<()> {
    let db_path = chrono_home.join("state/chrono.db");
    let store = ConfigStore::open(&db_path).context("open config DB for sync")?;
    let sandbox_config = load_sandbox_config(&store);

    let accounts = store
        .accounts()
        .list_enabled_accounts()
        .context("list enabled accounts")?;

    let mut bindings: HashMap<String, Vec<Binding>> = HashMap::new();
    let mut bot_profiles: HashMap<String, BotProfile> = HashMap::new();

    for account in &accounts {
        let list = store
            .bots()
            .list_bindings_for_account(&account.id)
            .context("list bindings")?;
        for b in &list {
            if !bot_profiles.contains_key(&b.bot_profile_id) {
                if let Ok(bp) = store.bots().get_bot(&b.bot_profile_id) {
                    bot_profiles.insert(b.bot_profile_id.clone(), bp);
                }
            }
        }
        bindings.insert(account.id.clone(), list);
    }

    if let Ok(all_bots) = store.bots().list_bots() {
        for bp in all_bots {
            bot_profiles.entry(bp.id.clone()).or_insert(bp);
        }
    }

    let mut desired: HashMap<String, (PlatformAccount, String)> = HashMap::new();
    for a in accounts {
        let fp = account_fingerprint(&a);
        desired.insert(a.id.clone(), (a, fp));
    }

    let mut state = state.lock();
    state.bindings = bindings;
    state.bot_profiles = bot_profiles;
    state.sandbox.update_config(sandbox_config);

    // Stop adapters that are gone or whose fingerprint changed
    let live_ids: Vec<String> = state.adapters.keys().cloned().collect();
    for id in live_ids {
        let should_stop = match desired.get(&id) {
            None => true,
            Some((_, fp)) => state
                .adapters
                .get(&id)
                .map(|live| &live.fingerprint != fp)
                .unwrap_or(true),
        };
        if should_stop {
            if let Some(live) = state.adapters.remove(&id) {
                live.task.abort();
                eprintln!("[gateway] stopped adapter for account {id}");
            }
        }
    }

    // Start missing adapters (secrets resolved only for accounts that need a live adapter)
    let existing: HashSet<String> = state.adapters.keys().cloned().collect();
    for (id, (account, fp)) in desired {
        if existing.contains(&id) {
            continue;
        }
        match build_adapter(&account) {
            Ok(adapter) => {
                let tx = event_tx.clone();
                let account_id = id.clone();
                let adapter_for_task = adapter.clone();
                eprintln!(
                    "[gateway] starting adapter {} for account {}",
                    adapter.id(),
                    account_id
                );
                let task = tokio::spawn(async move {
                    let result = adapter_for_task
                        .start(Box::new(move |mut evt| {
                            evt.account_id = account_id.clone();
                            let _ = tx.send(evt);
                        }))
                        .await;
                    if let Err(e) = result {
                        eprintln!(
                            "[gateway] adapter task ended for {}: {e}",
                            adapter_for_task.account_id()
                        );
                    }
                });
                state.adapters.insert(
                    id,
                    LiveAdapter {
                        fingerprint: fp,
                        adapter,
                        task,
                    },
                );
            }
            Err(e) => {
                eprintln!("[gateway] skip account {}: {e:#}", account.id);
            }
        }
    }

    // Notify agent-host
    let body = json!({ "type": "config.reload" });
    let payload = serde_json::to_vec(&body)?;
    if let Err(e) = state.child.write_frame(&payload) {
        eprintln!("[gateway] failed to notify agent of config reload: {e}");
    }

    let count = state.adapters.len();
    adapter_count.store(count, Ordering::Relaxed);
    state.audit.write(&json!({
        "ts": chrono_now(),
        "event": "config_reloaded",
        "detail": format!("bindings/bots reloaded; {count} live adapter(s)"),
        "adapter_count": count,
    }));
    gateway_log!(info, "config reloaded ({count} live adapter(s))");
    Ok(())
}

fn handle_inbound_event(
    state: &Arc<ParkingMutex<GatewayState>>,
    routed: RoutedEvent,
    ws_events: &tokio::sync::broadcast::Sender<chrono_api::WsEvent>,
    chrono_home: &Path,
) -> Result<()> {
    let mut state = state.lock();

    let resolved = match state.resolve_binding(&routed.account_id, &routed.event) {
        Some(r) => r,
        None => {
            eprintln!(
                "[gateway] dropped (no binding) for account {}",
                routed.account_id
            );
            state.audit.write(&json!({
                "ts": chrono_now(),
                "event": "bind_miss",
                "account_id": routed.account_id,
                "detail": "no matching binding",
            }));
            return Ok(());
        }
    };

    let max_rpm: u32 = 30;
    if !state.rate_limiter.check(&routed.account_id, max_rpm) {
        eprintln!("[gateway] rate-limited account {}", routed.account_id);
        state.audit.write(&json!({
            "ts": chrono_now(),
            "event": "rate_limited",
            "account_id": routed.account_id,
            "detail": "rate limit exceeded",
        }));
        return Ok(());
    }

    if resolved
        .policy_json
        .get("mention_required")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        let bot_username = state
            .adapters
            .get(&routed.account_id)
            .map(|live| live.adapter.bot_username().to_string())
            .unwrap_or_default();
        if !state.is_mentioned(&routed.event, &bot_username) {
            eprintln!(
                "[gateway] dropped (not mentioned) for account {}",
                routed.account_id
            );
            state.audit.write(&json!({
                "ts": chrono_now(),
                "event": "dropped_mention",
                "account_id": routed.account_id,
                "detail": "not mentioned in group message",
            }));
            return Ok(());
        }
    }

    let mut event = routed.event;
    let (has_attachments, chat_id, message_id, sandbox_key) = {
        let ChronoEvent::InboundMessage {
            chat,
            session_key,
            bot_profile_id,
            message,
            ..
        } = &mut event;
        *session_key = chrono_ipc::adapter::session_key(
            &routed.account_id,
            &chat.id,
            &resolved.session_mode,
        );
        *bot_profile_id = Some(resolved.bot_profile_id.clone());
        (
            !message.attachments.is_empty(),
            chat.id.clone(),
            message.id.clone(),
            format!("{session_key}#{}", resolved.bot_profile_id),
        )
    };
    let attachment_job = has_attachments.then(|| AttachmentJob {
        event: event.clone(),
        adapter: state
            .adapters
            .get(&routed.account_id)
            .map(|live| live.adapter.clone()),
        sandbox: state.sandbox.clone(),
        child: state.child.clone(),
        ws_events: ws_events.clone(),
        inbox_root: chrono_home.join("inbox"),
        account_id: routed.account_id.clone(),
        sandbox_key,
        chat_id,
        message_id,
    });

    {
        let ref_event = &event;
        state.audit.write(&json!({
            "ts": chrono_now(),
            "event": "inbound",
            "account_id": routed.account_id,
            "session_key": match ref_event {
                ChronoEvent::InboundMessage { session_key, .. } => session_key,
            },
            "detail": match ref_event {
                ChronoEvent::InboundMessage { message, .. } => &message.text,
            },
        }));
    }

    let platform = match &event {
        ChronoEvent::InboundMessage { platform, .. } => platform.clone(),
    };
    let session_key = match &event {
        ChronoEvent::InboundMessage { session_key, .. } => session_key.clone(),
    };

    if let Some(job) = attachment_job {
        tokio::spawn(ingest_attachments(job));
    } else {
        let payload = json!({
            "type": "platform.inbound",
            "platform": platform.clone(),
            "account_id": routed.account_id,
            "session_key": session_key.clone(),
            "event": event.clone(),
        });
        let _ = ws_events.send(chrono_api::WsEvent {
            topics: vec![format!("sessions:{session_key}"), format!("platform:{platform}")],
            payload,
        });
        let payload = serde_json::to_vec(&event).unwrap_or_default();
        if let Err(e) = state.child.write_frame(&payload) {
            eprintln!("[gateway] failed to write event to agent: {e}");
        }
    }
    Ok(())
}

async fn ingest_attachments(mut job: AttachmentJob) {
    let generation = job.sandbox.generation(&job.sandbox_key);
    let mut updated_attachments = Vec::with_capacity(job.attachments().len());
    let (chat_id, message_id) = (job.chat_id.clone(), job.message_id.clone());
    let attachments_copy = job.attachments().to_vec();

    for attachment in attachments_copy {
        let name = attachment
            .name
            .clone()
            .unwrap_or_else(|| "attachment".to_string());
        let staging = staging_path(
            &job.inbox_root,
            &job.account_id,
            &chat_id,
            &message_id,
            &name,
        );
        if job.sandbox.generation(&job.sandbox_key) != generation {
            updated_attachments.push(chrono_ipc::AttachmentRef {
                id: attachment.id.clone(),
                mime: attachment.mime.clone(),
                name: attachment.name.clone(),
                local_path: None,
                inline_data: None,
            });
            continue;
        }
        let mut error = None;
        let Some(adapter) = &job.adapter else {
            updated_attachments.push(chrono_ipc::AttachmentRef {
                id: attachment.id.clone(),
                mime: attachment.mime.clone(),
                name: attachment.name.clone(),
                local_path: None,
                inline_data: None,
            });
            continue;
        };

        if let Err(import_error) = adapter.download_attachment(&attachment.id, &staging).await {
            error = Some(import_error.to_string());
        }
        let local_path = if error.is_none()
            && job.sandbox.generation(&job.sandbox_key) == generation
        {
            match job
                .sandbox
                .import_file(&job.sandbox_key, &message_id, &name, &staging)
            {
                Ok(path) => Some(path),
                Err(import_error) => {
                    error = Some(import_error.to_string());
                    None
                }
            }
        } else {
            if error.is_none() {
                error = Some("cancelled by session reset".to_string());
            }
            None
        };
        if let Some(message) = &error {
            eprintln!("[gateway] attachment ingest failed ({name}): {message}");
            let _ = std::fs::remove_file(&staging);
        }
        let inline_data = local_path
            .as_deref()
            .filter(|_| {
                is_image_attachment(
                    &attachment.mime,
                    attachment.name.as_deref().unwrap_or(""),
                )
            })
            .and_then(|path| {
                inline_image_data(&job.sandbox, &job.sandbox_key, path)
            });
        updated_attachments.push(chrono_ipc::AttachmentRef {
            id: attachment.id.clone(),
            mime: attachment.mime.clone(),
            name: attachment.name.clone(),
            local_path,
            inline_data,
        });
    }

    if job.sandbox.generation(&job.sandbox_key) != generation {
        eprintln!("[gateway] attachment delivery cancelled by sandbox reset");
        return;
    }

    let (platform, session_key) = match &job.event {
        ChronoEvent::InboundMessage { platform, session_key, .. } => {
            (platform.clone(), session_key.clone())
        }
    };

    let ChronoEvent::InboundMessage { message, .. } = &mut job.event;
    message.attachments = updated_attachments;

    let mut ws_event = job.event.clone();
    let ChronoEvent::InboundMessage { message, .. } = &mut ws_event;
    for attachment in &mut message.attachments {
        attachment.inline_data = None;
    }
    let payload = json!({
        "type": "platform.inbound",
        "platform": platform.clone(),
        "account_id": job.account_id,
        "session_key": session_key.clone(),
        "event": ws_event,
    });
    let _ = job.ws_events.send(chrono_api::WsEvent {
        topics: vec![format!("sessions:{session_key}"), format!("platform:{platform}")],
        payload,
    });

    let payload = serde_json::to_vec(&job.event).unwrap_or_default();
    if let Err(e) = job.child.write_frame(&payload) {
        eprintln!("[gateway] failed to write event to agent: {e}");
    }
}

impl AttachmentJob {
    fn attachments(&self) -> &[chrono_ipc::AttachmentRef] {
        match &self.event {
            ChronoEvent::InboundMessage { message, .. } => &message.attachments,
        }
    }
}

fn is_image_attachment(mime: &str, name: &str) -> bool {
    let mime = mime.to_ascii_lowercase();
    if matches!(
        mime.as_str(),
        "image/png" | "image/jpeg" | "image/jpg" | "image/webp" | "image/gif"
    ) {
        return true;
    }
    let lower = name.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".webp", ".gif"]
        .iter()
        .any(|extension| lower.ends_with(extension))
}

fn inline_image_data(
    sandbox: &SandboxManager,
    sandbox_key: &str,
    path: &str,
) -> Option<String> {
    use base64::Engine;
    let host = sandbox.resolve_file(sandbox_key, path).ok()?;
    let metadata = std::fs::metadata(&host).ok()?;
    if metadata.len() > chrono_sandbox::MAX_IMAGE_BYTES {
        eprintln!(
            "[gateway] image {} exceeds inline limit ({} bytes)",
            path,
            metadata.len()
        );
        return None;
    }
    let bytes = std::fs::read(host).ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn staging_path(
    root: &Path,
    account_id: &str,
    chat_id: &str,
    message_id: &str,
    name: &str,
) -> PathBuf {
    root.join(safe_component(account_id))
        .join(safe_component(chat_id))
        .join(safe_component(message_id))
        .join(safe_filename(name))
}

fn safe_component(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len().min(64));
    for character in raw.chars().take(64) {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            out.push(character);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('.');
    if trimmed.is_empty() {
        "item".to_string()
    } else {
        trimmed.to_string()
    }
}

fn safe_filename(raw: &str) -> String {
    let name = Path::new(raw)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment");
    let sanitized = safe_component(name);
    if sanitized.len() > 120 {
        sanitized[..120].to_string()
    } else {
        sanitized
    }
}

fn handle_agent_control(
    state: &Arc<ParkingMutex<GatewayState>>,
    chrono_home: &Path,
    event_tx: &mpsc::UnboundedSender<RoutedEvent>,
    adapter_count: &Arc<AtomicUsize>,
    ctrl: AgentControl,
) -> Result<()> {
    match ctrl {
        AgentControl::ReloadConfig => {
            sync_from_config(state, chrono_home, event_tx, adapter_count)?;
        }
        AgentControl::SandboxReset { session_key } => {
            let sandbox = { state.lock().sandbox.clone() };
            tokio::spawn(async move {
                if let Err(error) = sandbox.destroy(&session_key).await {
                    eprintln!(
                        "[gateway] sandbox reset failed for {session_key}: {error}"
                    );
                }
            });
        }
    }
    Ok(())
}

// ── helpers ───────────────────────────────────────────────────────

pub fn chrono_now() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let days = secs / 86400;
    let time = secs % 86400;
    let h = time / 3600;
    let m = (time % 3600) / 60;
    let s = time % 60;
    let (y, mo, d) = unix_to_gregorian(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

fn unix_to_gregorian(days: u64) -> (u64, u64, u64) {
    let days = days as i64;
    let d = days + 719468;
    let era = if d >= 0 { d } else { d - 146096 } / 146097;
    let doe = d - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146097) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    (year as u64, month as u64, day as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use chrono_ipc::adapter::{AdapterResult, PlatformResult};
    use chrono_ipc::{AttachmentRef, ChatKind, ChatRef, InboundMessageBody, SenderRef, ToolError};
    use parking_lot::Mutex;

    #[test]
    fn staging_path_cannot_escape_inbox() {
        let path = staging_path(
            Path::new("/tmp/inbox"),
            "account",
            "chat",
            "message",
            "../../etc/passwd",
        );
        assert_eq!(
            path,
            PathBuf::from("/tmp/inbox/account/chat/message/passwd")
        );
        assert_eq!(safe_component("..."), "item");
    }

    struct FakeAdapter;
    struct FakeChild {
        frames: Mutex<Vec<Vec<u8>>>,
    }

    #[async_trait]
    impl PlatformAdapter for FakeAdapter {
        fn id(&self) -> &str {
            "fake"
        }

        fn account_id(&self) -> &str {
            "acc"
        }

        fn bot_username(&self) -> &str {
            "bot"
        }

        async fn start(
            &self,
            _on_event: Box<dyn Fn(RoutedEvent) + Send + Sync>,
        ) -> AdapterResult<()> {
            Ok(())
        }

        async fn invoke(
            &self,
            _tool_name: &str,
            _args: &Value,
        ) -> AdapterResult<PlatformResult> {
            Ok(PlatformResult {
                ok: true,
                result: None,
                error: Some(ToolError {
                    code: "unused".into(),
                    message: "unused".into(),
                }),
            })
        }

        async fn download_attachment(
            &self,
            _remote_id: &str,
            destination: &Path,
        ) -> AdapterResult<()> {
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(destination, "hello").unwrap();
            Ok(())
        }
    }

    impl chrono_api::AgentQuery for FakeChild {
        fn write_frame(&self, payload: &[u8]) -> anyhow::Result<()> {
            self.frames.lock().push(payload.to_vec());
            Ok(())
        }
    }

    #[test]
    fn image_attachment_detection_handles_mime_and_extension() {
        assert!(is_image_attachment("image/png", "photo.bin"));
        assert!(is_image_attachment("application/octet-stream", "PHOTO.JPG"));
        assert!(!is_image_attachment("image/svg+xml", "vector.svg"));
        assert!(!is_image_attachment("text/plain", "notes.txt"));
    }

    #[tokio::test]
    async fn attachment_job_imports_and_notifies_without_blocking() {
        let root = tempfile::tempdir().unwrap();
        let manager = Arc::new(SandboxManager::new(
            root.path().to_path_buf(),
            chrono_sandbox::SandboxConfig::default(),
        ));
        let child = Arc::new(FakeChild {
            frames: Mutex::new(Vec::new()),
        });
        let (ws_tx, mut ws_rx) = tokio::sync::broadcast::channel(8);
        let job = AttachmentJob {
            event: ChronoEvent::InboundMessage {
                session_key: "acc:chat:dm".into(),
                event_id: "tg_1".into(),
                platform: "telegram".into(),
                bot_profile_id: Some("bot".into()),
                chat: ChatRef {
                    id: "chat".into(),
                    kind: ChatKind::Dm,
                    title: None,
                },
                sender: SenderRef {
                    id: "user".into(),
                    name: "User".into(),
                },
                message: InboundMessageBody {
                    id: "m1".into(),
                    text: String::new(),
                    reply_to: None,
                    attachments: vec![AttachmentRef {
                        id: "file-1".into(),
                        mime: "image/png".into(),
                        name: Some("photo.png".into()),
                        local_path: None,
                        inline_data: None,
                    }],
                },
                received_at: "2026-01-01T00:00:00Z".into(),
            },
            adapter: Some(Arc::new(FakeAdapter)),
            sandbox: manager.clone(),
            child: child.clone(),
            ws_events: ws_tx,
            inbox_root: root.path().join("inbox"),
            account_id: "acc".into(),
            sandbox_key: "acc:chat:dm#bot".into(),
            chat_id: "chat".into(),
            message_id: "m1".into(),
        };

        ingest_attachments(job).await;

        let ws_payload = ws_rx.recv().await.unwrap().payload;
        assert!(
            ws_payload["event"]["message"]["attachments"][0]["inline_data"].is_null(),
            "WS payload must not carry image bytes"
        );
        let frames = child.frames.lock();
        assert_eq!(frames.len(), 1);
        let payload: Value = serde_json::from_slice(&frames[0]).unwrap();
        assert_eq!(payload["type"], "inbound.message");
        let path = payload["message"]["attachments"][0]["local_path"]
            .as_str()
            .unwrap();
        assert_eq!(path, "/workspace/upload/m1/photo.png");
        assert_eq!(payload["message"]["attachments"][0]["inline_data"], "aGVsbG8=");
        let host = manager
            .resolve_file("acc:chat:dm#bot", path)
            .expect("imported file");
        assert_eq!(std::fs::read_to_string(host).unwrap(), "hello");
    }
}
