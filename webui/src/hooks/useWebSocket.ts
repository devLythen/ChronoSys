import { useEffect, useRef, useCallback } from "react";
import { useAuthStore } from "../store";

type WsServerMessage =
  | { type: "agent.delta"; session_id: string; text: string }
  | { type: "agent.message"; session_id: string; message: unknown }
  | { type: "tool.trace"; session_id: string; phase: "start" | "update" | "end" }
  | { type: "session.status"; session_id: string; status: "idle" | "running" | "error" }
  | { type: "platform.inbound"; platform: string; account_id: string; session_key: string; event: unknown }
  | { type: "platform.outbound"; platform: string; account_id: string; session_key: string; tool: string; response: unknown }
  | { type: "plugin.updated"; plugin: unknown }
  | { type: "resync"; reason: "lagged"; dropped: number }
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
  const reconnectRef = useRef<number | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    let closed = false;
    let attempts = 0;

    const connect = () => {
      const token = useAuthStore.getState().token;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const query = token ? `?${new URLSearchParams({ access_token: token })}` : "";
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/v1/ws${query}`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "subscribe", topics: ["platform:telegram", "sessions:*", "audit", "plugins"] } satisfies WsClientMessage));
      };
      ws.onmessage = (event) => {
        try {
          onMessageRef.current?.(JSON.parse(event.data) as WsServerMessage);
        } catch {
          // Ignore malformed server frames; the connection remains usable.
        }
      };
      ws.onclose = () => {
        if (closed) return;
        const delay = Math.min(1_000 * 2 ** attempts, 10_000);
        attempts += 1;
        reconnectRef.current = window.setTimeout(connect, delay);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
      if (reconnectRef.current !== null) window.clearTimeout(reconnectRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  const send = useCallback((msg: WsClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(msg));
  }, []);

  return { send };
}
