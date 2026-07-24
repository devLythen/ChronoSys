import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model, Api, MutableModels } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ChronoEvent, ToolIpcMessage } from "./ipc/types.ts";
import { createFakeStreamFn, FAKE_MODEL } from "./fake-llm.ts";
import { createToolsForAllowlist, type PendingCall } from "./tools.ts";
import {
  readFrames,
  stdinAsWebStream,
  writeFrameStdout,
} from "./transport.ts";
import { openConfig, type ChronoConfig } from "./config.ts";
import {
  buildModels,
  resolveBot,
  type ResolvedBot,
} from "./resolve.ts";
import { SessionStore, sessionsDbPath } from "./session-store.ts";

const DEFAULT_SYSTEM_PROMPT =
  "You are an assistant in a chat platform. When asked to send a message, use the message_send tool.";

const FAKE_SEND_TEXT = "Hello from ChronoSys!";

/** Supported context scopes. Only "session" is implemented; others fall back. */
type ContextScope = "session" | "bot" | "account";

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
  return (
    !!msg &&
    typeof msg === "object" &&
    "type" in msg &&
    msg.type === "tool.response"
  );
}

function isInboundMessage(msg: unknown): msg is ChronoEvent {
  return (
    !!msg &&
    typeof msg === "object" &&
    "type" in msg &&
    msg.type === "inbound.message"
  );
}

function messageTypeOf(msg: unknown): string | undefined {
  if (msg && typeof msg === "object" && "type" in msg && typeof msg.type === "string") {
    return msg.type;
  }
  return undefined;
}

type InboundWaiter = {
  resolve: (v: ChronoEvent | null) => void;
  reject: (e: Error) => void;
};

/** Cache of resolved bot profiles for the lifetime of this process. */
class BotProfileCache {
  private cache = new Map<string, ResolvedBot>();

  constructor(
    private config: ChronoConfig | null,
    private models: MutableModels | null,
    private fallback: ResolvedBot | null,
  ) {}

  get(botId: string | undefined): ResolvedBot | null {
    if (!botId) return this.fallback;
    const hit = this.cache.get(botId);
    if (hit) return hit;
    if (!this.config || !this.models) return this.fallback;
    const bot = resolveBot(this.config, this.models, botId);
    if (!bot) {
      logEvent({
        type: "host_warn",
        message: `bot profile "${botId}" not found; using fallback`,
      });
      return this.fallback;
    }
    this.cache.set(botId, bot);
    return bot;
  }
}

/**
 * Per-conversation transcript bucket.
 * Keyed by session_key + bot_profile_id + generation (after /new).
 */

function contextScopeOf(bot: ResolvedBot): ContextScope {
  const raw = bot.policy.context_scope;
  if (raw === "bot" || raw === "account" || raw === "session") return raw;
  return "session";
}

function newSessionCommandEnabled(bot: ResolvedBot): boolean {
  const commands = bot.policy.commands;
  if (commands && typeof commands === "object" && !Array.isArray(commands)) {
    const flag = (commands as Record<string, unknown>).new_session;
    if (typeof flag === "boolean") return flag;
  }
  // Default: allow /new
  return true;
}

/** Strip Telegram bot-command suffix: "/new@BotName" → "/new" */
function normalizeCommand(text: string): string {
  const t = text.trim();
  const m = t.match(/^\/([a-zA-Z0-9_]+)(?:@\S+)?(?:\s+(.*))?$/);
  if (!m) return t;
  const cmd = m[1] ?? "";
  const rest = (m[2] ?? "").trim();
  return rest ? `/${cmd} ${rest}` : `/${cmd}`;
}

function isNewSessionCommand(text: string): boolean {
  const n = normalizeCommand(text).toLowerCase();
  return n === "/new" || n === "/newsession" || n === "/reset";
}

async function main() {
  const fakeLlm = process.env.CHRONO_FAKE_LLM === "1";
  const pendingCalls = new Map<string, PendingCall>();

  // ── Resolve model + streamFn + default bot profile ────────────
  let streamFn: StreamFn;
  let defaultModel: Model<Api>;
  let defaultSystemPrompt = DEFAULT_SYSTEM_PROMPT;
  let defaultToolsAllowlist: string[] = [];
  let config: ChronoConfig | null = null;
  let models: MutableModels | null = null;
  let fallbackBot: ResolvedBot | null = null;

  if (fakeLlm) {
    streamFn = createFakeStreamFn(FAKE_SEND_TEXT);
    defaultModel = FAKE_MODEL;
    defaultToolsAllowlist = ["message_send"];
    fallbackBot = {
      id: "fake",
      modelRef: "fake/fake",
      resolvedModel: { model: FAKE_MODEL, overrides: null },
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      toolsAllowlist: ["message_send"],
      skillsAllowlist: [],
      policy: { context_scope: "session", commands: { new_session: true } },
    };
  } else {
    const chronoHome = process.env.CHRONO_HOME ?? ".chrono";
    const dbPath = `${chronoHome}/state/chrono.db`;
    config = openConfig(dbPath);
    models = buildModels(config);
    if (!models) {
      throw new Error(
        "No enabled LLM providers in config DB. " +
          "INSERT INTO llm_providers (id, kind, display_name, enabled) VALUES (...);",
      );
    }

    const botId = process.env.CHRONO_BOT;
    let bot: ResolvedBot | null = null;
    if (botId) {
      bot = resolveBot(config, models, botId);
      if (!bot) {
        throw new Error(`Bot "${botId}" not found or disabled in config DB.`);
      }
    } else {
      const bots = config.listBots();
      const enabled = bots.filter((b) => b.enabled !== 0);
      if (enabled.length === 0) {
        throw new Error(
          "No enabled bot profiles in config DB. " +
            "INSERT INTO bot_profiles (id, display_name, model_ref, enabled) VALUES (...);",
        );
      }
      bot = resolveBot(config, models, enabled[0]!.id);
      if (!bot) {
        throw new Error(`Failed to resolve bot "${enabled[0]!.id}".`);
      }
    }

    fallbackBot = bot;
    defaultSystemPrompt = bot.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    defaultModel = bot.resolvedModel.model;
    defaultToolsAllowlist = bot.toolsAllowlist;
    streamFn = models.streamSimple.bind(models);

    logEvent({
      type: "host_info",
      message: `default bot profile: id=${bot.id} model=${bot.modelRef} tools=${JSON.stringify(bot.toolsAllowlist)} scope=${contextScopeOf(bot)}`,
    });
  }

  const profiles = new BotProfileCache(config, models, fallbackBot);

  // One Agent instance; transcript isolation is done by swapping state.messages.
  const agent = new Agent({
    initialState: {
      systemPrompt: defaultSystemPrompt,
      model: defaultModel,
      tools: [],
      thinkingLevel: "minimal",
    },
    streamFn,
    toolExecution: "sequential",
    sessionId: "chrono-host",
  });

  agent.subscribe((event) => {
    logEvent(event);
  });

  /**
   * Persistent UUID sessions + process cache.
   * routeKey = session_key + "#" + bot_id  (routing)
   * sessionId = random UUID                 (conversation instance)
   */
  const chronoHome = process.env.CHRONO_HOME ?? ".chrono";
  const store = new SessionStore(sessionsDbPath(chronoHome));
  type Bucket = { sessionId: string; messages: AgentMessage[] };
  const sessions = new Map<string, Bucket>();

  function getOrCreateBucket(
    route: string,
    sessionKey: string,
    botId: string,
  ): Bucket {
    let bucket = sessions.get(route);
    if (!bucket) {
      const rec = store.getOrCreateActive(route, sessionKey, botId);
      bucket = { sessionId: rec.sessionId, messages: rec.messages };
      sessions.set(route, bucket);
      logEvent({
        type: "host_info",
        message: `session loaded route=${route} id=${rec.sessionId} history=${rec.messages.length}`,
      });
    }
    return bucket;
  }

  function persistBucket(bucket: Bucket): void {
    store.save(bucket.sessionId, bucket.messages);
  }

  function rotateSession(
    route: string,
    sessionKey: string,
    botId: string,
  ): Bucket {
    const rec = store.rotate(route, sessionKey, botId);
    const bucket = { sessionId: rec.sessionId, messages: [] as AgentMessage[] };
    sessions.set(route, bucket);
    return bucket;
  }

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

    const bot = profiles.get(event.bot_profile_id);
    if (!bot) {
      logEvent({
        type: "host_error",
        message: `no bot profile for event (bot_profile_id=${event.bot_profile_id ?? "none"})`,
      });
      writeControl({
        type: "error",
        message: `no bot profile for event`,
      });
      continue;
    }

    // Reserved: bot/account shared context is not implemented yet.
    const scope = contextScopeOf(bot);
    if (scope !== "session") {
      logEvent({
        type: "host_warn",
        message: `context_scope=${scope} is reserved/TODO; falling back to session isolation for bot=${bot.id}`,
      });
    }

    const route = `${event.session_key}#${bot.id}`;

    // ── Platform commands (Telegram /new etc.) ───────────────────
    if (isNewSessionCommand(event.message.text)) {
      if (!newSessionCommandEnabled(bot)) {
        logEvent({
          type: "host_info",
          message: `session command disabled by policy for bot=${bot.id}`,
        });
        writeControl({ type: "done" });
        continue;
      }
      const bucket = rotateSession(route, event.session_key, bot.id);
      logEvent({
        type: "host_info",
        message: `session rotated route=${route} id=${bucket.sessionId}`,
      });
      agent.state.systemPrompt = bot.systemPrompt || DEFAULT_SYSTEM_PROMPT;
      agent.state.model = bot.resolvedModel.model;
      agent.state.messages = [];
      agent.state.tools = createToolsForAllowlist(
        bot.toolsAllowlist.length > 0 ? bot.toolsAllowlist : defaultToolsAllowlist,
        event.session_key,
        pendingCalls,
        agent.signal,
      );
      try {
        const tools = agent.state.tools;
        const send = tools.find((t) => t.name === "message_send");
        if (send) {
          await send.execute(`cmd_new_${Date.now()}`, {
            text: `已开启新会话（${bucket.sessionId.slice(0, 8)}…），之前的对话上下文已清空。`,
          });
        }
        writeControl({ type: "done" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logEvent({ type: "host_error", message });
        writeControl({ type: "error", message });
      }
      continue;
    }

    // ── Load active UUID session transcript ──────────────────────
    const bucket = getOrCreateBucket(route, event.session_key, bot.id);
    agent.state.systemPrompt = bot.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    agent.state.model = bot.resolvedModel.model;
    agent.state.messages = bucket.messages;
    agent.state.tools = createToolsForAllowlist(
      bot.toolsAllowlist.length > 0 ? bot.toolsAllowlist : defaultToolsAllowlist,
      event.session_key,
      pendingCalls,
      agent.signal,
    );

    logEvent({
      type: "host_info",
      message: `turn bot=${bot.id} model=${bot.modelRef} tools=${JSON.stringify(bot.toolsAllowlist)} route=${route} session_id=${bucket.sessionId} history=${bucket.messages.length}`,
    });

    try {
      await agent.prompt(event.message.text);
      bucket.messages = agent.state.messages.slice();
      persistBucket(bucket);
      writeControl({ type: "done" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent({ type: "host_error", message });
      bucket.messages = agent.state.messages.slice();
      persistBucket(bucket);
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
