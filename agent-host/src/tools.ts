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
 * The only M1 tool: writes tool.request to stdout and awaits tool.response
 * resolved by the main stdin read loop via `pendingCalls`.
 */
export function createMessageSendTool(
  sessionKey: string,
  pendingCalls: Map<string, PendingCall>,
  signal?: AbortSignal,
): AgentTool {
  return {
    name: "message_send",
    label: "Send Message",
    description: "Send a text message to the current chat",
    parameters: Type.Object({ text: Type.String() }),
    async execute(toolCallId: string, params: unknown) {
      if (
        !params ||
        typeof params !== "object" ||
        !("text" in params) ||
        typeof params.text !== "string"
      ) {
        throw new Error("message_send requires { text: string }");
      }
      const text = params.text;
      const request: ToolIpcMessage = {
        type: "tool.request",
        session_id: sessionKey,
        tool_call_id: toolCallId,
        name: "message_send",
        args: { text },
        timeout_ms: 15000,
      };

      const response = await new Promise<ToolIpcMessage>((resolve, reject) => {
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

        writeFrameStdout(
          new TextEncoder().encode(JSON.stringify(request)),
        );
      });

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
