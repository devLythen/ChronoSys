use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;

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

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let (mut sender, mut receiver) = socket.split();
    let mut subscriptions = Vec::new();
    let mut events = state.ws_events.subscribe();

    if sender
        .send(Message::Text(
            json!({ "type": "hello", "protocol": "chrono.ws.v1" }).to_string().into(),
        ))
        .await
        .is_err()
    {
        return;
    }

    loop {
        tokio::select! {
            incoming = receiver.next() => {
                let Some(Ok(msg)) = incoming else { break };
                let text = match msg {
                    Message::Text(t) => t.to_string(),
                    Message::Ping(p) => {
                        if sender.send(Message::Pong(p)).await.is_err() { break; }
                        continue;
                    }
                    Message::Close(_) => break,
                    _ => continue,
                };

                match serde_json::from_str::<WsClient>(&text) {
                    Ok(WsClient::Subscribe { topics }) => {
                        subscriptions = topics;
                        if sender
                            .send(Message::Text(
                                json!({ "type": "subscribed", "topics": subscriptions }).to_string().into(),
                            ))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Ok(WsClient::Ping) => {
                        if sender.send(Message::Text("pong".into())).await.is_err() { break; }
                    }
                    Err(e) => {
                        if sender
                            .send(Message::Text(
                                json!({ "type": "error", "message": format!("bad message: {e}") })
                                    .to_string()
                                    .into(),
                            ))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
            event = events.recv() => match event {
                Ok(event) if event.topics.iter().any(|topic| subscriptions.iter().any(|subscription| topic_matches(subscription, topic))) => {
                    if sender
                        .send(Message::Text(event.payload.to_string().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(_) => {}
                Err(RecvError::Lagged(count)) => {
                    if sender
                        .send(Message::Text(json!({ "type": "resync", "reason": "lagged", "dropped": count }).to_string().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(RecvError::Closed) => break,
            }
        }
    }
}

fn topic_matches(subscription: &str, topic: &str) -> bool {
    subscription == "*"
        || subscription == topic
        || subscription
            .strip_suffix('*')
            .is_some_and(|prefix| topic.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::topic_matches;
    use crate::state::WsEvent;
    use serde_json::json;
    use tokio::sync::broadcast;

    #[test]
    fn matches_exact_and_wildcard_topics() {
        assert!(topic_matches("sessions:*", "sessions:telegram:123"));
        assert!(topic_matches("platform:telegram", "platform:telegram"));
        assert!(topic_matches("*", "audit"));
        assert!(!topic_matches("sessions:*", "platform:telegram"));
    }

    #[tokio::test]
    async fn broadcasts_telegram_events_to_session_and_platform_topics() {
        let (tx, _) = broadcast::channel(1);
        let mut session_events = tx.subscribe();
        let mut platform_events = tx.subscribe();
        let event = WsEvent {
            topics: vec!["sessions:telegram:acct:chat".into(), "platform:telegram".into()],
            payload: json!({ "type": "platform.inbound", "platform": "telegram" }),
        };

        tx.send(event).unwrap();

        let session_event = session_events.recv().await.unwrap();
        let platform_event = platform_events.recv().await.unwrap();
        assert!(session_event.topics.iter().any(|topic| topic_matches("sessions:*", topic)));
        assert!(platform_event.topics.iter().any(|topic| topic_matches("platform:telegram", topic)));
        assert_eq!(session_event.payload["type"], "platform.inbound");
    }
}
