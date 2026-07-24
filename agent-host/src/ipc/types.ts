export type ChatKind = "dm" | "group" | "channel";

export interface ChronoEventInboundMessage {
  type: "inbound.message";
  session_key: string;
  event_id: string;
  platform: string;
  bot_profile_id?: string;
  chat: { id: string; kind: ChatKind; title?: string };
  sender: { id: string; name: string };
  message: {
    id: string;
    text: string;
    reply_to?: string;
    attachments: Array<{ id: string; mime: string; name?: string }>;
  };
  received_at: string;
}

export type ChronoEvent = ChronoEventInboundMessage;

export type ToolIpcMessage =
  | {
      type: "tool.request";
      session_id: string;
      tool_call_id: string;
      name: string;
      args: unknown;
      timeout_ms: number;
    }
  | {
      type: "tool.response";
      tool_call_id: string;
      ok: boolean;
      result?: unknown;
      error?: { code: string; message: string };
    };
