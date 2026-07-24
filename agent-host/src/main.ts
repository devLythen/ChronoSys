import { Agent } from "@earendil-works/pi-agent-core";
import type { ChronoEvent, ToolIpcMessage } from "./ipc/types.ts";
import { createFakeStreamFn, FAKE_MODEL } from "./fake-llm.ts";
import { createMessageSendTool, type PendingCall } from "./tools.ts";
import {
  readFrames,
  stdinAsWebStream,
  writeFrameStdout,
} from "./transport.ts";
import { openConfig } from "./config.ts";
import { buildModels, resolveBot } from "./resolve.ts";

const DEFAULT_SYSTEM_PROMPT =
  "You are an assistant in a chat platform. When asked to send a message, use the message.send tool.";

const FAKE_SEND_TEXT = "Hello from ChronoSys!";

function logEvent(event: unknown) {
  let payload: Record<string, unknown>;
  if (event && typeof event === "object") {
    payload = { ts: new Date().toISOString(), ...event };
  } else {
    payload = { ts: new Date().toISOString(), event };
  }
  process.stderr.write(JSON.stringify(payload) + "\n");
}

function writeControl(msg: Record<string, unknown>) {
  writeFrameStdout(new TextEncoder().encode(JSON.stringify(msg)));
}

function isToolResponse(
  msg: unknown,
): msg is Extract<ToolIpcMessage, { type: "tool.response" }> {
  if (!msg || typeof msg !== "object") return false;
  if (!("type" in msg)) return false;
  return msg.type === "tool.response";
}

function isInboundMessage(msg: unknown): msg is ChronoEvent {
  if (!msg || typeof msg !== "object") return false;
  if (!("type" in msg)) return false;
  return msg.type === "inbound.message";
}

function messageTypeOf(msg: unknown): string | undefined {
  if (!msg || typeof msg !== "object") return undefined;
  if (!("type" in msg)) return undefined;
  return typeof msg.type === "string" ? msg.type : undefined;
}

type InboundWaiter = {
  resolve: (v: ChronoEvent | null) => void;
  reject: (e: Error) => void;
};

async function main() {
  const fakeLlm = process.env.CHRONO_FAKE_LLM === "1";
  const pendingCalls = new Map<string, PendingCall>();

  // ── Resolve model + streamFn + system prompt ──────────────────
  let streamFn;
  let model;
  let systemPrompt = DEFAULT_SYSTEM_PROMPT;

  if (fakeLlm) {
    streamFn = createFakeStreamFn(FAKE_SEND_TEXT);
    model = FAKE_MODEL;
  } else {
    const chronoHome = process.env.CHRONO_HOME ?? ".chrono";
    const dbPath = `${chronoHome}/state/chrono.db`;
    const config = openConfig(dbPath);
    const models = buildModels(config);
    if (!models) {
      throw new Error(
        "No enabled LLM providers in config DB. " +
          "INSERT INTO llm_providers (id, kind, display_name, enabled) VALUES (...);",
      );
    }

    const botId = process.env.CHRONO_BOT;
    if (botId) {
      const bot = resolveBot(config, models, botId);
      if (!bot) {
        throw new Error(`Bot "${botId}" not found or disabled in config DB.`);
      }
      systemPrompt = bot.systemPrompt || DEFAULT_SYSTEM_PROMPT;
      model = bot.resolvedModel.model;
    } else {
      const bots = config.listBots();
      const enabled = bots.filter((b) => b.enabled !== 0);
      if (enabled.length === 0) {
        throw new Error(
          "No enabled bot profiles in config DB. " +
            "INSERT INTO bot_profiles (id, display_name, model_ref, enabled) VALUES (...);",
        );
      }
      const bot = resolveBot(config, models, enabled[0]!.id);
      if (!bot) {
        throw new Error(`Failed to resolve bot "${enabled[0]!.id}".`);
      }
      systemPrompt = bot.systemPrompt || DEFAULT_SYSTEM_PROMPT;
      model = bot.resolvedModel.model;
    }
    streamFn = models.streamSimple.bind(models);
  }

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      tools: [],
      thinkingLevel: "minimal",
    },
    streamFn,
    toolExecution: "sequential",
    sessionId: "chrono-m1",
  });

  agent.subscribe((event) => {
    logEvent(event);
  });

  // ── Event loop ─────────────────────────────────────────────────
  const inboundQueue: ChronoEvent[] = [];
  const inboundWaiters: InboundWaiter[] = [];
  let stdinClosed = false;
  let stdinError: Error | null = null;

  const nextInbound = (): Promise<ChronoEvent | null> => {
    if (inboundQueue.length > 0) {
      return Promise.resolve(inboundQueue.shift() ?? null);
    }
    if (stdinClosed) {
      return stdinError
        ? Promise.reject(stdinError)
        : Promise.resolve(null);
    }
    return new Promise<ChronoEvent | null>((resolve, reject) => {
      inboundWaiters.push({ resolve, reject });
    });
  };

  const deliverInbound = (event: ChronoEvent) => {
    const waiter = inboundWaiters.shift();
    if (waiter) waiter.resolve(event);
    else inboundQueue.push(event);
  };

  const closeInbound = (err?: Error) => {
    stdinClosed = true;
    stdinError = err ?? null;
    while (inboundWaiters.length > 0) {
      const w = inboundWaiters.shift();
      if (!w) break;
      if (err) w.reject(err);
      else w.resolve(null);
    }
    for (const [id, pending] of pendingCalls) {
      pending.reject(err ?? new Error("stdin closed"));
      pendingCalls.delete(id);
    }
  };

  const readerTask = (async () => {
    try {
      for await (const payload of readFrames(stdinAsWebStream())) {
        let msg: unknown;
        try {
          msg = JSON.parse(new TextDecoder().decode(payload));
        } catch (err) {
          logEvent({
            type: "host_error",
            message: `invalid JSON on stdin: ${err instanceof Error ? err.message : String(err)}`,
          });
          continue;
        }

        if (isToolResponse(msg)) {
          const pending = pendingCalls.get(msg.tool_call_id);
          if (pending) {
            pendingCalls.delete(msg.tool_call_id);
            pending.resolve(msg);
          } else {
            logEvent({
              type: "host_warn",
              message: `orphan tool.response for ${msg.tool_call_id}`,
            });
          }
          continue;
        }

        if (isInboundMessage(msg)) {
          deliverInbound(msg);
          continue;
        }

        logEvent({
          type: "host_warn",
          message: `unknown stdin message type: ${JSON.stringify(messageTypeOf(msg))}`,
        });
      }
      closeInbound();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      logEvent({ type: "host_error", message: e.message });
      closeInbound(e);
    }
  })();

  while (true) {
    let event: ChronoEvent | null;
    try {
      event = await nextInbound();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent({ type: "host_error", message });
      writeControl({ type: "error", message });
      process.exitCode = 1;
      break;
    }

    if (!event) break;

    agent.state.tools = [
      createMessageSendTool(event.session_key, pendingCalls, agent.signal),
    ];

    try {
      await agent.prompt(event.message.text);
      writeControl({ type: "done" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent({ type: "host_error", message });
      writeControl({ type: "error", message });
      process.exitCode = 1;
      break;
    }
  }

  await readerTask.catch(() => undefined);
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      type: "host_fatal",
      message,
    }) + "\n",
  );
  try {
    writeControl({ type: "error", message });
  } catch {
    // stdout may already be closed
  }
  process.exit(1);
});
