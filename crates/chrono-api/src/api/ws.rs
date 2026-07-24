use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::json;

use crate::state::{AgentControl, AppState};

pub async fn handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum WsClient {
    #[serde(rename = "subscribe")]
    Subscribe { topics: Vec<String> },
    #[serde(rename = "session.prompt")]
    SessionPrompt { session_id: String, text: String },
    #[serde(rename = "session.steer")]
    SessionSteer { session_id: String, text: String },
    #[serde(rename = "session.abort")]
    SessionAbort { session_id: String },
    #[serde(rename = "ping")]
    Ping,
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>) {
    let _ = socket
        .send(Message::Text(
            json!({ "type": "hello", "protocol": "chrono.ws.v1" }).to_string().into(),
        ))
        .await;

    while let Some(Ok(msg)) = socket.next().await {
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Ping(p) => {
                let _ = socket.send(Message::Pong(p)).await;
                continue;
            }
            Message::Close(_) => break,
            _ => continue,
        };

        let parsed: Result<WsClient, _> = serde_json::from_str(&text);
        match parsed {
            Ok(WsClient::Subscribe { topics }) => {
                let _ = socket
                    .send(Message::Text(
                        json!({ "type": "subscribed", "topics": topics })
                            .to_string()
                            .into(),
                    ))
                    .await;
            }
            Ok(WsClient::SessionSteer { session_id, text }) => {
                let _ = state.agent_tx.send(AgentControl::Steer {
                    session_id: session_id.clone(),
                    text,
                });
                let _ = socket
                    .send(Message::Text(
                        json!({ "type": "ack", "action": "steer", "session_id": session_id })
                            .to_string()
                            .into(),
                    ))
                    .await;
            }
            Ok(WsClient::SessionAbort { session_id }) => {
                let _ = state.agent_tx.send(AgentControl::Abort {
                    session_id: session_id.clone(),
                });
                let _ = socket
                    .send(Message::Text(
                        json!({ "type": "ack", "action": "abort", "session_id": session_id })
                            .to_string()
                            .into(),
                    ))
                    .await;
            }
            Ok(WsClient::SessionPrompt { session_id, text }) => {
                // MVP: treat prompt like steer (inject as control message).
                let _ = state.agent_tx.send(AgentControl::Steer {
                    session_id: session_id.clone(),
                    text,
                });
                let _ = socket
                    .send(Message::Text(
                        json!({ "type": "ack", "action": "prompt", "session_id": session_id })
                            .to_string()
                            .into(),
                    ))
                    .await;
            }
            Ok(WsClient::Ping) => {
                let _ = socket
                    .send(Message::Text(json!({ "type": "pong" }).to_string().into()))
                    .await;
            }
            Err(e) => {
                let _ = socket
                    .send(Message::Text(
                        json!({ "type": "error", "message": format!("bad message: {e}") })
                            .to_string()
                            .into(),
                    ))
                    .await;
            }
        }
    }
}
