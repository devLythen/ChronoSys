pub mod adapter;
pub mod adapters;
pub mod http;
pub mod runner;
pub mod secrets;

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use chrono_ipc::{decode_frame, encode_frame, FrameError, MAX_FRAME_BYTES};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum GatewayError {
    #[error("failed to spawn agent-host: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("agent-host directory not found: {0}")]
    MissingAgentHost(String),
    #[error("bun not found on PATH (or invalid bun path): {0}")]
    MissingBun(String),
    #[error("frame error: {0}")]
    Frame(#[from] FrameError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("child process error: {0}")]
    Child(String),
    #[error("agent-host reported error: {0}")]
    AgentError(String),
}

/// Manages the lifecycle of a spawned agent-host child process.
/// stdin and stdout are independently locked for concurrent read/write.
pub struct GatewayChild {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    stdout: Mutex<ChildStdout>,
}

impl GatewayChild {
    /// Spawn `bun run src/main.ts` in `agent_host_dir`. CHRONO_HOME is absolute.
    pub fn spawn(
        bun_path: &str,
        agent_host_dir: &Path,
        chrono_home: &Path,
        fake_llm: bool,
    ) -> Result<Self, GatewayError> {
        if !agent_host_dir.join("src/main.ts").exists() {
            return Err(GatewayError::MissingAgentHost(
                agent_host_dir.display().to_string(),
            ));
        }

        let mut cmd = Command::new(bun_path);
        cmd.arg("run")
            .arg("src/main.ts")
            .current_dir(agent_host_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .env("CHRONO_HOME", chrono_home);

        if fake_llm {
            cmd.env("CHRONO_FAKE_LLM", "1");
        }

        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                GatewayError::MissingBun(bun_path.to_string())
            } else {
                GatewayError::Spawn(e)
            }
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| GatewayError::Child("failed to take child stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| GatewayError::Child("failed to take child stdout".into()))?;

        Ok(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            stdout: Mutex::new(stdout),
        })
    }

    /// Write a length-prefixed JSON frame to the agent-host's stdin.
    pub fn write_frame(&self, payload: &[u8]) -> Result<(), GatewayError> {
        let frame = encode_frame(payload)?;
        let mut stdin = self.stdin.lock().unwrap();
        stdin.write_all(&frame)?;
        stdin.flush()?;
        Ok(())
    }

    /// Read one full length-prefixed frame from the agent-host's stdout.
    pub fn read_frame(&self) -> Result<Vec<u8>, GatewayError> {
        let mut stdout = self.stdout.lock().unwrap();
        let mut header = [0u8; 4];
        stdout.read_exact(&mut header)?;
        let len = u32::from_be_bytes(header) as usize;
        if len > MAX_FRAME_BYTES {
            return Err(GatewayError::Frame(FrameError::TooLarge { len }));
        }
        let mut body = vec![0u8; len];
        if len > 0 {
            stdout.read_exact(&mut body)?;
        }
        let mut full = Vec::with_capacity(4 + len);
        full.extend_from_slice(&header);
        full.extend_from_slice(&body);
        let (payload, _) = decode_frame(&full)?;
        Ok(payload)
    }

    /// Non-blocking check: true while the agent-host process is still running.
    pub fn is_alive(&self) -> bool {
        let mut child = self.child.lock().unwrap();
        match child.try_wait() {
            Ok(None) => true,
            Ok(Some(_)) => false,
            Err(_) => false,
        }
    }
}

impl Drop for GatewayChild {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

// ── shared helpers ────────────────────────────────────────────────

/// Resolve `bun` path: env `CHRONO_BUN`, then PATH.
pub fn find_bun() -> Result<String> {
    if let Ok(path) = std::env::var("CHRONO_BUN") {
        return Ok(path);
    }
    let output = Command::new("bun")
        .arg("--version")
        .output()
        .context("failed to execute `bun --version`")?;
    if !output.status.success() {
        bail!("`bun --version` failed");
    }
    Ok("bun".to_string())
}

/// Resolve the agent-host directory: env `CHRONO_AGENT_HOST_DIR`, then relative to manifest.
pub fn resolve_agent_host_dir() -> Result<PathBuf> {
    if let Ok(dir) = std::env::var("CHRONO_AGENT_HOST_DIR") {
        let p = PathBuf::from(dir);
        if p.join("src/main.ts").exists() {
            return Ok(p);
        }
        bail!(
            "CHRONO_AGENT_HOST_DIR does not contain src/main.ts: {}",
            p.display()
        );
    }

    let from_manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../agent-host");
    let canonical = from_manifest
        .canonicalize()
        .with_context(|| format!("resolve agent-host at {}", from_manifest.display()))?;
    if !canonical.join("src/main.ts").exists() {
        bail!(
            "agent-host main.ts not found at {}",
            canonical.join("src/main.ts").display()
        );
    }
    Ok(canonical)
}
