use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{Context, Result};
use chrono_config::{Binding, BotProfile};
use chrono_ipc::adapter::{PlatformAdapter, RoutedEvent};
use chrono_ipc::{ChronoEvent, ToolError, ToolIpcMessage};
use serde_json::{json, Value};
use tokio::sync::mpsc;

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

struct GatewayState {
    child: Arc<GatewayChild>,
    adapters: HashMap<String, Arc<dyn PlatformAdapter>>,
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
    adapters: &HashMap<String, Arc<dyn PlatformAdapter>>,
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

    // Inject platform context: chat_id from session_key if not already in args
    let args = if args.get("chat_id").is_none() && !chat_id.is_empty() {
        let mut a = args.clone();
        if let serde_json::Value::Object(ref mut map) = a {
            map.insert("chat_id".to_string(), serde_json::Value::String(chat_id.to_string()));
        }
        a
    } else {
        args
    };

    let adapter = adapters
        .get(account_id)
        .with_context(|| format!("no adapter for account {account_id}"))?;

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

pub async fn run_gateway(
    chrono_home: PathBuf,
    fake_llm: bool,
    bun_path: String,
    agent_host_dir: PathBuf,
    adapters: HashMap<String, Arc<dyn PlatformAdapter>>,
    bindings_by_account: HashMap<String, Vec<Binding>>,
    bot_profiles: HashMap<String, BotProfile>,
) -> Result<()> {
    // 1. Spawn agent-host
    let child = GatewayChild::spawn(&bun_path, &agent_host_dir, &chrono_home, fake_llm)
        .context("spawn agent-host")?;
    let child = Arc::new(child);

    // 2. Audit log
    let audit = AuditLog::open(&chrono_home).context("open audit log")?;

    let state = Arc::new(Mutex::new(GatewayState {
        child: child.clone(),
        adapters: adapters.clone(),
        bindings: bindings_by_account,
        bot_profiles,
        audit,
        rate_limiter: RateLimiter::new(),
    }));

    // 3. Channel for adapter events → main loop
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<RoutedEvent>();

    // 4. Spawn stdout reader task (tool dispatch)
    let stdout_child = child.clone();
    let stdout_adapters = adapters.clone();
    let stdout_state = state.clone();
    tokio::task::spawn_blocking(move || loop {
        let payload = match stdout_child.read_frame() {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[gateway] agent stdout read error: {e}");
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
                match dispatch_tool(&stdout_adapters, account_id, chat_id, &tool_msg, &mut state.audit) {
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
            continue;
        }

        if let Ok(value) = serde_json::from_slice::<Value>(&payload) {
            let msg_type = value
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            match msg_type {
                "done" => { /* agent round complete */ }
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

    // 5. Spawn adapter tasks
    let adapters_for_tasks = adapters.clone();
    for (account_id, adapter) in &adapters_for_tasks {
        let adapter = adapter.clone();
        let tx = event_tx.clone();
        let account_id = account_id.clone();
        eprintln!(
            "[gateway] starting adapter {} for account {}",
            adapter.id(),
            account_id
        );
        tokio::spawn(async move {
            let _ = adapter
                .start(Box::new(move |mut evt| {
                    evt.account_id = account_id.clone();
                    let _ = tx.send(evt);
                }))
                .await;
        });
    }

    // 6. Main loop: adapter events → agent stdin
    eprintln!("[gateway] listening for events...");
    loop {
        match event_rx.recv().await {
            Some(routed) => {
                let mut state = state.lock().unwrap();

                // Rate limit
                let max_rpm: u32 = 30;
                if !state.rate_limiter.check(&routed.account_id, max_rpm) {
                    eprintln!("[gateway] rate-limited account {}", routed.account_id);
                    state.audit.write(&json!({
                        "ts": chrono_now(),
                        "event": "rate_limited",
                        "account_id": routed.account_id,
                        "detail": "rate limit exceeded",
                    }));
                    continue;
                }

                // Resolve binding
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
                        continue;
                    }
                };

                // Mention-only check
                if resolved
                    .policy_json
                    .get("mention_required")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    let adapter = state.adapters.get(&routed.account_id);
                    let bot_username = adapter
                        .map(|a| a.bot_username().to_string())
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
                        continue;
                    }
                }

                // Update event's session_key + bot_profile_id with resolved binding
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

                // Audit inbound
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

                // Write to agent stdin
                let payload = serde_json::to_vec(&event).unwrap_or_default();
                if let Err(e) = state.child.write_frame(&payload) {
                    eprintln!("[gateway] failed to write event to agent: {e}");
                } else {
                    eprintln!("[gateway] wrote inbound event to agent stdin");
                }
            }
            None => {
                eprintln!("[gateway] event channel closed, shutting down");
                break;
            }
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
