use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono_ipc::adapter::{PlatformAdapter, PlatformResult};
use chrono_ipc::{ToolError, ToolIpcMessage};
use serde_json::Value;

/// Upper bound for any single tool invocation, regardless of what the agent
/// requests. Long-running sandbox commands must opt into a longer timeout by
/// being capped here rather than blocking the gateway indefinitely.
pub const MAX_TOOL_TIMEOUT_MS: u64 = 300_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackendKind {
    Platform,
    Sandbox,
}

/// A tool execution backend. The router owns no state: backends are cheap
/// clones and are invoked outside any gateway lock.
#[async_trait]
pub trait ToolBackend: Send + Sync {
    fn kind(&self) -> BackendKind;
    fn label(&self) -> &str;
    async fn invoke(
        &self,
        session_key: &str,
        chat_id: &str,
        tool_name: &str,
        args: &Value,
    ) -> anyhow::Result<PlatformResult>;
}

/// Platform tools (`message_send`, `message_reply`, …) dispatched to the
/// adapter bound to the account that produced the inbound event.
pub struct PlatformBackend {
    adapter: Arc<dyn PlatformAdapter>,
}

impl PlatformBackend {
    pub fn new(adapter: Arc<dyn PlatformAdapter>) -> Self {
        Self { adapter }
    }
}

#[async_trait]
impl ToolBackend for PlatformBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Platform
    }

    fn label(&self) -> &str {
        self.adapter.id()
    }

    async fn invoke(
        &self,
        _session_key: &str,
        _chat_id: &str,
        tool_name: &str,
        args: &Value,
    ) -> anyhow::Result<PlatformResult> {
        self.adapter
            .invoke(tool_name, args)
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))
    }
}

/// Context needed to normalize platform tool arguments.
pub struct ToolContext<'a> {
    pub account_id: &'a str,
    pub chat_id: &'a str,
    pub session_key: &'a str,
}

/// Result of one routed tool call, including audit metadata.
pub struct ToolOutcome {
    pub response: ToolIpcMessage,
    pub backend: &'static str,
    /// Platform label for outbound WebSocket events; `None` for host tools.
    pub platform: Option<String>,
    pub elapsed_ms: u64,
    pub timed_out: bool,
}

/// Routes tool requests to the platform adapter or sandbox backend, enforces
/// the request timeout, and returns a response ready to write back to
/// agent-host.
pub struct ToolRouter {
    platform: Option<Arc<dyn ToolBackend>>,
    sandbox: Option<Arc<dyn ToolBackend>>,
}

impl ToolRouter {
    pub fn new(
        platform: Option<Arc<dyn ToolBackend>>,
        sandbox: Option<Arc<dyn ToolBackend>>,
    ) -> Self {
        Self { platform, sandbox }
    }

    pub async fn execute(&self, request: &ToolIpcMessage, ctx: &ToolContext<'_>) -> ToolOutcome {
        let (tool_call_id, name, args, timeout_ms) = match request {
            ToolIpcMessage::Request {
                tool_call_id,
                name,
                args,
                timeout_ms,
                ..
            } => (
                tool_call_id.clone(),
                name.clone(),
                args.clone(),
                *timeout_ms,
            ),
            ToolIpcMessage::Response { tool_call_id, .. } => {
                return ToolOutcome {
                    response: error_response(
                        tool_call_id,
                        "malformed_request",
                        "expected tool.request",
                    ),
                    backend: "none",
                    platform: None,
                    elapsed_ms: 0,
                    timed_out: false,
                };
            }
        };

        let kind = if name.starts_with("sandbox_") {
            BackendKind::Sandbox
        } else {
            BackendKind::Platform
        };

        let backend = match kind {
            BackendKind::Sandbox => self.sandbox.clone(),
            BackendKind::Platform => self.platform.clone(),
        };
        let Some(backend) = backend else {
            let (code, message) = match kind {
                BackendKind::Sandbox => {
                    ("sandbox_unavailable", "sandbox execution is not configured")
                }
                BackendKind::Platform => {
                    ("no_adapter", "no live platform adapter for this account")
                }
            };
            return ToolOutcome {
                response: error_response(&tool_call_id, code, message),
                backend: "none",
                platform: None,
                elapsed_ms: 0,
                timed_out: false,
            };
        };

        let args = if matches!(kind, BackendKind::Platform)
            && args.get("chat_id").is_none()
            && !ctx.chat_id.is_empty()
        {
            let mut value = args;
            if let Value::Object(ref mut map) = value {
                map.insert(
                    "chat_id".to_string(),
                    Value::String(ctx.chat_id.to_string()),
                );
            }
            value
        } else {
            args
        };

        let timeout_ms = timeout_ms.clamp(1, MAX_TOOL_TIMEOUT_MS);
        let started = Instant::now();
        let result = tokio::time::timeout(
            Duration::from_millis(timeout_ms),
            backend.invoke(ctx.session_key, ctx.chat_id, &name, &args),
        )
        .await;
        let elapsed_ms = started.elapsed().as_millis() as u64;

        let (response, timed_out) = match result {
            Ok(Ok(result)) => (
                ToolIpcMessage::Response {
                    tool_call_id,
                    ok: result.ok,
                    result: result.result,
                    error: result.error,
                },
                false,
            ),
            Ok(Err(error)) => (
                error_response(
                    &tool_call_id,
                    "dispatch_error",
                    &format!("tool {name} failed: {error:#}"),
                ),
                false,
            ),
            Err(_) => (
                error_response(
                    &tool_call_id,
                    "timeout",
                    &format!("tool {name} exceeded {timeout_ms} ms"),
                ),
                true,
            ),
        };

        ToolOutcome {
            response,
            backend: match kind {
                BackendKind::Platform => "platform",
                BackendKind::Sandbox => "sandbox",
            },
            platform: matches!(kind, BackendKind::Platform).then(|| backend.label().to_string()),
            elapsed_ms,
            timed_out,
        }
    }
}

fn error_response(tool_call_id: &str, code: &str, message: &str) -> ToolIpcMessage {
    ToolIpcMessage::Response {
        tool_call_id: tool_call_id.to_string(),
        ok: false,
        result: None,
        error: Some(ToolError {
            code: code.to_string(),
            message: message.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FakeBackend {
        kind: BackendKind,
        delay: Duration,
        result: PlatformResult,
        seen_args: Mutex<Option<Value>>,
    }

    impl FakeBackend {
        fn new(kind: BackendKind, delay: Duration, ok: bool) -> Arc<Self> {
            Arc::new(Self {
                kind,
                delay,
                result: PlatformResult {
                    ok,
                    result: Some(json!({ "echo": true })),
                    error: if ok {
                        None
                    } else {
                        Some(ToolError {
                            code: "fake".into(),
                            message: "nope".into(),
                        })
                    },
                },
                seen_args: Mutex::new(None),
            })
        }
    }

    #[async_trait]
    impl ToolBackend for FakeBackend {
        fn kind(&self) -> BackendKind {
            self.kind
        }

        fn label(&self) -> &str {
            "fake"
        }

        async fn invoke(
            &self,
            _session_key: &str,
            _chat_id: &str,
            _tool_name: &str,
            args: &Value,
        ) -> anyhow::Result<PlatformResult> {
            *self.seen_args.lock() = Some(args.clone());
            tokio::time::sleep(self.delay).await;
            Ok(self.result.clone())
        }
    }

    fn request(name: &str, timeout_ms: u64) -> ToolIpcMessage {
        ToolIpcMessage::Request {
            session_id: "acc:chat:dm".into(),
            tool_call_id: "call-1".into(),
            name: name.into(),
            args: json!({ "text": "hi" }),
            timeout_ms,
        }
    }

    fn ctx() -> ToolContext<'static> {
        ToolContext {
            account_id: "acc",
            chat_id: "42",
            session_key: "acc:chat:dm",
        }
    }

    #[tokio::test]
    async fn platform_tools_inject_chat_id() {
        let backend = FakeBackend::new(BackendKind::Platform, Duration::ZERO, true);
        let router = ToolRouter::new(Some(backend.clone()), None);

        let outcome = router
            .execute(&request("message_send", 1_000), &ctx())
            .await;

        assert!(matches!(
            outcome.response,
            ToolIpcMessage::Response { ok: true, .. }
        ));
        assert_eq!(outcome.backend, "platform");
        assert_eq!(outcome.platform.as_deref(), Some("fake"));
        let args = backend.seen_args.lock().clone().unwrap();
        assert_eq!(args["chat_id"], "42");
    }

    #[tokio::test]
    async fn sandbox_tools_do_not_receive_chat_id() {
        let backend = FakeBackend::new(BackendKind::Sandbox, Duration::ZERO, true);
        let router = ToolRouter::new(None, Some(backend.clone()));

        let outcome = router
            .execute(&request("sandbox_exec", 1_000), &ctx())
            .await;

        assert!(matches!(
            outcome.response,
            ToolIpcMessage::Response { ok: true, .. }
        ));
        assert_eq!(outcome.backend, "sandbox");
        assert!(outcome.platform.is_none());
        let args = backend.seen_args.lock().clone().unwrap();
        assert!(args.get("chat_id").is_none());
    }

    #[tokio::test]
    async fn timeout_returns_structured_error() {
        let backend = FakeBackend::new(BackendKind::Platform, Duration::from_millis(50), true);
        let router = ToolRouter::new(Some(backend), None);

        let outcome = router.execute(&request("message_send", 1), &ctx()).await;

        assert!(outcome.timed_out);
        match outcome.response {
            ToolIpcMessage::Response { ok, error, .. } => {
                assert!(!ok);
                assert_eq!(error.unwrap().code, "timeout");
            }
            other => panic!("unexpected response: {other:?}"),
        }
    }

    #[tokio::test]
    async fn missing_backend_fails_closed() {
        let router = ToolRouter::new(None, None);

        let platform = router
            .execute(&request("message_send", 1_000), &ctx())
            .await;
        let sandbox = router
            .execute(&request("sandbox_exec", 1_000), &ctx())
            .await;

        match platform.response {
            ToolIpcMessage::Response { error, .. } => {
                assert_eq!(error.unwrap().code, "no_adapter");
            }
            other => panic!("unexpected response: {other:?}"),
        }
        match sandbox.response {
            ToolIpcMessage::Response { error, .. } => {
                assert_eq!(error.unwrap().code, "sandbox_unavailable");
            }
            other => panic!("unexpected response: {other:?}"),
        }
    }

    struct BarrierBackend {
        barrier: Arc<tokio::sync::Barrier>,
        entered: AtomicUsize,
    }

    #[async_trait]
    impl ToolBackend for BarrierBackend {
        fn kind(&self) -> BackendKind {
            BackendKind::Platform
        }

        fn label(&self) -> &str {
            "barrier"
        }

        async fn invoke(
            &self,
            _session_key: &str,
            _chat_id: &str,
            _tool_name: &str,
            _args: &Value,
        ) -> anyhow::Result<PlatformResult> {
            self.entered.fetch_add(1, Ordering::SeqCst);
            self.barrier.wait().await;
            Ok(PlatformResult {
                ok: true,
                result: None,
                error: None,
            })
        }
    }

    #[tokio::test]
    async fn router_executes_calls_concurrently() {
        let backend = Arc::new(BarrierBackend {
            barrier: Arc::new(tokio::sync::Barrier::new(2)),
            entered: AtomicUsize::new(0),
        });
        let router = Arc::new(ToolRouter::new(Some(backend.clone()), None));

        let first = {
            let router = router.clone();
            tokio::spawn(async move {
                router
                    .execute(&request("message_send", 1_000), &ctx())
                    .await
            })
        };
        let second = {
            let router = router.clone();
            tokio::spawn(async move {
                router
                    .execute(&request("message_send", 1_000), &ctx())
                    .await
            })
        };

        let (first, second) = tokio::time::timeout(Duration::from_secs(1), async {
            tokio::join!(first, second)
        })
        .await
        .expect("router serialized two tool calls");
        assert!(first.is_ok());
        assert!(second.is_ok());
        assert_eq!(backend.entered.load(Ordering::SeqCst), 2);
    }
}
