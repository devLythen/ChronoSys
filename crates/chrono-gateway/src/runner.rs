use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{Context, Result};
use chrono_api::AgentControl;
use chrono_config::{Binding, BotProfile, ConfigStore, PlatformAccount};
use chrono_ipc::adapter::{PlatformAdapter, RoutedEvent};
use chrono_ipc::{ChronoEvent, ToolError, ToolIpcMessage};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::adapters::build_adapter;
use crate::http;
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
    let username = a
        .adapter_config_json
        .get("bot_username")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    format!(
        "{}|{}|{}|{}|{}",
        a.platform, a.enabled, a.secret_ref, a.adapter_id, username
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

fn dispatch_tool(
    adapter: &Arc<dyn PlatformAdapter>,
    account_id: &str,
    chat_id: &str,
    request: &ToolIpcMessage,
    audit: &mut AuditLog,
) -> anyhow::Result<ToolIpcMessage> {
    let (tool_call_id, name, args) = match request {
        ToolIpcMessage::Request {
            tool_call_id,
            name,
            args,
            ..
        } => (tool_call_id.clone(), name.clone(), args.clone()),
        _ => anyhow::bail!("expected tool.request, got response"),
    };

    let args = if args.get("chat_id").is_none() && !chat_id.is_empty() {
        let mut a = args.clone();
        if let serde_json::Value::Object(ref mut map) = a {
            map.insert(
                "chat_id".to_string(),
                serde_json::Value::String(chat_id.to_string()),
            );
        }
        a
    } else {
        args
    };

    let started = std::time::Instant::now();
    let result = futures::executor::block_on(adapter.invoke(&name, &args))?;
    let elapsed_ms = started.elapsed().as_millis() as u64;

    audit.write(&json!({
        "ts": chrono_now(),
        "event": "tool.response",
        "account_id": account_id,
        "tool_name": name,
        "tool_call_id": tool_call_id,
        "ok": result.ok,
        "elapsed_ms": elapsed_ms,
        "detail": result.error.as_ref().map(|e| &e.message).unwrap_or(&"ok".to_string()),
    }));

    Ok(ToolIpcMessage::Response {
        tool_call_id,
        ok: result.ok,
        result: result.result,
        error: result.error,
    })
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
) -> Result<()> {
    let child = GatewayChild::spawn(&bun_path, &agent_host_dir, &chrono_home)
        .context("spawn agent-host")?;
    let child = Arc::new(child);

    // 2. Audit log
    let audit = AuditLog::open(&chrono_home).context("open audit log")?;

    let state = Arc::new(Mutex::new(GatewayState {
        child: child.clone(),
        adapters: HashMap::new(),
        bindings: HashMap::new(),
        bot_profiles: HashMap::new(),
        audit,
        rate_limiter: RateLimiter::new(),
    }));

    // 3. Control plane HTTP (config CRUD from WebUI)
    let http::HttpServer {
        mut agent_ctrl_rx,
        agent_alive,
        adapter_count,
    } = http::start_http_server(&chrono_home, config_store)
        .await
        .context("start control plane")?;

    // 4. Adapter events → main loop
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<RoutedEvent>();

    // 5. Initial config + adapters from DB (secrets only resolved here)
    if let Err(e) = sync_from_config(&state, &chrono_home, &event_tx, &adapter_count) {
        eprintln!("[gateway] initial config sync: {e:#}");
    }

    // 6. stdout reader (tool dispatch)
    let stdout_child = child.clone();
    let stdout_state = state.clone();
    let stdout_alive = agent_alive.clone();
    tokio::task::spawn_blocking(move || loop {
        let payload = match stdout_child.read_frame() {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[gateway] agent stdout read error: {e}");
                stdout_alive.store(false, Ordering::Relaxed);
                break;
            }
        };

        eprintln!("[gateway] agent stdout frame: {} bytes", payload.len());
        if let Ok(tool_msg) = serde_json::from_slice::<ToolIpcMessage>(&payload) {
            if let ToolIpcMessage::Request {
                ref session_id, ..
            } = &tool_msg
            {
                let parts: Vec<&str> = session_id.splitn(3, ':').collect();
                let account_id = parts.first().copied().unwrap_or("unknown");
                let chat_id = parts.get(1).copied().unwrap_or("");
                let mut state = stdout_state.lock().unwrap();
                let adapter = state
                    .adapters
                    .get(account_id)
                    .map(|live| live.adapter.clone());
                match adapter {
                    Some(adapter) => {
                        match dispatch_tool(
                            &adapter,
                            account_id,
                            chat_id,
                            &tool_msg,
                            &mut state.audit,
                        ) {
                            Ok(response) => {
                                let body = serde_json::to_vec(&response).unwrap_or_default();
                                let _ = stdout_child.write_frame(&body);
                            }
                            Err(e) => {
                                eprintln!("[gateway] tool dispatch error: {e:#}");
                                if let ToolIpcMessage::Request { tool_call_id, .. } = &tool_msg {
                                    let response = ToolIpcMessage::Response {
                                        tool_call_id: tool_call_id.clone(),
                                        ok: false,
                                        result: None,
                                        error: Some(ToolError {
                                            code: "dispatch_error".to_string(),
                                            message: format!("{e:#}"),
                                        }),
                                    };
                                    let body = serde_json::to_vec(&response).unwrap_or_default();
                                    let _ = stdout_child.write_frame(&body);
                                }
                            }
                        }
                    }
                    None => {
                        eprintln!(
                            "[gateway] tool dispatch: no live adapter for account {account_id}"
                        );
                        if let ToolIpcMessage::Request { tool_call_id, .. } = &tool_msg {
                            let response = ToolIpcMessage::Response {
                                tool_call_id: tool_call_id.clone(),
                                ok: false,
                                result: None,
                                error: Some(ToolError {
                                    code: "no_adapter".to_string(),
                                    message: format!("no live adapter for account {account_id}"),
                                }),
                            };
                            let body = serde_json::to_vec(&response).unwrap_or_default();
                            let _ = stdout_child.write_frame(&body);
                        }
                    }
                }
            }
            continue;
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
                    eprintln!("[gateway] agent error: {message}");
                }
                other => {
                    eprintln!("[gateway] unknown message type from agent-host: {other}");
                }
            }
        }
    });

    // 7. Main loop
    eprintln!("[gateway] control plane ready (adapters managed from config DB / WebUI)");
    loop {
        agent_alive.store(child.is_alive(), Ordering::Relaxed);

        tokio::select! {
            routed = event_rx.recv() => {
                match routed {
                    Some(routed) => {
                        if let Err(e) = handle_inbound_event(&state, routed) {
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

    // Stop adapters on shutdown
    {
        let mut state = state.lock().unwrap();
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
    state: &Arc<Mutex<GatewayState>>,
    chrono_home: &Path,
    event_tx: &mpsc::UnboundedSender<RoutedEvent>,
    adapter_count: &Arc<AtomicUsize>,
) -> Result<()> {
    let db_path = chrono_home.join("state/chrono.db");
    let store = ConfigStore::open(&db_path).context("open config DB for sync")?;

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

    let mut state = state.lock().unwrap();
    state.bindings = bindings;
    state.bot_profiles = bot_profiles;

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
    eprintln!("[gateway] config reloaded ({count} live adapter(s))");
    Ok(())
}

fn handle_inbound_event(state: &Arc<Mutex<GatewayState>>, routed: RoutedEvent) -> Result<()> {
    let mut state = state.lock().unwrap();

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
    let ChronoEvent::InboundMessage {
        ref chat,
        ref mut session_key,
        ref mut bot_profile_id,
        ..
    } = &mut event;
    {
        *session_key = chrono_ipc::adapter::session_key(
            &routed.account_id,
            &chat.id,
            &resolved.session_mode,
        );
        *bot_profile_id = Some(resolved.bot_profile_id.clone());
    }

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

    let payload = serde_json::to_vec(&event).unwrap_or_default();
    if let Err(e) = state.child.write_frame(&payload) {
        eprintln!("[gateway] failed to write event to agent: {e}");
    } else {
        eprintln!("[gateway] wrote inbound event to agent stdin");
    }
    Ok(())
}

fn handle_agent_control(
    state: &Arc<Mutex<GatewayState>>,
    chrono_home: &Path,
    event_tx: &mpsc::UnboundedSender<RoutedEvent>,
    adapter_count: &Arc<AtomicUsize>,
    ctrl: AgentControl,
) -> Result<()> {
    match ctrl {
        AgentControl::Steer { session_id, text } => {
            let body = json!({
                "type": "steer",
                "session_id": session_id,
                "text": text,
            });
            let payload = serde_json::to_vec(&body)?;
            let state = state.lock().unwrap();
            state.child.write_frame(&payload)?;
            eprintln!("[gateway] wrote steer for session {session_id}");
        }
        AgentControl::Abort { session_id } => {
            let body = json!({
                "type": "abort",
                "session_id": session_id,
            });
            let payload = serde_json::to_vec(&body)?;
            let state = state.lock().unwrap();
            state.child.write_frame(&payload)?;
            eprintln!("[gateway] wrote abort for session {session_id}");
        }
        AgentControl::ReloadConfig => {
            sync_from_config(state, chrono_home, event_tx, adapter_count)?;
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
