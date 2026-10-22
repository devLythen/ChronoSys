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
 * Built-in tool: send a file from the session sandbox workspace back to the
 * current chat. The gateway resolves `/workspace/...` to the host workspace.
 */
export function createSandboxSendFileTool(
  sessionKey: string,
  pendingCalls: Map<string, PendingCall>,
  signal?: AbortSignal,
): AgentTool {
  return {
    name: "sandbox_send_file",
    label: "Send sandbox file",
    description:
      "Send a file from the session sandbox workspace to the current chat. " +
      "The path must be inside `/workspace` (for example `/workspace/report.txt`). " +
      "Use this after generating artifacts with sandbox_exec.",
    parameters: Type.Object({
      path: Type.String({
        description: "File path inside the sandbox workspace, e.g. /workspace/report.txt.",
      }),
      caption: Type.Optional(
        Type.String({
          description: "Optional message caption shown with the file.",
        }),
      ),
    }),
    async execute(toolCallId: string, params: unknown) {
      if (
        !params ||
        typeof params !== "object" ||
        !("path" in params) ||
        typeof params.path !== "string" ||
        !params.path.startsWith("/workspace/")
      ) {
        throw new Error("sandbox_send_file requires { path: '/workspace/...', caption?: string }");
      }
      const args: Record<string, unknown> = { path: params.path };
      if ("caption" in params && typeof params.caption === "string" && params.caption.trim()) {
        args.caption = params.caption;
      }
      const request: ToolIpcMessage = {
        type: "tool.request",
        session_id: sessionKey,
        tool_call_id: toolCallId,
        name: "sandbox_send_file",
        args,
        timeout_ms: 120_000,
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
            ? response.error?.message ?? "sandbox send file failed"
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
 * Built-in tool: read an image from the sandbox workspace and return it as
 * native multimodal content, so the model can inspect files it did not upload
 * in the current turn.
 */
export function createSandboxViewImageTool(
  sessionKey: string,
  pendingCalls: Map<string, PendingCall>,
  signal?: AbortSignal,
): AgentTool {
  return {
    name: "sandbox_view_image",
    label: "View sandbox image",
    description:
      "Read an image file from the sandbox workspace and return it as visual content. " +
      "Use this to inspect images already stored under /workspace (uploaded or generated). " +
      "Supports png, jpeg, webp, and gif up to 6 MiB.",
    parameters: Type.Object({
      path: Type.String({
        description: "Image path inside the sandbox workspace, e.g. /workspace/upload/.../photo.jpg.",
      }),
    }),
    async execute(toolCallId: string, params: unknown) {
      if (
        !params ||
        typeof params !== "object" ||
        !("path" in params) ||
        typeof params.path !== "string" ||
        !params.path.startsWith("/workspace/")
      ) {
        throw new Error("sandbox_view_image requires { path: '/workspace/...' }");
      }
      const path = params.path;
      const request: ToolIpcMessage = {
        type: "tool.request",
        session_id: sessionKey,
        tool_call_id: toolCallId,
        name: "sandbox_view_image",
        args: { path },
        timeout_ms: 30_000,
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
            ? response.error?.message ?? "sandbox view image failed"
            : "unexpected IPC response",
        );
      }
      const result = response.result;
      if (
        !result ||
        typeof result !== "object" ||
        !("data" in result) ||
        typeof result.data !== "string" ||
        !("mime" in result) ||
        typeof result.mime !== "string"
      ) {
        throw new Error("sandbox_view_image returned malformed data");
      }
      return {
        content: [
          {
            type: "image" as const,
            data: result.data,
            mimeType: result.mime,
          },
          {
            type: "text" as const,
            text: `Image: ${path}`,
          },
        ],
        details: { path, mime: result.mime },
      };
    },
  };
}

/**
 * Built-in tool: run a deterministic Playwright action batch in the session
 * sandbox. The image must provide node + a resolvable playwright package.
 */
export function createSandboxBrowserTool(
  sessionKey: string,
  pendingCalls: Map<string, PendingCall>,
  supportsImage: boolean,
  signal?: AbortSignal,
): AgentTool {
  return {
    name: "sandbox_browser",
    label: "Browse in sandbox",
    description:
      "Run a deterministic Playwright action batch in the session sandbox and return results. " +
      "Each call starts a fresh browser; put dependent actions in one batch. " +
      "Use goto, click, fill, wait_for, extract, screenshot, or wait. " +
      "Only http(s) URLs are allowed; private/local hosts are blocked. " +
      "The container image must provide node and Playwright, and sandbox.network must be enabled.",
    parameters: Type.Object({
      actions: Type.Array(
        Type.Object({
          action: Type.String({
            description: "goto | click | fill | wait_for | extract | screenshot | wait",
          }),
          url: Type.Optional(Type.String({ description: "Target URL for goto." })),
          selector: Type.Optional(Type.String({ description: "CSS/text selector for click, fill, wait_for, extract." })),
          value: Type.Optional(Type.String({ description: "Value for fill." })),
          path: Type.Optional(Type.String({ description: "Screenshot path under /workspace/; optional." })),
          full_page: Type.Optional(Type.Boolean({ description: "Capture the full page for screenshot." })),
          ms: Type.Optional(Type.Number({ description: "Wait duration in ms (1..30000)." })),
        }),
        { description: "Ordered action batch (1..50 actions)." },
      ),
      timeout_ms: Type.Optional(
        Type.Number({
          minimum: 1000,
          maximum: 295000,
          description: "Per-action timeout in milliseconds. Omit to use the operator's sandbox timeout.",
        }),
      ),
    }),
    async execute(toolCallId: string, params: unknown) {
      if (
        !params ||
        typeof params !== "object" ||
        !("actions" in params) ||
        !Array.isArray(params.actions) ||
        params.actions.length === 0
      ) {
        throw new Error("sandbox_browser requires { actions: [...] }");
      }
      const requested =
        "timeout_ms" in params &&
        typeof params.timeout_ms === "number" &&
        Number.isFinite(params.timeout_ms)
          ? Math.min(Math.max(Math.floor(params.timeout_ms), 1_000), 295_000)
          : undefined;
      const args: Record<string, unknown> = {
        actions: params.actions,
        include_image: supportsImage,
      };
      if (requested !== undefined) args.timeout_ms = requested;
      const request: ToolIpcMessage = {
        type: "tool.request",
        session_id: sessionKey,
        tool_call_id: toolCallId,
        name: "sandbox_browser",
        args,
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
            ? response.error?.message ?? "sandbox browser failed"
            : "unexpected IPC response",
        );
      }
      const result = response.result;
      if (
        !result ||
        typeof result !== "object" ||
        !("results" in result) ||
        !Array.isArray(result.results)
      ) {
        throw new Error("sandbox_browser returned malformed data");
      }
      const publicResult: Record<string, unknown> = { ...result };
      const image = publicResult.image;
      delete publicResult.image;
      const content: Array<
        { type: "text"; text: string } |
        { type: "image"; data: string; mimeType: string }
      > = [{ type: "text", text: JSON.stringify(publicResult) }];
      if (
        supportsImage &&
        image &&
        typeof image === "object" &&
        "data" in image &&
        typeof image.data === "string" &&
        "mime" in image &&
        typeof image.mime === "string"
      ) {
        content.push({ type: "image", data: image.data, mimeType: image.mime });
      }
      return { content, details: publicResult };
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
