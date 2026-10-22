//! Ephemeral Docker sandboxes managed by the Rust gateway.
//!
//! One container per conversation session, a bind-mounted workspace under
//! `$CHRONO_HOME/sandboxes/<slug>`, no network by default, and a hard wall
//! clock around every `docker exec`. The agent never talks to Docker: the
//! gateway exposes this as the `sandbox_exec` tool.

use std::collections::HashMap;
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
    #[error("invalid sandbox workdir: {0}")]
    InvalidWorkdir(String),
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

pub struct SandboxManager {
    /// `$CHRONO_HOME`; workspaces live under `<root>/sandboxes/<slug>`.
    root: PathBuf,
    config: RwLock<SandboxConfig>,
    last_used: Mutex<HashMap<String, Instant>>,
    home_tag: String,
}

impl SandboxManager {
    pub fn new(chrono_home: PathBuf, config: SandboxConfig) -> Self {
        let root = chrono_home.canonicalize().unwrap_or(chrono_home);
        let home_tag = format!("{:016x}", fnv1a64(root.to_string_lossy().as_ref()));
        Self {
            root,
            config: RwLock::new(config),
            last_used: Mutex::new(HashMap::new()),
            home_tag,
        }
    }

    pub fn update_config(&self, config: SandboxConfig) {
        *self.config.write() = config;
    }

    pub fn config(&self) -> SandboxConfig {
        self.config.read().clone()
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
        create_workspace(&session.workspace)?;
        self.ensure_container(&config, &session).await?;
        self.last_used
            .lock()
            .insert(session.key.clone(), Instant::now());

        let timeout = timeout_ms
            .unwrap_or(config.timeout_ms)
            .clamp(1, MAX_TIMEOUT_MS);

        match self.run_exec(&session, command, &workdir, timeout).await {
            Ok(output) => Ok(output),
            Err(SandboxError::Timeout(ms)) => {
                // Killing `docker exec` is not enough: the command keeps
                // running inside the container. Destroy the container.
                let _ = self.remove_container(&session).await;
                self.last_used.lock().remove(&session.key);
                Err(SandboxError::Timeout(ms))
            }
            Err(error) => Err(error),
        }
    }

    pub async fn destroy(&self, session_key: &str) -> Result<(), SandboxError> {
        let session = self.session(session_key);
        let result = self.remove_container(&session).await;
        self.last_used.lock().remove(&session.key);
        result
    }

    /// Remove containers idle for longer than `idle_secs`. `0` disables GC.
    /// Disabling the sandbox reaps every live container on the next pass.
    pub async fn reap_idle(&self) {
        let config = self.config();
        if !config.enabled {
            self.shutdown().await;
            return;
        }
        let idle_secs = config.idle_secs;
        if idle_secs == 0 {
            return;
        }
        let cutoff = Instant::now() - Duration::from_secs(idle_secs);
        let stale: Vec<String> = self
            .last_used
            .lock()
            .iter()
            .filter(|(_, last)| **last < cutoff)
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
        let keys: Vec<String> = self.last_used.lock().keys().cloned().collect();
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

        manager.shutdown().await;
    }
}
