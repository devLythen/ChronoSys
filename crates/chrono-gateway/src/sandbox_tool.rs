use std::sync::Arc;

use async_trait::async_trait;
use chrono_config::ConfigStore;
use chrono_ipc::adapter::PlatformResult;
use chrono_ipc::ToolError;
use chrono_sandbox::{SandboxConfig, SandboxError, SandboxManager};
use serde_json::{json, Value};

use crate::tool_router::{BackendKind, ToolBackend};

/// `sandbox_exec` backend. The tool schema lives in agent-host; this layer
/// validates arguments and maps the sandbox result into the IPC envelope.
pub struct SandboxToolBackend {
    manager: Arc<SandboxManager>,
}

impl SandboxToolBackend {
    pub fn new(manager: Arc<SandboxManager>) -> Self {
        Self { manager }
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
        tool_name: &str,
        args: &Value,
    ) -> anyhow::Result<PlatformResult> {
        if tool_name != "sandbox_exec" {
            return Ok(failure(
                "unsupported",
                &format!("unsupported sandbox tool: {tool_name}"),
            ));
        }

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
            Err(error) => {
                let code = match &error {
                    SandboxError::Disabled => "sandbox_disabled",
                    SandboxError::NotConfigured => "sandbox_not_configured",
                    SandboxError::InvalidConfig(_) => "sandbox_invalid_config",
                    SandboxError::InvalidWorkdir(_) => "sandbox_invalid_workdir",
                    SandboxError::Timeout(_) => "sandbox_timeout",
                    SandboxError::Docker(_) | SandboxError::Io(_) => "sandbox_error",
                };
                Ok(failure(code, &error.to_string()))
            }
        }
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
    use chrono_ipc::ToolIpcMessage;
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
            Some(Arc::new(SandboxToolBackend::new(manager.clone()))),
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
