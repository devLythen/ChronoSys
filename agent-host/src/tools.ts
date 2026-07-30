import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ToolIpcMessage } from "./ipc/types.ts";
import { writeFrameStdout } from "./transport.ts";

export type PendingCall = {
  resolve: (v: ToolIpcMessage) => void;
  reject: (e: Error) => void;
};

/** Known platform tools that agent-host can register. */
const KNOWN_TOOLS = ["message_send"] as const;
export type KnownToolName = (typeof KNOWN_TOOLS)[number];

/**
 * Build the tool list for a bot profile.
 * - empty allowlist → all known tools
 * - non-empty allowlist → only those tools that exist in the registry
 */
export function createToolsForAllowlist(
  allowlist: string[],
  sessionKey: string,
  pendingCalls: Map<string, PendingCall>,
  signal?: AbortSignal,
): AgentTool[] {
  const names =
    allowlist.length === 0
      ? [...KNOWN_TOOLS]
      : allowlist.filter((n): n is KnownToolName =>
          (KNOWN_TOOLS as readonly string[]).includes(n),
        );

  const tools: AgentTool[] = [];
  for (const name of names) {
    switch (name) {
      case "message_send":
        tools.push(createMessageSendTool(sessionKey, pendingCalls, signal));
        break;
    }
  }
  return tools;
}

/**
 * Preferred outbound path: send or forward text to a chosen chat.
 * - omit chat_id → current conversation (gateway injects from session)
 * - set chat_id → cross-chat send (e.g. DM another user / another group)
 *
 * Free-form assistant body text (non-tool) is restricted to the current chat only;
 * that path is handled by agent-host after the agent run, not by this tool.
 */
export function createMessageSendTool(
  sessionKey: string,
  pendingCalls: Map<string, PendingCall>,
  signal?: AbortSignal,
): AgentTool {
  return {
    name: "message_send",
    label: "Send / forward message",
    description:
      "Send a message to the chat at any point during your response. " +
      "You can call this multiple times for natural sentence-by-sentence delivery. " +
      "If you use this tool to communicate, you may output no text — just end the thinking chain. " +
      "Omit chat_id to send to the current conversation; set it to reach another chat.",
    parameters: Type.Object({
      text: Type.String({ description: "Message body to send" }),
      chat_id: Type.Optional(
        Type.String({
          description:
            "Target chat id on the current platform account. " +
            "If omitted, the gateway uses the current conversation chat.",
        }),
      ),
    }),
    async execute(toolCallId: string, params: unknown) {
      if (
        !params ||
        typeof params !== "object" ||
        !("text" in params) ||
        typeof (params as { text?: unknown }).text !== "string"
      ) {
        throw new Error("message_send requires { text: string, chat_id?: string }");
      }
      const text = (params as { text: string }).text;
      const chatIdRaw = (params as { chat_id?: unknown }).chat_id;
      const chatId =
        typeof chatIdRaw === "string" && chatIdRaw.length > 0
          ? chatIdRaw
          : typeof chatIdRaw === "number"
            ? String(chatIdRaw)
            : undefined;

      const args: Record<string, string> = { text };
      if (chatId !== undefined) args.chat_id = chatId;

      const request: ToolIpcMessage = {
        type: "tool.request",
        session_id: sessionKey,
        tool_call_id: toolCallId,
        name: "message_send",
        args,
        timeout_ms: 15000,
      };

      const response = await waitToolResponse(
        toolCallId,
        request,
        pendingCalls,
        signal,
      );

      if (response.type !== "tool.response") {
        throw new Error("unexpected IPC response");
      }
      if (!response.ok) {
        throw new Error(response.error?.message ?? "tool failed");
      }
      return {
        content: [{ type: "text", text: JSON.stringify(response.result) }],
        details: response.result,
      };
    },
  };
}

/**
 * Fallback: send plain assistant body text to the **current** chat only.
 * Cross-chat delivery must use message_send with chat_id.
 */
export async function sendBodyTextToCurrentChat(
  sessionKey: string,
  text: string,
  pendingCalls: Map<string, PendingCall>,
  signal?: AbortSignal,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  const toolCallId = `body_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const request: ToolIpcMessage = {
    type: "tool.request",
    session_id: sessionKey,
    tool_call_id: toolCallId,
    name: "message_send",
    // no chat_id → gateway injects current chat only
    args: { text: trimmed },
    timeout_ms: 15000,
  };

  const response = await waitToolResponse(
    toolCallId,
    request,
    pendingCalls,
    signal,
  );
  if (response.type !== "tool.response" || !response.ok) {
    throw new Error(
      response.type === "tool.response"
        ? (response.error?.message ?? "body send failed")
        : "unexpected IPC response",
    );
  }
}

function waitToolResponse(
  toolCallId: string,
  request: ToolIpcMessage,
  pendingCalls: Map<string, PendingCall>,
  signal?: AbortSignal,
): Promise<ToolIpcMessage> {
  return new Promise<ToolIpcMessage>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("tool aborted"));
      return;
    }

    const onAbort = () => {
      pendingCalls.delete(toolCallId);
      reject(new Error("tool aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    pendingCalls.set(toolCallId, {
      resolve: (v) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      },
      reject: (e) => {
        signal?.removeEventListener("abort", onAbort);
        reject(e);
      },
    });

    writeFrameStdout(new TextEncoder().encode(JSON.stringify(request)));
  });
}
