import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ToolIpcMessage } from "./ipc/types.ts";
import { writeFrameStdout } from "./transport.ts";

export type PendingCall = {
  resolve: (v: ToolIpcMessage) => void;
  reject: (e: Error) => void;
};


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
        const errMsg = response.error?.message ?? "tool failed";
        throw new Error(errMsg);
      }
      const completedAt = new Date().toISOString();
      const result = { completed_at: completedAt };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}

/** IANA timezone normalizer — falls back to UTC on invalid input. */
export function normalizeTimezone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/**
 * Built-in tool: return the current date and time in the bot's configured
 * timezone. No parameters — the timezone is fixed by config, not user input.
 */
export function createTimeTool(timezone: string): AgentTool {
  const tz = normalizeTimezone(timezone);
  return {
    name: "get_time",
    label: "Get current time",
    description:
      "Return the current date and time in the bot's configured timezone. " +
      "Use this instead of guessing when you need to know the local time.",
    parameters: Type.Object({}),
    async execute(_toolCallId: string) {
      const now = new Date();
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false, timeZoneName: "short",
      });
      const result = {
        timezone: tz,
        iso: now.toISOString(),
        local: fmt.format(now),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}

/**
 * Built-in tool: run a shell command in the session's Docker sandbox.
 *
 * The gateway owns the container and workspace; this function only frames the
 * request. Arguments are validated again in Rust.
 */
export function createSandboxExecTool(
  sessionKey: string,
  pendingCalls: Map<string, PendingCall>,
  signal?: AbortSignal,
): AgentTool {
  return {
    name: "sandbox_exec",
    label: "Run command in sandbox",
    description:
      "Run a shell command in the session's isolated Docker workspace. " +
      "Use this for code execution, file inspection, and generated artifacts. " +
      "The workspace is /workspace; network access is disabled unless the operator enables it. " +
      "Returns exit_code, stdout, stderr, and a truncated flag.",
    parameters: Type.Object({
      cmd: Type.String({
        description: "Shell command to run inside the sandbox.",
      }),
      cwd: Type.Optional(
        Type.String({
          description:
            "Relative working directory under /workspace. Absolute paths and '..' are rejected.",
        }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 295000,
          description: "Wall-clock timeout in milliseconds. Omit to use the operator's sandbox timeout setting.",
        }),
      ),
    }),
    async execute(toolCallId: string, params: unknown) {
      if (
        !params ||
        typeof params !== "object" ||
        !("cmd" in params) ||
        typeof params.cmd !== "string" ||
        !params.cmd.trim()
      ) {
        throw new Error("sandbox_exec requires { cmd: string, cwd?: string, timeout_ms?: number }");
      }
      const requested =
        "timeout_ms" in params &&
        typeof params.timeout_ms === "number" &&
        Number.isFinite(params.timeout_ms)
          ? Math.min(Math.max(Math.floor(params.timeout_ms), 1), 295_000)
          : undefined;
      const args: Record<string, unknown> = { cmd: params.cmd };
      if (requested !== undefined) args.timeout_ms = requested;
      if ("cwd" in params && typeof params.cwd === "string" && params.cwd.trim()) {
        args.cwd = params.cwd;
      }

      const request: ToolIpcMessage = {
        type: "tool.request",
        session_id: sessionKey,
        tool_call_id: toolCallId,
        name: "sandbox_exec",
        args,
        // Outer envelope must outlive the sandbox's own timeout so Rust can
        // return a structured timeout instead of racing the IPC deadline.
        timeout_ms: requested === undefined ? 300_000 : Math.min(requested + 5_000, 300_000),
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
            ? response.error?.message ?? "sandbox exec failed"
            : "unexpected IPC response",
        );
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.result ?? {}),
          },
        ],
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
