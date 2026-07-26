use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::json;

use crate::state::AppState;

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
    #[serde(rename = "ping")]
    Ping,
}

async fn handle_socket(mut socket: WebSocket, _state: Arc<AppState>) {
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

        match serde_json::from_str::<WsClient>(&text) {
            Ok(WsClient::Subscribe { topics }) => {
                let _ = socket
                    .send(Message::Text(
                        json!({ "type": "subscribed", "topics": topics })
                            .to_string()
                            .into(),
                    ))
                    .await;
            }
            Ok(WsClient::Ping) => {
                let _ = socket.send(Message::Text("pong".into())).await;
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
