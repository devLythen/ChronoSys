use std::path::Path;
use std::sync::{Arc, OnceLock};

use chrono_ipc::adapter::{
    session_key, AdapterError, AdapterResult, PlatformAdapter, PlatformResult, RoutedEvent,
};
use chrono_ipc::{
    AttachmentRef, ChatKind, ChatRef, ChronoEvent, InboundMessageBody, SenderRef,
};
use serde_json::Value;
use teloxide::net::Download;
use teloxide::prelude::*;
use teloxide::types::{
    BotCommand, InputFile, MessageId, Recipient, ReplyParameters, UpdateKind,
};
use teloxide::{ApiError, RequestError};

pub struct TelegramAdapter {
    bot: Arc<Bot>,
    account_id: String,
    bot_username: OnceLock<String>,
}

impl TelegramAdapter {
    pub fn new(
        token: String,
        account_id: String,
        proxy_url: Option<String>,
        api_url: Option<String>,
    ) -> Result<Self, AdapterError> {
        let mut builder = teloxide::net::default_reqwest_settings();
        if let Some(proxy_url) = proxy_url.filter(|value| !value.trim().is_empty()) {
            let normalized = normalize_proxy_url(&proxy_url);
            let proxy = reqwest::Proxy::all(&normalized).map_err(|error| {
                AdapterError::Other(format!("invalid Telegram proxy URL: {error}"))
            })?;
            builder = builder.proxy(proxy);
            eprintln!("[telegram] proxy configured for account {account_id}");
        }
        let client = builder
            .build()
            .map_err(|error| AdapterError::Other(format!("telegram HTTP client: {error}")))?;
        let mut bot = Bot::with_client(token, client);
        if let Some(api_url) = api_url.filter(|value| !value.trim().is_empty()) {
            let url = reqwest::Url::parse(api_url.trim()).map_err(|error| {
                AdapterError::Other(format!("invalid Telegram API URL: {error}"))
            })?;
            bot = bot.set_api_url(url);
            eprintln!("[telegram] custom Bot API URL for account {account_id}");
        }
        Ok(Self {
            bot: Arc::new(bot),
            account_id,
            bot_username: OnceLock::new(),
        })
    }
}

fn normalize_proxy_url(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
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
            "file_send" => {
                let chat_id = extract_chat_id(args)?;
                let path = args["path"].as_str().unwrap_or("");
                if path.is_empty() {
                    return Ok(PlatformResult {
                        ok: false,
                        result: None,
                        error: Some(chrono_ipc::ToolError {
                            code: "invalid_args".to_string(),
                            message: "file_send requires { path: string }".to_string(),
                        }),
                    });
                }
                let mut request =
                    self.bot
                        .send_document(Recipient::Id(ChatId(chat_id)), InputFile::file(path));
                if let Some(caption) = args["caption"].as_str().filter(|value| !value.is_empty()) {
                    request = request.caption(caption.to_string());
                }
                match request.await {
                    Ok(msg) => Ok(PlatformResult {
                        ok: true,
                        result: Some(serde_json::json!({"message_id": msg.id.0.to_string()})),
                        error: None,
                    }),
                    Err(e) => Ok(PlatformResult {
                        ok: false,
                        result: None,
                        error: Some(chrono_ipc::ToolError {
                            code: "send_file_failed".to_string(),
                            message: e.to_string(),
                        }),
                    }),
                }
            }
            _ => Ok(PlatformResult {
                ok: false, result: None,
                error: Some(chrono_ipc::ToolError { code: "unsupported".to_string(), message: format!("unsupported tool: {tool_name}") }),
            }),
        }
    }

    async fn sync_commands(&self, commands: &[Value]) -> AdapterResult<()> {
        let mut tg_commands: Vec<BotCommand> = vec![
            BotCommand { command: "new".into(), description: "Start a new conversation session".into() },
            BotCommand { command: "compact".into(), description: "Compress conversation context".into() },
        ];
        for cmd in commands {
            if let (Some(name), Some(desc)) = (cmd.get("name").and_then(|v| v.as_str()), cmd.get("description").and_then(|v| v.as_str())) {
                if name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    tg_commands.push(BotCommand { command: name.to_string(), description: desc.to_string() });
                }
            }
        }
        let count = tg_commands.len();
        eprintln!("[telegram] syncing {count} bot commands",);
        let _ = self.bot.set_my_commands(tg_commands).send().await;
        eprintln!("[telegram] synced {count} commands");
        Ok(())
    }

    async fn download_attachment(
        &self,
        remote_id: &str,
        destination: &Path,
    ) -> AdapterResult<()> {
        let file = self
            .bot
            .get_file(remote_id)
            .await
            .map_err(|error| AdapterError::Other(error.to_string()))?;
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| AdapterError::Other(error.to_string()))?;
        }
        let mut output = tokio::fs::File::create(destination)
            .await
            .map_err(|error| AdapterError::Other(error.to_string()))?;
        self.bot
            .download_file(&file.path, &mut output)
            .await
            .map_err(|error| AdapterError::Other(error.to_string()))?;
        Ok(())
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
    let event_id = format!("tg_{msg_id}");
    let mut attachments = Vec::new();

    if let Some(document) = msg.document() {
        let name = document
            .file_name
            .clone()
            .unwrap_or_else(|| format!("document_{msg_id}"));
        attachments.push(attachment_meta(
            &document.file.id,
            document.mime_type.as_ref().map(ToString::to_string),
            name,
        ));
    } else if let Some(photo) = msg.photo().and_then(|sizes| sizes.last()) {
        attachments.push(attachment_meta(
            &photo.file.id,
            Some("image/jpeg".to_string()),
            format!("photo_{msg_id}.jpg"),
        ));
    }

    if let Some(voice) = msg.voice() {
        attachments.push(attachment_meta(
            &voice.file.id,
            voice
                .mime_type
                .as_ref()
                .map(ToString::to_string)
                .or_else(|| Some("audio/ogg".to_string())),
            format!("voice_{msg_id}.ogg"),
        ));
    }
    if let Some(audio) = msg.audio() {
        let name = audio
            .file_name
            .clone()
            .unwrap_or_else(|| format!("audio_{msg_id}"));
        attachments.push(attachment_meta(
            &audio.file.id,
            audio.mime_type.as_ref().map(ToString::to_string),
            name,
        ));
    }
    if let Some(video) = msg.video() {
        let name = video
            .file_name
            .clone()
            .unwrap_or_else(|| format!("video_{msg_id}.mp4"));
        attachments.push(attachment_meta(
            &video.file.id,
            video.mime_type.as_ref().map(ToString::to_string),
            name,
        ));
    }

    let event = ChronoEvent::InboundMessage {
        session_key: session_key(account_id, &chat_id_s, "shared"),
        event_id,
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
            attachments,
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

fn attachment_meta(file_id: &str, mime: Option<String>, name: String) -> AttachmentRef {
    AttachmentRef {
        id: file_id.to_string(),
        mime: mime.unwrap_or_else(|| "application/octet-stream".to_string()),
        name: Some(name),
        local_path: None,
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_urls_get_a_default_scheme() {
        assert_eq!(normalize_proxy_url("127.0.0.1:7890"), "http://127.0.0.1:7890");
        assert_eq!(normalize_proxy_url("http://127.0.0.1:7890"), "http://127.0.0.1:7890");
        assert_eq!(normalize_proxy_url("socks5://127.0.0.1:7891"), "socks5://127.0.0.1:7891");
    }
}
