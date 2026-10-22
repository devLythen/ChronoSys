use std::path::Path;
use std::sync::Arc;

use base64::Engine;

use async_trait::async_trait;
use chrono_config::ConfigStore;
use chrono_ipc::adapter::{PlatformAdapter, PlatformResult};
use chrono_ipc::ToolError;
use chrono_sandbox::{SandboxConfig, SandboxError, SandboxManager};
use serde_json::{json, Value};

use crate::tool_router::{BackendKind, ToolBackend};

/// `sandbox_exec` / `sandbox_send_file` / `sandbox_view_image` backend. The
/// tool schema lives in agent-host; this layer validates arguments and maps
/// results into IPC.
pub struct SandboxToolBackend {
    manager: Arc<SandboxManager>,
    adapter: Option<Arc<dyn PlatformAdapter>>,
}

impl SandboxToolBackend {
    pub fn new(
        manager: Arc<SandboxManager>,
        adapter: Option<Arc<dyn PlatformAdapter>>,
    ) -> Self {
        Self { manager, adapter }
    }
}

#[async_trait]
impl ToolBackend for SandboxToolBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Sandbox
    }

    fn label(&self) -> &str {
        "sandbox"
    }

    async fn invoke(
        &self,
        session_key: &str,
        chat_id: &str,
        tool_name: &str,
        args: &Value,
    ) -> anyhow::Result<PlatformResult> {
        match tool_name {
            "sandbox_exec" => self.exec(session_key, args).await,
            "sandbox_send_file" => self.send_file(session_key, chat_id, args).await,
            "sandbox_view_image" => self.view_image(session_key, args).await,
            _ => Ok(failure(
                "unsupported",
                &format!("unsupported sandbox tool: {tool_name}"),
            )),
        }
    }
}

impl SandboxToolBackend {
    async fn exec(
        &self,
        session_key: &str,
        args: &Value,
    ) -> anyhow::Result<PlatformResult> {
        let cmd = match args.get("cmd").and_then(Value::as_str) {
            Some(cmd) => cmd,
            None => {
                return Ok(failure(
                    "invalid_args",
                    "sandbox_exec requires { cmd: string }",
                ))
            }
        };
        let cwd = args.get("cwd").and_then(Value::as_str);
        let timeout_ms = args.get("timeout_ms").and_then(Value::as_u64);

        match self.manager.exec(session_key, cmd, cwd, timeout_ms).await {
            Ok(output) => Ok(PlatformResult {
                ok: true,
                result: Some(json!({
                    "exit_code": output.exit_code,
                    "stdout": output.stdout,
                    "stderr": output.stderr,
                    "truncated": output.truncated,
                })),
                error: None,
            }),
            Err(error) => Ok(failure(sandbox_error_code(&error), &error.to_string())),
        }
    }

    async fn view_image(
        &self,
        session_key: &str,
        args: &Value,
    ) -> anyhow::Result<PlatformResult> {
        let path = match args.get("path").and_then(Value::as_str) {
            Some(path) => path,
            None => {
                return Ok(failure(
                    "invalid_args",
                    "sandbox_view_image requires { path: '/workspace/...' }",
                ))
            }
        };
        let host = match self.manager.resolve_file(session_key, path) {
            Ok(host) => host,
            Err(error) => {
                return Ok(failure(sandbox_error_code(&error), &error.to_string()))
            }
        };
        let Some(mime) = image_mime(&host) else {
            return Ok(failure(
                "unsupported_image",
                "sandbox_view_image supports png, jpeg, webp, and gif",
            ));
        };
        let metadata = match std::fs::metadata(&host) {
            Ok(metadata) => metadata,
            Err(error) => return Ok(failure("sandbox_error", &error.to_string())),
        };
        if metadata.len() > chrono_sandbox::MAX_IMAGE_BYTES {
            return Ok(failure(
                "sandbox_file_too_large",
                &format!(
                    "image exceeds {} bytes",
                    chrono_sandbox::MAX_IMAGE_BYTES
                ),
            ));
        }
        let bytes = match std::fs::read(&host) {
            Ok(bytes) => bytes,
            Err(error) => return Ok(failure("sandbox_error", &error.to_string())),
        };
        Ok(PlatformResult {
            ok: true,
            result: Some(json!({
                "path": path,
                "mime": mime,
                "data": base64::engine::general_purpose::STANDARD.encode(bytes),
            })),
            error: None,
        })
    }

    async fn send_file(
        &self,
        session_key: &str,
        chat_id: &str,
        args: &Value,
    ) -> anyhow::Result<PlatformResult> {
        if chat_id.is_empty() {
            return Ok(failure(
                "no_chat",
                "sandbox_send_file requires an active conversation",
            ));
        }
        let path = match args.get("path").and_then(Value::as_str) {
            Some(path) => path,
            None => {
                return Ok(failure(
                    "invalid_args",
                    "sandbox_send_file requires { path: '/workspace/...' }",
                ))
            }
        };
        let Some(adapter) = &self.adapter else {
            return Ok(failure(
                "no_adapter",
                "no live platform adapter for this account",
            ));
        };
        let host_path = match self.manager.resolve_file(session_key, path) {
            Ok(path) => path,
            Err(error) => {
                return Ok(failure(sandbox_error_code(&error), &error.to_string()))
            }
        };
        let caption = args.get("caption").and_then(Value::as_str);
        let mut send_args = json!({
            "chat_id": chat_id,
            "path": host_path.to_string_lossy(),
        });
        if let Some(caption) = caption.filter(|value| !value.trim().is_empty()) {
            send_args["caption"] = Value::String(caption.to_string());
        }
        match adapter.invoke("file_send", &send_args).await {
            Ok(result) => Ok(result),
            Err(error) => Ok(failure("send_file_failed", &error.to_string())),
        }
    }
}

fn sandbox_error_code(error: &SandboxError) -> &'static str {
    match error {
        SandboxError::Disabled => "sandbox_disabled",
        SandboxError::NotConfigured => "sandbox_not_configured",
        SandboxError::InvalidConfig(_) => "sandbox_invalid_config",
        SandboxError::Resetting => "sandbox_resetting",
        SandboxError::InvalidWorkdir(_) | SandboxError::InvalidFile(_) => "sandbox_invalid_path",
        SandboxError::FileNotFound(_) => "sandbox_file_not_found",
        SandboxError::FileOutsideWorkspace(_) => "sandbox_file_outside_workspace",
        SandboxError::FileTooLarge(_) => "sandbox_file_too_large",
        SandboxError::Timeout(_) => "sandbox_timeout",
        SandboxError::Docker(_) | SandboxError::Io(_) => "sandbox_error",
    }
}

fn image_mime(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("webp") => Some("image/webp"),
        Some("gif") => Some("image/gif"),
        _ => None,
    }
}

fn failure(code: &str, message: &str) -> PlatformResult {
    PlatformResult {
        ok: false,
        result: None,
        error: Some(ToolError {
            code: code.to_string(),
            message: message.to_string(),
        }),
    }
}

/// Read sandbox settings from the config DB. Missing values use conservative
/// defaults; `enabled=false` and an empty image keep the tool fail-closed.
pub fn load_sandbox_config(store: &ConfigStore) -> SandboxConfig {
    let default = SandboxConfig::default();
    SandboxConfig {
        enabled: bool_setting(store, "sandbox.enabled", default.enabled),
        image: string_setting(store, "sandbox.image", &default.image),
        network: bool_setting(store, "sandbox.network", default.network),
        timeout_ms: u64_setting(store, "sandbox.timeout_ms", default.timeout_ms),
        memory_mb: u64_setting(store, "sandbox.memory_mb", default.memory_mb),
        cpus: f64_setting(store, "sandbox.cpus", default.cpus),
        pids_limit: u64_setting(store, "sandbox.pids_limit", default.pids_limit),
        idle_secs: u64_setting(store, "sandbox.idle_secs", default.idle_secs),
        max_lifetime_secs: u64_setting(
            store,
            "sandbox.max_lifetime_secs",
            default.max_lifetime_secs,
        ),
        destroy_on_new: bool_setting(
            store,
            "sandbox.destroy_on_new",
            default.destroy_on_new,
        ),
    }
}

fn setting(store: &ConfigStore, key: &str) -> Option<Value> {
    store
        .settings()
        .get(key)
        .ok()
        .flatten()
        .map(|setting| setting.value_json)
}

fn bool_setting(store: &ConfigStore, key: &str, default: bool) -> bool {
    setting(store, key)
        .and_then(|value| value.as_bool())
        .unwrap_or(default)
}

fn string_setting(store: &ConfigStore, key: &str, default: &str) -> String {
    setting(store, key)
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| default.to_string())
}

fn u64_setting(store: &ConfigStore, key: &str, default: u64) -> u64 {
    setting(store, key)
        .and_then(|value| value.as_u64())
        .unwrap_or(default)
}

fn f64_setting(store: &ConfigStore, key: &str, default: f64) -> f64 {
    setting(store, key)
        .and_then(|value| value.as_f64())
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool_router::{ToolContext, ToolRouter};
    use async_trait::async_trait;
    use chrono_ipc::adapter::{AdapterResult, PlatformAdapter, PlatformResult, RoutedEvent};
    use chrono_ipc::ToolIpcMessage;
    use parking_lot::Mutex;
    use serde_json::json;

    fn request(args: Value, timeout_ms: u64) -> ToolIpcMessage {
        ToolIpcMessage::Request {
            session_id: "acc:chat:dm".into(),
            tool_call_id: "call-1".into(),
            name: "sandbox_exec".into(),
            args,
            timeout_ms,
        }
    }

    fn context() -> ToolContext<'static> {
        ToolContext {
            account_id: "acc",
            chat_id: "chat",
            session_key: "acc:chat:dm",
        }
    }

    struct FakeAdapter {
        seen: Mutex<Option<Value>>,
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
            tool_name: &str,
            args: &Value,
        ) -> AdapterResult<PlatformResult> {
            assert_eq!(tool_name, "file_send");
            *self.seen.lock() = Some(args.clone());
            Ok(PlatformResult {
                ok: true,
                result: Some(json!({ "message_id": "m1" })),
                error: None,
            })
        }
    }

    #[tokio::test]
    async fn sandbox_send_file_resolves_workspace_and_uses_adapter() {
        let root = tempfile::tempdir().unwrap();
        let manager = Arc::new(SandboxManager::new(
            root.path().to_path_buf(),
            SandboxConfig::default(),
        ));
        let source = root.path().join("report.txt");
        std::fs::write(&source, "report").unwrap();
        let sandbox_path = manager
            .import_file("acc:chat:dm", "msg", "report.txt", &source)
            .unwrap();
        let expected_host = manager.resolve_file("acc:chat:dm", &sandbox_path).unwrap();

        let adapter = Arc::new(FakeAdapter {
            seen: Mutex::new(None),
        });
        let router = ToolRouter::new(
            None,
            Some(Arc::new(SandboxToolBackend::new(
                manager.clone(),
                Some(adapter.clone()),
            ))),
        );
        let request = ToolIpcMessage::Request {
            session_id: "acc:chat:dm".into(),
            tool_call_id: "call-file".into(),
            name: "sandbox_send_file".into(),
            args: json!({ "path": sandbox_path, "caption": "report" }),
            timeout_ms: 1_000,
        };

        let outcome = router.execute(&request, &context()).await;
        assert!(matches!(
            outcome.response,
            ToolIpcMessage::Response { ok: true, .. }
        ));
        let seen = adapter.seen.lock().clone().unwrap();
        assert_eq!(seen["chat_id"], "chat");
        assert_eq!(seen["caption"], "report");
        assert_eq!(
            seen["path"].as_str().unwrap(),
            expected_host.to_string_lossy()
        );
    }

    #[tokio::test]
    async fn sandbox_view_image_returns_base64_and_mime() {
        let root = tempfile::tempdir().unwrap();
        let manager = Arc::new(SandboxManager::new(
            root.path().to_path_buf(),
            SandboxConfig::default(),
        ));
        let source = root.path().join("photo.png");
        std::fs::write(&source, "hello").unwrap();
        let sandbox_path = manager
            .import_file("acc:chat:dm", "m1", "photo.png", &source)
            .unwrap();
        let router = ToolRouter::new(
            None,
            Some(Arc::new(SandboxToolBackend::new(manager, None))),
        );
        let request = ToolIpcMessage::Request {
            session_id: "acc:chat:dm".into(),
            tool_call_id: "call-image".into(),
            name: "sandbox_view_image".into(),
            args: json!({ "path": sandbox_path }),
            timeout_ms: 1_000,
        };

        let outcome = router.execute(&request, &context()).await;
        match outcome.response {
            ToolIpcMessage::Response {
                ok: true,
                result: Some(result),
                ..
            } => {
                assert_eq!(result["mime"], "image/png");
                assert_eq!(result["data"], "aGVsbG8=");
            }
            other => panic!("unexpected response: {other:?}"),
        }
    }

    #[tokio::test]
    #[ignore = "requires a running Docker daemon"]
    async fn router_runs_sandbox_exec_and_timeout() {
        let root = tempfile::tempdir().unwrap();
        let image =
            std::env::var("CHRONO_SANDBOX_TEST_IMAGE").unwrap_or_else(|_| "alpine:latest".into());
        let manager = Arc::new(SandboxManager::new(
            root.path().to_path_buf(),
            SandboxConfig {
                enabled: true,
                image,
                ..SandboxConfig::default()
            },
        ));
        let router = ToolRouter::new(
            None,
            Some(Arc::new(SandboxToolBackend::new(manager.clone(), None))),
        );

        let outcome = router
            .execute(
                &request(json!({ "cmd": "printf hello" }), 10_000),
                &context(),
            )
            .await;
        match outcome.response {
            ToolIpcMessage::Response {
                ok: true,
                result: Some(result),
                ..
            } => {
                assert_eq!(result["exit_code"], 0);
                assert_eq!(result["stdout"], "hello");
            }
            other => panic!("unexpected response: {other:?}"),
        }

        let outcome = router
            .execute(
                &request(json!({ "cmd": "sleep 5", "timeout_ms": 200 }), 10_000),
                &context(),
            )
            .await;
        match outcome.response {
            ToolIpcMessage::Response {
                ok: false,
                error: Some(error),
                ..
            } => assert_eq!(error.code, "sandbox_timeout"),
            other => panic!("unexpected response: {other:?}"),
        }

        manager.shutdown().await;
    }
}
