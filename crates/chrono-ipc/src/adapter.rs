use crate::types::{ChronoEvent, ToolError};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AdapterError {
    #[error("adapter: {0}")]
    Other(String),
}

pub type AdapterResult<T> = std::result::Result<T, AdapterError>;

/// An inbound event from a platform, plus its resolved account + binding metadata.
pub struct RoutedEvent {
    pub event: ChronoEvent,
    pub account_id: String,
    pub bot_profile_id: String,
    pub session_mode: String,
}

/// Outcome of executing a tool operation on the platform.
pub struct PlatformResult {
    pub ok: bool,
    pub result: Option<Value>,
    pub error: Option<ToolError>,
}

/// Trait implemented by each IM platform connector.
#[async_trait::async_trait]
pub trait PlatformAdapter: Send + Sync {
    fn id(&self) -> &str;
    fn account_id(&self) -> &str;
    fn bot_username(&self) -> &str;
    /// Start polling / listening. Calls `on_event` for each inbound message.
    async fn start(
        &self,
        on_event: Box<dyn Fn(RoutedEvent) + Send + Sync>,
    ) -> AdapterResult<()>;
    /// Execute a tool operation (send message, react, …).
    async fn invoke(
        &self,
        tool_name: &str,
        args: &Value,
    ) -> AdapterResult<PlatformResult>;
    /// Advertise available bot commands to the platform (e.g. Telegram setMyCommands).
    async fn sync_commands(&self, _commands: &[Value]) -> AdapterResult<()> { Ok(()) }
}

/// Compute a session key from account, chat, and mode.
pub fn session_key(account_id: &str, chat_id: &str, mode: &str) -> String {
    format!("{account_id}:{chat_id}:{mode}")
}
