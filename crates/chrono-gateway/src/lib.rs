use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use chrono_ipc::{
    decode_frame, encode_frame, ChronoEvent, ChatKind, ChatRef, FrameError, InboundMessageBody,
    SenderRef, ToolError, ToolIpcMessage, MAX_FRAME_BYTES,
};
use serde_json::{json, Value};
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

pub struct GatewayMock {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
}

impl GatewayMock {
    /// Spawn `bun run src/main.ts` in `agent_host_dir` with stdin/stdout pipes.
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
            child,
            stdin,
            stdout,
        })
    }

    /// Inject a fake inbound chat message into the agent-host.
    pub fn inject_message(&mut self, text: &str, session_key: &str) -> Result<(), GatewayError> {
        let event = ChronoEvent::InboundMessage {
            session_key: session_key.to_string(),
            event_id: "evt_dev_001".to_string(),
            platform: "dev".to_string(),
            chat: ChatRef {
                id: session_key.to_string(),
                kind: ChatKind::Dm,
                title: None,
            },
            sender: SenderRef {
                id: "user_dev".to_string(),
                name: "Dev User".to_string(),
            },
            message: InboundMessageBody {
                id: "msg_dev_001".to_string(),
                text: text.to_string(),
                reply_to: None,
                attachments: vec![],
            },
            received_at: "2026-07-24T00:00:00Z".to_string(),
        };
        let payload = serde_json::to_vec(&event)?;
        write_frame(&mut self.stdin, &payload)?;
        Ok(())
    }

    /// Read framed messages from the child until `done`, `error`, or EOF.
    pub fn run_loop(&mut self) -> Result<(), GatewayError> {
        loop {
            let payload = match read_frame(&mut self.stdout) {
                Ok(p) => p,
                Err(GatewayError::Io(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    return Ok(());
                }
                Err(e) => return Err(e),
            };

            // Prefer ToolIpcMessage; fall back to generic Value for control messages.
            if let Ok(tool_msg) = serde_json::from_slice::<ToolIpcMessage>(&payload) {
                match tool_msg {
                    ToolIpcMessage::Request {
                        tool_call_id,
                        name,
                        args,
                        ..
                    } => {
                        if name == "message.send" {
                            let text = args
                                .get("text")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            println!("[outbound] sending to chat: \"{text}\"");
                            let response = ToolIpcMessage::Response {
                                tool_call_id,
                                ok: true,
                                result: Some(json!({"message_id": "mock_001"})),
                                error: None,
                            };
                            let body = serde_json::to_vec(&response)?;
                            write_frame(&mut self.stdin, &body)?;
                        } else {
                            let response = ToolIpcMessage::Response {
                                tool_call_id,
                                ok: false,
                                result: None,
                                error: Some(ToolError {
                                    code: "unsupported".to_string(),
                                    message: format!("unsupported tool: {name}"),
                                }),
                            };
                            let body = serde_json::to_vec(&response)?;
                            write_frame(&mut self.stdin, &body)?;
                        }
                    }
                    ToolIpcMessage::Response { .. } => {
                        // Agent should not send responses to us.
                        eprintln!("[gateway] unexpected tool.response from agent-host");
                    }
                }
                continue;
            }

            let value: Value = serde_json::from_slice(&payload)?;
            let msg_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match msg_type {
                "done" => return Ok(()),
                "error" => {
                    let message = value
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown agent error");
                    eprintln!("[gateway] agent error: {message}");
                    return Err(GatewayError::AgentError(message.to_string()));
                }
                other => {
                    eprintln!("[gateway] unknown message type from agent-host: {other}");
                }
            }
        }
    }
}

impl Drop for GatewayMock {
    fn drop(&mut self) {
        // Close stdin so the child can exit its read loop.
        // ChildStdin drops with self; try to wait without hanging forever.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn write_frame(writer: &mut impl Write, payload: &[u8]) -> Result<(), GatewayError> {
    let frame = encode_frame(payload)?;
    writer.write_all(&frame)?;
    writer.flush()?;
    Ok(())
}

/// Read one full frame from `reader`. Uses a 4-byte header then body.
fn read_frame(reader: &mut impl Read) -> Result<Vec<u8>, GatewayError> {
    let mut header = [0u8; 4];
    reader.read_exact(&mut header)?;
    let len = u32::from_be_bytes(header) as usize;
    if len > MAX_FRAME_BYTES {
        return Err(GatewayError::Frame(FrameError::TooLarge { len }));
    }
    let mut body = vec![0u8; len];
    if len > 0 {
        reader.read_exact(&mut body)?;
    }
    // Validate via decode_frame for consistency (header+body already complete).
    let mut full = Vec::with_capacity(4 + len);
    full.extend_from_slice(&header);
    full.extend_from_slice(&body);
    let (payload, _) = decode_frame(&full)?;
    Ok(payload)
}
