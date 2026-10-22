//! Ephemeral Docker sandboxes managed by the Rust gateway.
//!
//! One container per conversation session, a bind-mounted workspace under
//! `$CHRONO_HOME/sandboxes/<slug>`, no network by default, and a hard wall
//! clock around every `docker exec`. The agent never talks to Docker: the
//! gateway exposes this as the `sandbox_exec` tool.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use parking_lot::{Mutex, RwLock};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

/// Hard cap on one `sandbox_exec` call. The IPC router allows 300 s, leaving
/// a 5 s margin so a sandbox timeout is returned instead of racing IPC.
pub const MAX_TIMEOUT_MS: u64 = 295_000;
/// Per-stream capture cap. Output beyond this is drained and discarded.
pub const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
/// Telegram Bot API document limit, also used for workspace file transfer.
pub const MAX_ATTACHMENT_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct SandboxConfig {
    pub enabled: bool,
    pub image: String,
    pub network: bool,
    pub timeout_ms: u64,
    pub memory_mb: u64,
    pub cpus: f64,
    pub pids_limit: u64,
    pub idle_secs: u64,
    pub max_lifetime_secs: u64,
    pub destroy_on_new: bool,
}

impl Default for SandboxConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            image: String::new(),
            network: false,
            timeout_ms: 30_000,
            memory_mb: 512,
            cpus: 1.0,
            pids_limit: 256,
            idle_secs: 300,
            max_lifetime_secs: 0,
            destroy_on_new: true,
        }
    }
}

impl SandboxConfig {
    pub fn validate(&self) -> Result<(), SandboxError> {
        if self.image.trim().is_empty() {
            return Err(SandboxError::NotConfigured);
        }
        if self.timeout_ms == 0 || self.timeout_ms > MAX_TIMEOUT_MS {
            return Err(SandboxError::InvalidConfig(format!(
                "timeout_ms must be 1..={MAX_TIMEOUT_MS}"
            )));
        }
        if !(16..=65_536).contains(&self.memory_mb) {
            return Err(SandboxError::InvalidConfig(
                "memory_mb must be 16..=65536".into(),
            ));
        }
        if !self.cpus.is_finite() || !(0.1..=64.0).contains(&self.cpus) {
            return Err(SandboxError::InvalidConfig("cpus must be 0.1..=64".into()));
        }
        if !(16..=65_536).contains(&self.pids_limit) {
            return Err(SandboxError::InvalidConfig(
                "pids_limit must be 16..=65536".into(),
            ));
        }
        if self.idle_secs > 31_536_000 || self.max_lifetime_secs > 31_536_000 {
            return Err(SandboxError::InvalidConfig(
                "sandbox timers must be <= 31536000 seconds".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SandboxError {
    #[error("sandbox is disabled")]
    Disabled,
    #[error("sandbox image is not configured")]
    NotConfigured,
    #[error("invalid sandbox config: {0}")]
    InvalidConfig(String),
    #[error("sandbox is being reset")]
    Resetting,
    #[error("invalid sandbox workdir: {0}")]
    InvalidWorkdir(String),
    #[error("invalid sandbox file path: {0}")]
    InvalidFile(String),
    #[error("sandbox file not found: {0}")]
    FileNotFound(String),
    #[error("file is outside the session workspace: {0}")]
    FileOutsideWorkspace(String),
    #[error("file exceeds the {0} byte limit")]
    FileTooLarge(u64),
    #[error("sandbox command timed out after {0} ms")]
    Timeout(u64),
    #[error("docker: {0}")]
    Docker(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Clone, Debug, PartialEq)]
pub struct ExecOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}

struct Session {
    key: String,
    slug: String,
    name: String,
    workspace: PathBuf,
}

#[derive(Clone, Copy)]
struct SessionState {
    created_at: Instant,
    last_used: Instant,
}

pub struct SandboxManager {
    /// `$CHRONO_HOME`; workspaces live under `<root>/sandboxes/<slug>`.
    root: PathBuf,
    config: RwLock<SandboxConfig>,
    sessions: Mutex<HashMap<String, SessionState>>,
    generations: Mutex<HashMap<String, u64>>,
    destroying: Mutex<HashSet<String>>,
    home_tag: String,
}

impl SandboxManager {
    pub fn new(chrono_home: PathBuf, config: SandboxConfig) -> Self {
        let root = chrono_home.canonicalize().unwrap_or(chrono_home);
        let home_tag = format!("{:016x}", fnv1a64(root.to_string_lossy().as_ref()));
        Self {
            root,
            config: RwLock::new(config),
            sessions: Mutex::new(HashMap::new()),
            generations: Mutex::new(HashMap::new()),
            destroying: Mutex::new(HashSet::new()),
            home_tag,
        }
    }

    pub fn update_config(&self, config: SandboxConfig) {
        *self.config.write() = config;
    }

    pub fn config(&self) -> SandboxConfig {
        self.config.read().clone()
    }

    /// Monotonic generation for a route; bumped whenever the container or
    /// workspace is destroyed. In-flight imports compare this to detect
    /// `/new` or a manual reset racing with an upload.
    pub fn generation(&self, session_key: &str) -> u64 {
        *self.generations.lock().get(session_key).unwrap_or(&0)
    }

    fn invalidate(&self, session_key: &str) {
        *self
            .generations
            .lock()
            .entry(session_key.to_string())
            .or_insert(0) += 1;
    }

    pub async fn exec(
        &self,
        session_key: &str,
        command: &str,
        cwd: Option<&str>,
        timeout_ms: Option<u64>,
    ) -> Result<ExecOutput, SandboxError> {
        let config = self.config();
        if !config.enabled {
            return Err(SandboxError::Disabled);
        }
        config.validate()?;
        if command.trim().is_empty() {
            return Err(SandboxError::InvalidConfig("cmd must not be empty".into()));
        }
        let workdir = container_workdir(cwd)?;
        let session = self.session(session_key);
        self.wait_for_reset(&session.key).await;
        create_workspace(&session.workspace)?;

        if self.lifetime_expired(&config, &session.key) {
            let _ = self.remove_container(&session).await;
            self.sessions.lock().remove(&session.key);
            self.invalidate(&session.key);
        }

        self.ensure_container(&config, &session).await?;
        {
            let now = Instant::now();
            let mut sessions = self.sessions.lock();
            sessions
                .entry(session.key.clone())
                .and_modify(|state| state.last_used = now)
                .or_insert(SessionState {
                    created_at: now,
                    last_used: now,
                });
        }

        let timeout = timeout_ms
            .unwrap_or(config.timeout_ms)
            .clamp(1, MAX_TIMEOUT_MS);

        match self.run_exec(&session, command, &workdir, timeout).await {
            Ok(output) => Ok(output),
            Err(SandboxError::Timeout(ms)) => {
                // Killing `docker exec` is not enough: the command keeps
                // running inside the container. Destroy the container.
                let _ = self.remove_container(&session).await;
                self.sessions.lock().remove(&session.key);
                self.invalidate(&session.key);
                Err(SandboxError::Timeout(ms))
            }
            Err(error) => Err(error),
        }
    }

    pub async fn destroy(&self, session_key: &str) -> Result<(), SandboxError> {
        let session = self.session(session_key);
        if !self.destroying.lock().insert(session.key.clone()) {
            return Ok(());
        }
        self.invalidate(&session.key);
        let result = self.remove_container(&session).await;
        if session.workspace.exists() {
            if let Err(error) = tokio::fs::remove_dir_all(&session.workspace).await {
                eprintln!(
                    "[sandbox] failed to remove workspace {}: {error}",
                    session.workspace.display()
                );
            }
        }
        self.sessions.lock().remove(&session.key);
        self.destroying.lock().remove(&session.key);
        result
    }

    async fn wait_for_reset(&self, session_key: &str) {
        while self.destroying.lock().contains(session_key) {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    /// Resolve a `/workspace/...` path to the host file inside this session's
    /// workspace. Rejects traversal, symlink escapes, missing files, and files
    /// above the upload limit.
    pub fn resolve_file(
        &self,
        session_key: &str,
        sandbox_path: &str,
    ) -> Result<PathBuf, SandboxError> {
        let session = self.session(session_key);
        if self.destroying.lock().contains(&session.key) {
            return Err(SandboxError::Resetting);
        }
        let relative = sandbox_relative_path(sandbox_path)?;
        let workspace = std::fs::canonicalize(&session.workspace)
            .map_err(|_| SandboxError::FileNotFound(sandbox_path.to_string()))?;
        let candidate = workspace.join(relative);
        let canonical = std::fs::canonicalize(&candidate)
            .map_err(|_| SandboxError::FileNotFound(sandbox_path.to_string()))?;
        if !canonical.starts_with(&workspace) {
            return Err(SandboxError::FileOutsideWorkspace(sandbox_path.into()));
        }
        let metadata = std::fs::metadata(&canonical)?;
        if !metadata.is_file() {
            return Err(SandboxError::FileNotFound(sandbox_path.into()));
        }
        if metadata.len() > MAX_ATTACHMENT_BYTES {
            return Err(SandboxError::FileTooLarge(MAX_ATTACHMENT_BYTES));
        }
        Ok(canonical)
    }

    /// Move an adapter-staged file into the session workspace and return the
    /// path the agent should use (`/workspace/upload/<message>/<name>`).
    pub fn import_file(
        &self,
        session_key: &str,
        message_id: &str,
        name: &str,
        source: &Path,
    ) -> Result<String, SandboxError> {
        let metadata = std::fs::metadata(source)?;
        if !metadata.is_file() {
            return Err(SandboxError::FileNotFound(
                source.to_string_lossy().to_string(),
            ));
        }
        if metadata.len() > MAX_ATTACHMENT_BYTES {
            return Err(SandboxError::FileTooLarge(MAX_ATTACHMENT_BYTES));
        }
        let session = self.session(session_key);
        if self.destroying.lock().contains(&session.key) {
            return Err(SandboxError::Resetting);
        }
        let message_dir = safe_component(message_id, "message");
        let file_name = safe_filename(name);
        let upload_dir = session.workspace.join("upload").join(&message_dir);
        std::fs::create_dir_all(&upload_dir)?;
        let destination = upload_dir.join(&file_name);
        if std::fs::rename(source, &destination).is_err() {
            std::fs::copy(source, &destination)?;
            let _ = std::fs::remove_file(source);
        }
        Ok(format!("/workspace/upload/{message_dir}/{file_name}"))
    }

    fn lifetime_expired(&self, config: &SandboxConfig, key: &str) -> bool {
        if config.max_lifetime_secs == 0 {
            return false;
        }
        self.sessions
            .lock()
            .get(key)
            .map(|state| {
                state.created_at.elapsed() >= Duration::from_secs(config.max_lifetime_secs)
            })
            .unwrap_or(false)
    }

    /// Remove containers idle for longer than `idle_secs` or older than
    /// `max_lifetime_secs`. `0` disables the respective timer.
    /// Disabling the sandbox reaps every live container on the next pass.
    pub async fn reap_idle(&self) {
        let config = self.config();
        if !config.enabled {
            self.shutdown().await;
            return;
        }
        let idle_cutoff = (config.idle_secs > 0)
            .then(|| Instant::now() - Duration::from_secs(config.idle_secs));
        let lifetime = (config.max_lifetime_secs > 0)
            .then(|| Duration::from_secs(config.max_lifetime_secs));
        if idle_cutoff.is_none() && lifetime.is_none() {
            return;
        }
        let now = Instant::now();
        let stale: Vec<String> = self
            .sessions
            .lock()
            .iter()
            .filter(|(_, state)| {
                idle_cutoff.is_some_and(|cutoff| state.last_used < cutoff)
                    || lifetime.is_some_and(|max| now.duration_since(state.created_at) >= max)
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in stale {
            if let Err(error) = self.destroy(&key).await {
                eprintln!("[sandbox] idle cleanup failed for {key}: {error}");
            }
        }
    }

    /// Remove every managed container for this `CHRONO_HOME`, including
    /// orphans left by an unclean shutdown.
    pub async fn cleanup_orphans(&self) -> Result<(), SandboxError> {
        let filter_home = format!("label=chrono.home={}", self.home_tag);
        let output = Command::new("docker")
            .args([
                "ps",
                "-aq",
                "--filter",
                "label=chrono.managed=1",
                "--filter",
                &filter_home,
            ])
            .stdin(Stdio::null())
            .output()
            .await?;
        if !output.status.success() {
            return Err(SandboxError::Docker(stderr(&output)));
        }
        let ids: Vec<String> = String::from_utf8_lossy(&output.stdout)
            .split_whitespace()
            .map(ToOwned::to_owned)
            .collect();
        if !ids.is_empty() {
            let mut args = vec!["rm".to_string(), "-f".to_string()];
            args.extend(ids);
            self.docker_ok(&args).await?;
        }
        Ok(())
    }

    pub async fn shutdown(&self) {
        let keys: Vec<String> = self.sessions.lock().keys().cloned().collect();
        for key in keys {
            if let Err(error) = self.destroy(&key).await {
                eprintln!("[sandbox] shutdown cleanup failed for {key}: {error}");
            }
        }
    }

    fn session(&self, key: &str) -> Session {
        let slug = session_slug(key);
        Session {
            key: key.to_string(),
            name: format!("chrono-sandbox-{slug}"),
            workspace: self.root.join("sandboxes").join(&slug),
            slug,
        }
    }

    async fn ensure_container(
        &self,
        config: &SandboxConfig,
        session: &Session,
    ) -> Result<(), SandboxError> {
        let running = self
            .docker_capture(&[
                "inspect".into(),
                "--format".into(),
                "{{.State.Running}}".into(),
                session.name.clone(),
            ])
            .await;
        if matches!(running, Ok(ref value) if value.trim() == "true") {
            return Ok(());
        }

        let exists = self
            .docker_capture(&[
                "inspect".into(),
                "--format".into(),
                "{{.Id}}".into(),
                session.name.clone(),
            ])
            .await
            .is_ok();
        if exists {
            self.docker_ok(&["start".into(), session.name.clone()])
                .await?;
            return Ok(());
        }

        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        let workspace = session.workspace.to_string_lossy().to_string();
        let args: Vec<String> = vec![
            "create".into(),
            "--name".into(),
            session.name.clone(),
            "--label".into(),
            "chrono.managed=1".into(),
            "--label".into(),
            format!("chrono.home={}", self.home_tag),
            "--label".into(),
            format!("chrono.session={}", session.slug),
            "--network".into(),
            if config.network {
                "bridge".into()
            } else {
                "none".into()
            },
            "--memory".into(),
            format!("{}m", config.memory_mb),
            "--cpus".into(),
            format!("{}", config.cpus),
            "--pids-limit".into(),
            config.pids_limit.to_string(),
            "--cap-drop".into(),
            "ALL".into(),
            "--security-opt".into(),
            "no-new-privileges".into(),
            "--read-only".into(),
            "--tmpfs".into(),
            "/tmp:rw,nosuid,nodev,size=64m,mode=1777".into(),
            "--mount".into(),
            format!("type=bind,source={workspace},target=/workspace"),
            "--workdir".into(),
            "/workspace".into(),
            "--user".into(),
            format!("{uid}:{gid}"),
            "--entrypoint".into(),
            "/bin/sh".into(),
            config.image.clone(),
            "-c".into(),
            "trap 'exit 0' TERM INT; while :; do sleep 3600; done".into(),
        ];
        self.docker_ok(&args).await?;
        self.docker_ok(&["start".into(), session.name.clone()])
            .await?;
        Ok(())
    }

    async fn run_exec(
        &self,
        session: &Session,
        command: &str,
        workdir: &str,
        timeout_ms: u64,
    ) -> Result<ExecOutput, SandboxError> {
        let mut child = Command::new("docker")
            .args([
                "exec",
                "--workdir",
                workdir,
                "--env",
                "HOME=/tmp",
                "--env",
                "TMPDIR=/tmp",
                &session.name,
                "/bin/sh",
                "-lc",
                command,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| SandboxError::Docker("missing stdout pipe".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| SandboxError::Docker("missing stderr pipe".into()))?;
        let stdout_task = tokio::spawn(read_capped(stdout, MAX_OUTPUT_BYTES));
        let stderr_task = tokio::spawn(read_capped(stderr, MAX_OUTPUT_BYTES));

        let status =
            match tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait()).await {
                Ok(result) => result?,
                Err(_) => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    stdout_task.abort();
                    stderr_task.abort();
                    return Err(SandboxError::Timeout(timeout_ms));
                }
            };

        let (stdout, stdout_truncated) = stdout_task
            .await
            .map_err(|e| SandboxError::Docker(format!("stdout task: {e}")))??;
        let (stderr, stderr_truncated) = stderr_task
            .await
            .map_err(|e| SandboxError::Docker(format!("stderr task: {e}")))??;

        Ok(ExecOutput {
            exit_code: status.code().unwrap_or(-1),
            stdout,
            stderr,
            truncated: stdout_truncated || stderr_truncated,
        })
    }

    async fn remove_container(&self, session: &Session) -> Result<(), SandboxError> {
        let output = Command::new("docker")
            .args(["rm", "-f", &session.name])
            .stdin(Stdio::null())
            .output()
            .await?;
        if output.status.success() {
            return Ok(());
        }
        let message = stderr(&output);
        if message.contains("No such container") {
            return Ok(());
        }
        Err(SandboxError::Docker(message))
    }

    async fn docker_capture(&self, args: &[String]) -> Result<String, SandboxError> {
        let output = Command::new("docker")
            .args(args)
            .stdin(Stdio::null())
            .output()
            .await?;
        if !output.status.success() {
            return Err(SandboxError::Docker(stderr(&output)));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    async fn docker_ok(&self, args: &[String]) -> Result<(), SandboxError> {
        self.docker_capture(args).await.map(|_| ())
    }
}

fn create_workspace(path: &Path) -> Result<(), SandboxError> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn sandbox_relative_path(sandbox_path: &str) -> Result<PathBuf, SandboxError> {
    let rest = sandbox_path
        .strip_prefix("/workspace/")
        .ok_or_else(|| SandboxError::InvalidFile(sandbox_path.to_string()))?;
    let path = Path::new(rest);
    let mut relative = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => relative.push(part),
            _ => return Err(SandboxError::InvalidFile(sandbox_path.to_string())),
        }
    }
    if relative.as_os_str().is_empty() {
        return Err(SandboxError::InvalidFile(sandbox_path.to_string()));
    }
    Ok(relative)
}

fn safe_component(raw: &str, fallback: &str) -> String {
    let mut out = String::with_capacity(raw.len().min(64));
    for character in raw.chars().take(64) {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            out.push(character);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('.');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn safe_filename(raw: &str) -> String {
    let name = Path::new(raw)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment");
    let sanitized = safe_component(name, "attachment");
    if sanitized.len() > 120 {
        sanitized[..120].to_string()
    } else {
        sanitized
    }
}

fn container_workdir(cwd: Option<&str>) -> Result<String, SandboxError> {
    let Some(cwd) = cwd.filter(|value| !value.trim().is_empty()) else {
        return Ok("/workspace".into());
    };
    let path = Path::new(cwd);
    if path.is_absolute() {
        return Err(SandboxError::InvalidWorkdir(cwd.to_string()));
    }
    let mut relative = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => relative.push(part),
            _ => return Err(SandboxError::InvalidWorkdir(cwd.to_string())),
        }
    }
    if relative.as_os_str().is_empty() {
        return Ok("/workspace".into());
    }
    Ok(format!("/workspace/{}", relative.to_string_lossy()))
}

fn stderr(output: &std::process::Output) -> String {
    let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if message.is_empty() {
        format!("exit status {}", output.status)
    } else {
        message
    }
}

async fn read_capped<R: AsyncRead + Unpin>(
    mut reader: R,
    cap: usize,
) -> std::io::Result<(String, bool)> {
    let mut buffer = [0u8; 8192];
    let mut output = Vec::with_capacity(cap.min(8192));
    let mut truncated = false;
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        if output.len() < cap {
            let take = read.min(cap - output.len());
            output.extend_from_slice(&buffer[..take]);
            if take < read {
                truncated = true;
            }
        } else {
            truncated = true;
        }
    }
    Ok((String::from_utf8_lossy(&output).into_owned(), truncated))
}

/// Stable session identifier: FNV-1a over the full session key. The hash is
/// deterministic across gateway restarts so containers can be reattached.
fn session_slug(key: &str) -> String {
    format!("s{:016x}", fnv1a64(key))
}

fn fnv1a64(input: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> SandboxConfig {
        SandboxConfig {
            enabled: true,
            image: "alpine:latest".into(),
            ..SandboxConfig::default()
        }
    }

    #[test]
    fn session_slug_is_stable_and_distinct() {
        assert_eq!(session_slug("acc:chat:dm"), session_slug("acc:chat:dm"));
        assert_ne!(session_slug("acc:chat:dm"), session_slug("acc:chat:group"));
        assert!(session_slug("acc:chat:dm").starts_with('s'));
    }

    #[test]
    fn workdir_cannot_escape_workspace() {
        assert_eq!(container_workdir(None).unwrap(), "/workspace");
        assert_eq!(container_workdir(Some("./src")).unwrap(), "/workspace/src");
        assert!(container_workdir(Some("../etc")).is_err());
        assert!(container_workdir(Some("/etc")).is_err());
        assert!(container_workdir(Some("src/../../etc")).is_err());
    }

    #[test]
    fn disabled_and_invalid_configs_fail_closed() {
        let mut value = config();
        value.enabled = false;
        assert!(value.validate().is_ok());
        value.image.clear();
        assert!(matches!(value.validate(), Err(SandboxError::NotConfigured)));
        let mut value = config();
        value.timeout_ms = 0;
        assert!(matches!(
            value.validate(),
            Err(SandboxError::InvalidConfig(_))
        ));
        value.timeout_ms = MAX_TIMEOUT_MS + 1;
        assert!(matches!(
            value.validate(),
            Err(SandboxError::InvalidConfig(_))
        ));
    }

    #[test]
    fn imports_and_resolves_workspace_files() {
        let root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(root.path().to_path_buf(), config());
        let source = root.path().join("source.txt");
        std::fs::write(&source, "hello").unwrap();

        let sandbox_path = manager
            .import_file("acc:chat:dm", "msg/1", "../evil name.txt", &source)
            .unwrap();
        assert_eq!(sandbox_path, "/workspace/upload/msg_1/evil_name.txt");

        let host = manager
            .resolve_file("acc:chat:dm", &sandbox_path)
            .unwrap();
        assert_eq!(std::fs::read_to_string(host).unwrap(), "hello");
        assert!(manager
            .resolve_file("acc:chat:dm", "/workspace/../etc/passwd")
            .is_err());
        assert!(manager.resolve_file("acc:chat:dm", "/etc/passwd").is_err());
    }

    #[tokio::test]
    async fn destroy_removes_workspace_and_isolates_sessions() {
        let root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(root.path().to_path_buf(), config());
        let first = root.path().join("first.txt");
        let second = root.path().join("second.txt");
        std::fs::write(&first, "first").unwrap();
        std::fs::write(&second, "second").unwrap();

        let first_path = manager
            .import_file("acc:chat-a:dm", "m1", "shared.txt", &first)
            .unwrap();
        let second_path = manager
            .import_file("acc:chat-b:dm", "m1", "shared.txt", &second)
            .unwrap();
        assert_eq!(first_path, "/workspace/upload/m1/shared.txt");
        assert_eq!(second_path, "/workspace/upload/m1/shared.txt");

        let first_host = manager.resolve_file("acc:chat-a:dm", &first_path).unwrap();
        let second_host = manager.resolve_file("acc:chat-b:dm", &second_path).unwrap();
        assert_ne!(first_host, second_host);
        assert_eq!(std::fs::read_to_string(&first_host).unwrap(), "first");
        assert_eq!(std::fs::read_to_string(&second_host).unwrap(), "second");

        let _ = manager.destroy("acc:chat-a:dm").await;
        assert!(!first_host.exists());
        assert!(second_host.exists());
    }

    #[test]
    fn max_lifetime_expires_sessions() {
        let root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(root.path().to_path_buf(), config());
        manager.sessions.lock().insert(
            "acc:chat:dm".into(),
            SessionState {
                created_at: Instant::now() - Duration::from_secs(5),
                last_used: Instant::now(),
            },
        );
        let mut value = config();
        value.max_lifetime_secs = 1;
        assert!(manager.lifetime_expired(&value, "acc:chat:dm"));
        value.max_lifetime_secs = 60;
        assert!(!manager.lifetime_expired(&value, "acc:chat:dm"));
    }

    #[cfg(unix)]
    #[test]
    fn resolve_file_rejects_symlink_escape() {
        let root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(root.path().to_path_buf(), config());
        let source = root.path().join("source.txt");
        std::fs::write(&source, "hello").unwrap();
        manager
            .import_file("acc:chat:dm", "msg", "source.txt", &source)
            .unwrap();
        let workspace = root
            .path()
            .join("sandboxes")
            .join(session_slug("acc:chat:dm"));
        std::os::unix::fs::symlink("/etc/passwd", workspace.join("escape")).unwrap();
        assert!(matches!(
            manager.resolve_file("acc:chat:dm", "/workspace/escape"),
            Err(SandboxError::FileOutsideWorkspace(_))
        ));
    }

    #[tokio::test]
    #[ignore = "requires a running Docker daemon"]
    async fn docker_exec_and_timeout_cleanup() {
        let root = tempfile::tempdir().unwrap();
        let image =
            std::env::var("CHRONO_SANDBOX_TEST_IMAGE").unwrap_or_else(|_| "alpine:latest".into());
        let manager = SandboxManager::new(
            root.path().to_path_buf(),
            SandboxConfig { image, ..config() },
        );

        let output = manager
            .exec("test:session", "printf hello", None, None)
            .await
            .expect("exec");
        assert_eq!(output.exit_code, 0);
        assert_eq!(output.stdout, "hello");

        let timeout = manager
            .exec("test:session", "sleep 5", None, Some(200))
            .await;
        assert!(matches!(timeout, Err(SandboxError::Timeout(200))));

        manager
            .exec("cleanup:session", "printf x", None, None)
            .await
            .expect("cleanup exec");
        let workspace = root
            .path()
            .join("sandboxes")
            .join(session_slug("cleanup:session"));
        assert!(workspace.exists());

        manager.shutdown().await;
        assert!(!workspace.exists());
    }

    #[tokio::test]
    #[ignore = "requires a running Docker daemon"]
    async fn docker_sessions_are_isolated() {
        let root = tempfile::tempdir().unwrap();
        let image =
            std::env::var("CHRONO_SANDBOX_TEST_IMAGE").unwrap_or_else(|_| "alpine:latest".into());
        let manager = SandboxManager::new(
            root.path().to_path_buf(),
            SandboxConfig { image, ..config() },
        );

        manager
            .exec("account:chat-a:dm", "printf a > /workspace/value", None, None)
            .await
            .expect("write a");
        manager
            .exec("account:chat-b:dm", "printf b > /workspace/value", None, None)
            .await
            .expect("write b");

        let a = manager
            .exec("account:chat-a:dm", "cat /workspace/value", None, None)
            .await
            .expect("read a");
        let b = manager
            .exec("account:chat-b:dm", "cat /workspace/value", None, None)
            .await
            .expect("read b");
        assert_eq!(a.stdout, "a");
        assert_eq!(b.stdout, "b");

        manager.shutdown().await;
    }
}
