use std::path::Path;
use std::sync::Arc;

use base64::Engine;

use async_trait::async_trait;
use chrono_config::ConfigStore;
use chrono_ipc::adapter::{PlatformAdapter, PlatformResult};
use chrono_ipc::ToolError;
use chrono_sandbox::{BrowserMode, SandboxConfig, SandboxError, SandboxManager};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::tool_router::{BackendKind, ToolBackend};

const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
const DEFAULT_READ_LINES: usize = 2_000;
const MAX_READ_LINES: usize = 10_000;

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
            "sandbox_read_file" => self.read_file(session_key, args).await,
            "sandbox_write_file" => self.write_file(session_key, args).await,
            "sandbox_edit_file" => self.edit_file(session_key, args).await,
            "sandbox_browser" => self.browse(session_key, args).await,
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

    async fn read_file(
        &self,
        session_key: &str,
        args: &Value,
    ) -> anyhow::Result<PlatformResult> {
        let Some(path) = args.get("path").and_then(Value::as_str) else {
            return Ok(failure("invalid_args", "sandbox_read_file requires { path: '/workspace/...' }"));
        };
        let offset = args
            .get("offset")
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .max(1);
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_READ_LINES as u64)
            .clamp(1, MAX_READ_LINES as u64) as usize;
        let host = match self.manager.resolve_file(session_key, path) {
            Ok(host) => host,
            Err(error) => {
                return Ok(failure(sandbox_error_code(&error), &error.to_string()))
            }
        };
        let metadata = match std::fs::metadata(&host) {
            Ok(metadata) => metadata,
            Err(error) => return Ok(failure("sandbox_error", &error.to_string())),
        };
        if metadata.len() > MAX_READ_BYTES {
            return Ok(failure(
                "file_too_large",
                &format!("file exceeds {MAX_READ_BYTES} bytes; use sandbox_exec for larger files"),
            ));
        }
        let bytes = match std::fs::read(&host) {
            Ok(bytes) => bytes,
            Err(error) => return Ok(failure("sandbox_error", &error.to_string())),
        };
        if bytes.contains(&0) {
            return Ok(failure(
                "binary_file",
                "binary file; use sandbox_view_image or sandbox_exec",
            ));
        }
        let text = match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(_) => {
                return Ok(failure(
                    "binary_file",
                    "file is not valid UTF-8; use sandbox_exec",
                ))
            }
        };
        let total_lines = text.lines().count();
        let lines: Vec<&str> = text
            .lines()
            .skip(offset.saturating_sub(1) as usize)
            .take(limit)
            .collect();
        let start = offset.saturating_sub(1) as usize;
        let truncated = start + lines.len() < total_lines;
        Ok(PlatformResult {
            ok: true,
            result: Some(json!({
                "path": path,
                "text": lines.join("\n"),
                "offset": offset,
                "limit": limit,
                "total_lines": total_lines,
                "truncated": truncated,
            })),
            error: None,
        })
    }

    async fn write_file(
        &self,
        session_key: &str,
        args: &Value,
    ) -> anyhow::Result<PlatformResult> {
        let Some(path) = args.get("path").and_then(Value::as_str) else {
            return Ok(failure("invalid_args", "sandbox_write_file requires { path, content }"));
        };
        let Some(content) = args.get("content").and_then(Value::as_str) else {
            return Ok(failure("invalid_args", "sandbox_write_file requires { path, content }"));
        };
        if content.len() as u64 > chrono_sandbox::MAX_WRITE_BYTES {
            return Ok(failure(
                "file_too_large",
                &format!("content exceeds {} bytes", chrono_sandbox::MAX_WRITE_BYTES),
            ));
        }
        let created = self.manager.resolve_file(session_key, path).is_err();
        match self
            .manager
            .write_workspace_file(session_key, path, content.as_bytes())
        {
            Ok(()) => Ok(PlatformResult {
                ok: true,
                result: Some(json!({
                    "path": path,
                    "bytes": content.len(),
                    "created": created,
                })),
                error: None,
            }),
            Err(error) => Ok(failure(sandbox_error_code(&error), &error.to_string())),
        }
    }

    async fn edit_file(
        &self,
        session_key: &str,
        args: &Value,
    ) -> anyhow::Result<PlatformResult> {
        let (Some(path), Some(old_string), Some(new_string)) = (
            args.get("path").and_then(Value::as_str),
            args.get("old_string").and_then(Value::as_str),
            args.get("new_string").and_then(Value::as_str),
        ) else {
            return Ok(failure(
                "invalid_args",
                "sandbox_edit_file requires { path, old_string, new_string }",
            ));
        };
        if old_string.is_empty() {
            return Ok(failure("invalid_args", "old_string must not be empty"));
        }
        let replace_all = args
            .get("replace_all")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let host = match self.manager.resolve_file(session_key, path) {
            Ok(host) => host,
            Err(error) => {
                return Ok(failure(sandbox_error_code(&error), &error.to_string()))
            }
        };
        let metadata = match std::fs::metadata(&host) {
            Ok(metadata) => metadata,
            Err(error) => return Ok(failure("sandbox_error", &error.to_string())),
        };
        if metadata.len() > chrono_sandbox::MAX_WRITE_BYTES {
            return Ok(failure(
                "file_too_large",
                &format!("file exceeds {} bytes", chrono_sandbox::MAX_WRITE_BYTES),
            ));
        }
        let text = match std::fs::read_to_string(&host) {
            Ok(text) => text,
            Err(_) => return Ok(failure("binary_file", "file is not valid UTF-8")),
        };
        let matches = text.matches(old_string).count();
        if matches == 0 {
            return Ok(failure("edit_no_match", "old_string was not found"));
        }
        if matches > 1 && !replace_all {
            return Ok(failure(
                "edit_not_unique",
                &format!("old_string matched {matches} times; set replace_all=true"),
            ));
        }
        let updated = if replace_all {
            text.replace(old_string, new_string)
        } else {
            text.replacen(old_string, new_string, 1)
        };
        if updated.len() as u64 > chrono_sandbox::MAX_WRITE_BYTES {
            return Ok(failure("file_too_large", "edited file is too large"));
        }
        match self
            .manager
            .write_workspace_file(session_key, path, updated.as_bytes())
        {
            Ok(()) => Ok(PlatformResult {
                ok: true,
                result: Some(json!({
                    "path": path,
                    "replacements": if replace_all { matches } else { 1 },
                    "bytes": updated.len(),
                })),
                error: None,
            }),
            Err(error) => Ok(failure(sandbox_error_code(&error), &error.to_string())),
        }
    }

    async fn browse(
        &self,
        session_key: &str,
        args: &Value,
    ) -> anyhow::Result<PlatformResult> {
        let config = self.manager.config();
        if !config.enabled {
            return Ok(failure("sandbox_unavailable", "sandbox is disabled"));
        }
        if config.browser != BrowserMode::Playwright {
            return Ok(failure(
                "browser_unavailable",
                "browser capability is disabled; set sandbox.browser=playwright",
            ));
        }
        if !config.network {
            return Ok(failure(
                "browser_network_disabled",
                "browser requires sandbox.network=true",
            ));
        }
        let actions = match validate_browser_actions(args) {
            Ok(actions) => actions,
            Err((code, message)) => return Ok(failure(code, &message)),
        };
        let timeout_ms = args
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .map(|value| value.clamp(1_000, chrono_sandbox::MAX_TIMEOUT_MS))
            .unwrap_or(config.timeout_ms.min(chrono_sandbox::MAX_TIMEOUT_MS));
        let include_image = args
            .get("include_image")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let nonce = Uuid::new_v4();
        let helper_source = std::env::temp_dir().join(format!("chrono-browser-{nonce}.cjs"));
        let job_source = std::env::temp_dir().join(format!("chrono-browser-{nonce}.json"));
        if let Err(error) = std::fs::write(&helper_source, include_str!("browser_helper.cjs")) {
            return Ok(failure("browser_failed", &error.to_string()));
        }
        let job = json!({
            "actions": actions,
            "timeout_ms": timeout_ms,
            "playwright_path": config.browser_playwright_path,
            "browsers_path": config.browser_browsers_path,
        });
        if let Err(error) = std::fs::write(&job_source, serde_json::to_vec(&job)?) {
            let _ = std::fs::remove_file(&helper_source);
            return Ok(failure("browser_failed", &error.to_string()));
        }

        let helper_path = match self.manager.import_file(
            session_key,
            "browser",
            "browser-run.cjs",
            &helper_source,
        ) {
            Ok(path) => path,
            Err(error) => {
                let _ = std::fs::remove_file(&helper_source);
                let _ = std::fs::remove_file(&job_source);
                return Ok(failure(sandbox_error_code(&error), &error.to_string()));
            }
        };
        let job_name = format!("job-{nonce}.json");
        let job_path = match self.manager.import_file(
            session_key,
            "browser",
            &job_name,
            &job_source,
        ) {
            Ok(path) => path,
            Err(error) => {
                let _ = std::fs::remove_file(&job_source);
                return Ok(failure(sandbox_error_code(&error), &error.to_string()));
            }
        };

        let node_bin = if config.browser_node.trim().is_empty() {
            "node"
        } else {
            config.browser_node.trim()
        };
        let command = format!(
            "{} {} {}",
            shell_quote(node_bin),
            shell_quote(&helper_path),
            shell_quote(&job_path)
        );
        let output = match self
            .manager
            .exec(
                session_key,
                &command,
                None,
                Some(timeout_ms.saturating_add(5_000)),
            )
            .await
        {
            Ok(output) => output,
            Err(error) => return Ok(failure(sandbox_error_code(&error), &error.to_string())),
        };

        let parsed: Value = match serde_json::from_str(output.stdout.trim()) {
            Ok(value) => value,
            Err(error) => {
                let detail = if output.stderr.trim().is_empty() {
                    format!("helper returned invalid JSON: {error}")
                } else {
                    format!(
                        "helper returned invalid JSON: {error}; stderr: {}",
                        output.stderr.trim()
                    )
                };
                return Ok(failure("browser_failed", &detail));
            }
        };
        if parsed.get("ok").and_then(Value::as_bool) != Some(true) {
            let code = parsed
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("browser_failed");
            let message = parsed
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("browser action failed");
            return Ok(failure(code, message));
        }

        let mut result = parsed;
        if include_image {
            if let Some(path) = result
                .get("screenshots")
                .and_then(Value::as_array)
                .and_then(|screenshots| screenshots.first())
                .and_then(Value::as_str)
            {
                match self.image_payload(session_key, path) {
                    Ok((mime, data)) => {
                        result["image"] = json!({ "mime": mime, "data": data });
                    }
                    Err(message) => {
                        result["image_error"] = Value::String(message);
                    }
                }
            }
        }
        Ok(PlatformResult {
            ok: true,
            result: Some(result),
            error: None,
        })
    }

    fn image_payload(
        &self,
        session_key: &str,
        path: &str,
    ) -> Result<(&'static str, String), String> {
        let host = self
            .manager
            .resolve_file(session_key, path)
            .map_err(|error| error.to_string())?;
        let mime = image_mime(&host).ok_or_else(|| "screenshot is not a supported image".to_string())?;
        let metadata = std::fs::metadata(&host).map_err(|error| error.to_string())?;
        if metadata.len() > chrono_sandbox::MAX_IMAGE_BYTES {
            return Err(format!(
                "screenshot exceeds {} bytes",
                chrono_sandbox::MAX_IMAGE_BYTES
            ));
        }
        let bytes = std::fs::read(&host).map_err(|error| error.to_string())?;
        Ok((
            mime,
            base64::engine::general_purpose::STANDARD.encode(bytes),
        ))
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

fn validate_browser_actions(args: &Value) -> Result<Vec<Value>, (&'static str, String)> {
    const MAX_ACTIONS: usize = 50;
    let actions = args
        .get("actions")
        .and_then(Value::as_array)
        .ok_or(("invalid_args", "sandbox_browser requires { actions: [...] }".to_string()))?;
    if actions.is_empty() || actions.len() > MAX_ACTIONS {
        return Err((
            "invalid_args",
            format!("actions must contain 1..={MAX_ACTIONS} entries"),
        ));
    }
    if let Some(timeout) = args.get("timeout_ms") {
        if !timeout.is_u64() {
            return Err(("invalid_args", "timeout_ms must be a positive integer".into()));
        }
    }
    if let Some(include_image) = args.get("include_image") {
        if !include_image.is_boolean() {
            return Err(("invalid_args", "include_image must be a boolean".into()));
        }
    }

    for (index, action) in actions.iter().enumerate() {
        let object = action
            .as_object()
            .ok_or_else(|| ("invalid_args", format!("action {index} must be an object")))?;
        let kind = object
            .get("action")
            .and_then(Value::as_str)
            .ok_or_else(|| ("invalid_args", format!("action {index} requires a string action")))?;
        match kind {
            "goto" => {
                let raw = object
                    .get("url")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ("invalid_args", format!("goto {index} requires url")))?;
                validate_browser_url(raw).map_err(|(code, message)| (code, format!("goto {index}: {message}")))?;
            }
            "click" | "wait_for" | "fill" => {
                object
                    .get("selector")
                    .and_then(Value::as_str)
                    .filter(|selector| !selector.trim().is_empty())
                    .ok_or_else(|| ("invalid_args", format!("{kind} {index} requires selector")))?;
                if kind == "fill" && object.get("value").and_then(Value::as_str).is_none() {
                    return Err(("invalid_args", format!("fill {index} requires value")));
                }
            }
            "extract" => {
                if let Some(selector) = object.get("selector") {
                    if !selector.is_string() {
                        return Err(("invalid_args", format!("extract {index} selector must be a string")));
                    }
                }
            }
            "screenshot" => {
                if let Some(path) = object.get("path") {
                    let path = path
                        .as_str()
                        .ok_or_else(|| ("invalid_args", format!("screenshot {index} path must be a string")))?;
                    validate_workspace_path(path)
                        .map_err(|message| ("invalid_args", format!("screenshot {index}: {message}")))?;
                }
                if let Some(full_page) = object.get("full_page") {
                    if !full_page.is_boolean() {
                        return Err(("invalid_args", format!("screenshot {index} full_page must be a boolean")));
                    }
                }
            }
            "wait" => {
                if let Some(ms) = object.get("ms") {
                    let ms = ms
                        .as_u64()
                        .ok_or_else(|| ("invalid_args", format!("wait {index} ms must be a positive integer")))?;
                    if ms == 0 || ms > 30_000 {
                        return Err(("invalid_args", format!("wait {index} ms must be 1..=30000")));
                    }
                }
            }
            other => {
                return Err((
                    "invalid_args",
                    format!("action {index} is unsupported: {other}"),
                ))
            }
        }
    }
    Ok(actions.clone())
}

fn validate_browser_url(raw: &str) -> Result<(), (&'static str, String)> {
    let url = url::Url::parse(raw)
        .map_err(|error| ("invalid_url", format!("invalid URL: {error}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(("invalid_url", "only http(s) URLs are allowed".into()));
    }
    match url.host() {
        Some(url::Host::Domain(host)) => {
            let host = host.to_ascii_lowercase();
            if host == "localhost"
                || host.ends_with(".localhost")
                || host.ends_with(".local")
                || host == "metadata.google.internal"
            {
                return Err(("blocked_url", format!("blocked host: {host}")));
            }
        }
        Some(url::Host::Ipv4(ip)) if is_private_v4(ip) => {
            return Err(("blocked_url", format!("blocked address: {ip}")));
        }
        Some(url::Host::Ipv6(ip)) if is_private_v6(ip) => {
            return Err(("blocked_url", format!("blocked address: {ip}")));
        }
        Some(_) => {}
        None => return Err(("invalid_url", "URL has no host".into())),
    }
    Ok(())
}

fn is_private_v4(ip: std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_broadcast()
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19))
}

fn is_private_v6(ip: std::net::Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_private_v4(v4);
    }
    let segments = ip.segments();
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
}

fn validate_workspace_path(path: &str) -> Result<(), String> {
    if !path.starts_with("/workspace/")
        || path.split('/').any(|segment| segment == "..")
        || path.contains('\0')
    {
        return Err("path must stay under /workspace/".into());
    }
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
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
        browser: match string_setting(store, "sandbox.browser", "none").as_str() {
            "playwright" => BrowserMode::Playwright,
            _ => BrowserMode::None,
        },
        browser_node: non_empty_string_setting(
            store,
            "sandbox.browser_node",
            &default.browser_node,
        ),
        browser_playwright_path: non_empty_string_setting(
            store,
            "sandbox.browser_playwright_path",
            &default.browser_playwright_path,
        ),
        browser_browsers_path: non_empty_string_setting(
            store,
            "sandbox.browser_browsers_path",
            &default.browser_browsers_path,
        ),
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

fn non_empty_string_setting(store: &ConfigStore, key: &str, default: &str) -> String {
    let value = string_setting(store, key, default);
    if value.trim().is_empty() {
        default.to_string()
    } else {
        value
    }
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

    #[test]
    fn browser_url_validation_blocks_private_hosts() {
        assert!(validate_browser_url("https://example.com").is_ok());
        assert!(validate_browser_url("http://example.com/path").is_ok());
        for url in [
            "file:///etc/passwd",
            "http://localhost:8080",
            "http://127.0.0.1",
            "http://10.0.0.1",
            "http://192.168.1.1",
            "http://169.254.169.254",
            "http://[::1]/",
            "http://metadata.google.internal",
        ] {
            assert!(validate_browser_url(url).is_err(), "should block {url}");
        }
    }

    #[test]
    fn browser_action_validation_rejects_bad_shapes() {
        assert!(validate_browser_actions(&json!({
            "actions": [
                { "action": "goto", "url": "https://example.com" },
                { "action": "screenshot", "path": "/workspace/shot.png", "full_page": true }
            ]
        }))
        .is_ok());
        assert!(validate_browser_actions(&json!({ "actions": [] })).is_err());
        assert!(validate_browser_actions(&json!({
            "actions": [{ "action": "click" }]
        }))
        .is_err());
        assert!(validate_browser_actions(&json!({
            "actions": [{ "action": "screenshot", "path": "/etc/passwd" }]
        }))
        .is_err());
        assert!(validate_browser_actions(&json!({
            "actions": [{ "action": "goto", "url": "file:///etc/passwd" }]
        }))
        .is_err());
    }

    #[test]
    fn browser_screenshot_payload_reads_workspace_image() {
        let root = tempfile::tempdir().unwrap();
        let manager = Arc::new(SandboxManager::new(
            root.path().to_path_buf(),
            SandboxConfig::default(),
        ));
        let source = root.path().join("shot.png");
        std::fs::write(&source, "hello").unwrap();
        let path = manager
            .import_file("acc:chat:dm", "browser", "shot.png", &source)
            .unwrap();
        let backend = SandboxToolBackend::new(manager, None);
        let (mime, data) = backend.image_payload("acc:chat:dm", &path).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(data, "aGVsbG8=");
    }

    #[tokio::test]
    async fn browser_rejects_disabled_capability_and_network() {
        let root = tempfile::tempdir().unwrap();
        let disabled = Arc::new(SandboxManager::new(
            root.path().to_path_buf(),
            SandboxConfig {
                enabled: true,
                image: "example.invalid".into(),
                browser: BrowserMode::None,
                network: true,
                ..SandboxConfig::default()
            },
        ));
        let backend = SandboxToolBackend::new(disabled, None);
        let result = backend
            .browse(
                "acc:chat:dm",
                &json!({ "actions": [{ "action": "goto", "url": "https://example.com" }] }),
            )
            .await
            .unwrap();
        assert!(!result.ok);
        assert_eq!(result.error.unwrap().code, "browser_unavailable");

        let offline = Arc::new(SandboxManager::new(
            root.path().to_path_buf(),
            SandboxConfig {
                enabled: true,
                image: "example.invalid".into(),
                browser: BrowserMode::Playwright,
                network: false,
                ..SandboxConfig::default()
            },
        ));
        let backend = SandboxToolBackend::new(offline, None);
        let result = backend
            .browse(
                "acc:chat:dm",
                &json!({ "actions": [{ "action": "goto", "url": "https://example.com" }] }),
            )
            .await
            .unwrap();
        assert!(!result.ok);
        assert_eq!(result.error.unwrap().code, "browser_network_disabled");
    }

    #[tokio::test]
    #[ignore = "requires a running Docker daemon"]
    async fn browser_reports_missing_node_without_panicking() {
        let root = tempfile::tempdir().unwrap();
        let image =
            std::env::var("CHRONO_SANDBOX_TEST_IMAGE").unwrap_or_else(|_| "alpine:latest".into());
        let manager = Arc::new(SandboxManager::new(
            root.path().to_path_buf(),
            SandboxConfig {
                enabled: true,
                image,
                browser: BrowserMode::Playwright,
                network: true,
                ..SandboxConfig::default()
            },
        ));
        let backend = SandboxToolBackend::new(manager, None);
        let result = backend
            .browse(
                "acc:chat:dm",
                &json!({ "actions": [{ "action": "goto", "url": "https://example.com" }] }),
            )
            .await
            .unwrap();
        assert!(!result.ok);
        assert_eq!(result.error.unwrap().code, "browser_failed");
    }

    #[tokio::test]
    async fn file_tools_write_read_and_edit_workspace_files() {
        let root = tempfile::tempdir().unwrap();
        let manager = Arc::new(SandboxManager::new(
            root.path().to_path_buf(),
            SandboxConfig::default(),
        ));
        let backend = SandboxToolBackend::new(manager, None);
        let path = "/workspace/notes/demo.txt";

        let written = backend
            .write_file(
                "acc:chat:dm",
                &json!({ "path": path, "content": "alpha\nbeta\nalpha\n" }),
            )
            .await
            .unwrap();
        assert!(written.ok);
        assert_eq!(written.result.unwrap()["created"], true);

        let read = backend
            .read_file(
                "acc:chat:dm",
                &json!({ "path": path, "offset": 2, "limit": 1 }),
            )
            .await
            .unwrap();
        assert!(read.ok);
        let read = read.result.unwrap();
        assert_eq!(read["text"], "beta");
        assert_eq!(read["total_lines"], 3);
        assert_eq!(read["truncated"], true);

        let edited = backend
            .edit_file(
                "acc:chat:dm",
                &json!({ "path": path, "old_string": "beta", "new_string": "BETA" }),
            )
            .await
            .unwrap();
        assert!(edited.ok);

        let not_unique = backend
            .edit_file(
                "acc:chat:dm",
                &json!({ "path": path, "old_string": "alpha", "new_string": "A" }),
            )
            .await
            .unwrap();
        assert!(!not_unique.ok);
        assert_eq!(not_unique.error.unwrap().code, "edit_not_unique");

        let replaced = backend
            .edit_file(
                "acc:chat:dm",
                &json!({ "path": path, "old_string": "alpha", "new_string": "A", "replace_all": true }),
            )
            .await
            .unwrap();
        assert!(replaced.ok);

        let final_read = backend
            .read_file("acc:chat:dm", &json!({ "path": path }))
            .await
            .unwrap()
            .result
            .unwrap();
        assert_eq!(final_read["text"], "A\nBETA\nA");
    }

    #[tokio::test]
    async fn write_file_rejects_paths_outside_workspace() {
        let root = tempfile::tempdir().unwrap();
        let manager = Arc::new(SandboxManager::new(
            root.path().to_path_buf(),
            SandboxConfig::default(),
        ));
        let backend = SandboxToolBackend::new(manager, None);
        let result = backend
            .write_file(
                "acc:chat:dm",
                &json!({ "path": "/workspace/../escape.txt", "content": "x" }),
            )
            .await
            .unwrap();
        assert!(!result.ok);
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
