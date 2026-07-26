use std::sync::{Arc, OnceLock};

use chrono_ipc::adapter::{
    session_key, AdapterError, AdapterResult, PlatformAdapter, PlatformResult, RoutedEvent,
};
use chrono_ipc::{ChatKind, ChatRef, ChronoEvent, InboundMessageBody, SenderRef};
use serde_json::Value;
use teloxide::prelude::*;
use teloxide::types::{MessageId, Recipient, ReplyParameters, UpdateKind};
use teloxide::{ApiError, RequestError};

pub struct TelegramAdapter {
    bot: Arc<Bot>,
    account_id: String,
    bot_username: OnceLock<String>,
}

impl TelegramAdapter {
    pub fn new(token: String, account_id: String) -> Self {
        Self {
            bot: Arc::new(Bot::new(token)),
            account_id,
            bot_username: OnceLock::new(),
        }
    }
}

#[async_trait::async_trait]
impl PlatformAdapter for TelegramAdapter {
    fn id(&self) -> &str {
        "telegram"
    }

    fn account_id(&self) -> &str {
        &self.account_id
    }

    fn bot_username(&self) -> &str {
        self.bot_username.get().map(|s| s.as_str()).unwrap_or("unknown")
    }

    async fn start(
        &self,
        on_event: Box<dyn Fn(RoutedEvent) + Send + Sync>,
    ) -> AdapterResult<()> {
        let bot = self.bot.clone();
        let account_id = self.account_id.clone();
        let on_event = Arc::new(on_event);

        // Verify token first — fatal if invalid.
        let me = bot.get_me().send().await.map_err(|e| {
            AdapterError::Other(format!("telegram auth failed: {e}"))
        })?;
        let username = me.username.as_deref().unwrap_or("unknown");
        eprintln!("[telegram] connected as @{username} (id: {})", me.id.0);
        let _ = self.bot_username.set(username.to_string());

        // ── Long-poll with exponential backoff ──────────────────
        // Timeout shorter than typical proxy/NAT idle timeout (~15s) to avoid
        // spurious "operation timed out" on the HTTP layer.
        const LONG_POLL_TIMEOUT: u32 = 12;
        const MAX_BACKOFF_SECS: u64 = 30;
        const INITIAL_BACKOFF_MS: u64 = 200;

        let mut offset: i32 = 0;
        let mut backoff_ms: u64 = 0;
        let mut consecutive_errors: u32 = 0;

        loop {
            tokio::task::yield_now().await;

            if backoff_ms > 0 {
                let jitter_range = ((backoff_ms as f64) * 0.25) as u64;
                let tick = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .subsec_nanos() as u64;
                let jitter = tick % (jitter_range.max(1) * 2 + 1);
                let sleep_ms = (backoff_ms + jitter).saturating_sub(jitter_range).max(50);
                tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
            }

            match bot
                .get_updates()
                .offset(offset)
                .timeout(LONG_POLL_TIMEOUT)
                .send()
                .await
            {
                Ok(updates) => {
                    if consecutive_errors > 1 {
                        eprintln!("[telegram] reconnected after {consecutive_errors} errors");
                    } else if consecutive_errors == 1 {
                        // Single transient — don't log, it's normal
                    }
                    backoff_ms = 0;
                    consecutive_errors = 0;

                    if !updates.is_empty() {
                        eprintln!("[telegram] got {} update(s)", updates.len());
                    }

                    for update in updates {
                        offset = update.id.0 as i32 + 1;
                        if let UpdateKind::Message(msg) = update.kind {
                            handle_message(&account_id, &on_event, &msg);
                        }
                    }
                }
                Err(e) => {
                    let is_fatal = matches!(
                        &e,
                        RequestError::Api(api_err)
                            if *api_err == ApiError::InvalidToken
                               || *api_err == ApiError::BotKicked
                    );

                    if is_fatal {
                        eprintln!("[telegram] fatal error, stopping adapter: {e}");
                        return Err(AdapterError::Other(format!("telegram fatal: {e}")));
                    }

                    consecutive_errors += 1;
                    backoff_ms = if backoff_ms == 0 {
                        INITIAL_BACKOFF_MS
                    } else {
                        (backoff_ms * 2).min(MAX_BACKOFF_SECS * 1000)
                    };

                    // Only log from retry #2 onward. First timeout is normal long-poll expiry.
                    if consecutive_errors > 1 {
                        eprintln!(
                            "[telegram] getUpdates error (retry #{consecutive_errors}): {e}"
                        );
                    }
                }
            }
        }
    }

    async fn invoke(
        &self,
        tool_name: &str,
        args: &Value,
    ) -> AdapterResult<PlatformResult> {
        match tool_name {
            "message_send" => {
                let chat_id = extract_chat_id(args)?;
                let text = args["text"].as_str().unwrap_or("");

                match self.bot.send_message(Recipient::Id(ChatId(chat_id)), text).await {
                    Ok(msg) => Ok(PlatformResult {
                        ok: true,
                        result: Some(serde_json::json!({"message_id": msg.id.0.to_string()})),
                        error: None,
                    }),
                    Err(e) => Ok(PlatformResult {
                        ok: false,
                        result: None,
                        error: Some(chrono_ipc::ToolError {
                            code: "send_failed".to_string(),
                            message: e.to_string(),
                        }),
                    }),
                }
            }
            "message_reply" => {
                let chat_id = extract_chat_id(args)?;
                let text = args["text"].as_str().unwrap_or("");
                let reply_to = args["reply_to_message_id"]
                    .as_str()
                    .and_then(|s| s.parse::<i32>().ok())
                    .or_else(|| args["reply_to_message_id"].as_i64().map(|v| v as i32));

                let mut msg = self.bot.send_message(Recipient::Id(ChatId(chat_id)), text);
                if let Some(rid) = reply_to {
                    msg.reply_parameters = Some(ReplyParameters::new(MessageId(rid)));
                }

                match msg.await {
                    Ok(msg) => Ok(PlatformResult {
                        ok: true,
                        result: Some(serde_json::json!({"message_id": msg.id.0.to_string()})),
                        error: None,
                    }),
                    Err(e) => Ok(PlatformResult {
                        ok: false,
                        result: None,
                        error: Some(chrono_ipc::ToolError {
                            code: "send_failed".to_string(),
                            message: e.to_string(),
                        }),
                    }),
                }
            }
            _ => Ok(PlatformResult {
                ok: false,
                result: None,
                error: Some(chrono_ipc::ToolError {
                    code: "unsupported".to_string(),
                    message: format!("unsupported tool: {tool_name}"),
                }),
            }),
        }
    }
}

fn handle_message(
    account_id: &str,
    on_event: &Arc<Box<dyn Fn(RoutedEvent) + Send + Sync>>,
    msg: &Message,
) {
    let chat = &msg.chat;
    let chat_id_s = chat.id.0.to_string();
    let chat_kind = if chat.is_group() || chat.is_supergroup() {
        ChatKind::Group
    } else if chat.is_channel() {
        ChatKind::Channel
    } else {
        ChatKind::Dm
    };
    let chat_title = chat.title().map(|s| s.to_string());
    let sender_id = msg.from.as_ref().map(|u| u.id.0.to_string());
    let sender_name = msg.from.as_ref().map(|u| u.full_name());
    let msg_id = msg.id.0;
    let text = msg.text().unwrap_or("").to_string();
    let reply_to = msg.reply_to_message().map(|m| m.id.0.to_string());

    let event = ChronoEvent::InboundMessage {
        session_key: session_key(account_id, &chat_id_s, "shared"),
        event_id: format!("tg_{}", msg_id),
        platform: "telegram".to_string(),
        bot_profile_id: None,
        chat: ChatRef {
            id: chat_id_s.clone(),
            kind: chat_kind.clone(),
            title: chat_title,
        },
        sender: SenderRef {
            id: sender_id.unwrap_or_else(|| "unknown".to_string()),
            name: sender_name.unwrap_or_else(|| "Unknown".to_string()),
        },
        message: InboundMessageBody {
            id: msg_id.to_string(),
            text,
            reply_to,
            attachments: vec![],
        },
        received_at: chrono_now(),
    };

    let session_mode = match chat_kind {
        ChatKind::Dm => "dm",
        _ => "group",
    };

    on_event(RoutedEvent {
        event,
        account_id: account_id.to_string(),
        bot_profile_id: String::new(),
        session_mode: session_mode.to_string(),
    });
}

fn extract_chat_id(args: &Value) -> Result<i64, AdapterError> {
    args["chat_id"]
        .as_str()
        .and_then(|s| s.parse::<i64>().ok())
        .or_else(|| args["chat_id"].as_i64())
        .ok_or_else(|| AdapterError::Other("missing or invalid chat_id".into()))
}

fn chrono_now() -> String {
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
