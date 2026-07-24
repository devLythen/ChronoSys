use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ChronoEvent {
    #[serde(rename = "inbound.message")]
    InboundMessage {
        session_key: String,
        event_id: String,
        platform: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bot_profile_id: Option<String>,
        chat: ChatRef,
        sender: SenderRef,
        message: InboundMessageBody,
        received_at: String, // RFC3339; no chrono crate in M0
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatRef {
    pub id: String,
    pub kind: ChatKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatKind {
    Dm,
    Group,
    Channel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SenderRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboundMessageBody {
    pub id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    #[serde(default)]
    pub attachments: Vec<AttachmentRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentRef {
    pub id: String,
    pub mime: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ToolIpcMessage {
    #[serde(rename = "tool.request")]
    Request {
        session_id: String,
        tool_call_id: String,
        name: String,
        args: serde_json::Value,
        #[serde(default = "default_timeout_ms")]
        timeout_ms: u64,
    },
    #[serde(rename = "tool.response")]
    Response {
        tool_call_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<ToolError>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolError {
    pub code: String,
    pub message: String,
}

fn default_timeout_ms() -> u64 {
    15_000
}
