import { useEffect, useRef, useCallback } from "react";
import { useAuthStore } from "../store";

type WsServerMessage =
  | { type: "agent.delta"; session_id: string; text: string }
  | { type: "agent.message"; session_id: string; message: unknown }
  | { type: "tool.trace"; session_id: string; phase: "start" | "update" | "end" }
  | { type: "session.status"; session_id: string; status: "idle" | "running" | "error" }
  | { type: "metrics.sample" }
  | { type: "audit.append"; entry: unknown };

type WsClientMessage =
  | { type: "subscribe"; topics: string[] }
  | { type: "session.prompt"; session_id: string; text: string }
  | { type: "session.steer"; session_id: string; text: string }
  | { type: "session.abort"; session_id: string };

export type { WsServerMessage, WsClientMessage };

export function useWebSocket(onMessage?: (msg: WsServerMessage) => void) {
  const wsRef = useRef<WebSocket | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    const token = useAuthStore.getState().token;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/v1/ws`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      // Subscribe to all topics
      const sub: WsClientMessage = {
        type: "subscribe",
        topics: ["sessions:*", "audit", "metrics"],
      };
      ws.send(JSON.stringify(sub));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsServerMessage;
        onMessageRef.current?.(msg);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onerror = () => {
      // silent — reconnection handled by cleanup + remount
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, []);

  const send = useCallback((msg: WsClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { send };
}
