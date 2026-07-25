import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model, Api, MutableModels } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ChronoEvent, ToolIpcMessage } from "./ipc/types.ts";
import {
  createToolsForAllowlist,
  sendBodyTextToCurrentChat,
  type PendingCall,
} from "./tools.ts";
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
  "You are an assistant on a chat platform. Prefer the message_send tool for all intentional outbound messages (optionally set chat_id to reach another chat). Plain body text without the tool only falls back to the current chat.";


/** Supported context scopes. Only "session" is implemented; others fall back. */
type ContextScope = "session" | "bot" | "account";

function logEvent(event: unknown) {
  if (!event || typeof event !== "object") return;
  const e = event as Record<string, unknown>;
  const type = String(e.type ?? "");
  const level = type.startsWith("host_error") || type === "agent_error" ? "error"
    : type.startsWith("host_warn") ? "warn"
    : "info";

  // Skip verbose internal events — only log operational messages
  switch (type) {
    case "agent_start": return;
    case "turn_start": return;
    case "turn_end": return;
    case "agent_end": {
      const msgs = e.messages as Array<Record<string,unknown>> | undefined;
      const last = msgs?.[msgs.length - 1];
      const stopReason = last?.stopReason ?? "?";
      const usage = last?.usage as Record<string,number> | undefined;
      const tokens = usage ? `${usage.totalTokens ?? 0} tokens` : "";
      logLine(level, `response: stop=${stopReason} ${tokens}`);
      return;
    }
    case "stream_delta": return;
    case "stream_end": return;
    case "message_update": return;
    case "message_start": return;
    case "message_end": return;
    case "tool_call": return;
    case "tool_result": return;
    case "tool_execution_start": return;
    case "tool_execution_end": return;
  }

  // Only reachable for events NOT in the switch above

  // Extract message from operational events
  let msg = String(e.message ?? "");
  if (!msg || msg === "[object Object]") {
    msg = type.replace(/^host_/, "").replace(/_/g, " ");
  }
  logLine(level, msg);
}

function logLine(level: string, message: string) {
  const c = level === "error" ? "\x1b[31;1m"
    : level === "warn" ? "\x1b[33m"
    : "\x1b[36m";
  process.stderr.write(`${c}[agent] ${message}\x1b[0m\n`);
}


function writeControl(msg: Record<string, unknown>) {
  writeFrameStdout(new TextEncoder().encode(JSON.stringify(msg)));
}

async function pushModelCapabilities(models: MutableModels | null) {
  const caps: Record<string, unknown> = {};
  if (models) {
    for (const provider of models.getProviders()) {
      for (const model of provider.getModels()) {
        const key = `${provider.id}/${model.id}`;
        caps[key] = {
          name: model.name, reasoning: model.reasoning,
          thinkingLevels: model.thinkingLevelMap ? Object.keys(model.thinkingLevelMap) : [],
          maxTokens: model.maxTokens, contextWindow: model.contextWindow,
          input: model.input,
        };
      }
    }
  }
  await fetch("http://127.0.0.1:8787/api/v1/internal/model-capabilities", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ models: caps }),
  });
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

/**
 * Resolve bot profiles from the config DB on each lookup (hot-read).
 * No long-lived stale cache: DB edits apply without restarting agent-host.
 * (Still one open SQLite handle; cheap SELECT per turn.)
 */
class BotProfileResolver {
  constructor(
    private config: ChronoConfig | null,
    private models: MutableModels | null,
    private fallback: ResolvedBot | null,
  ) {}

  get(botId: string | undefined): ResolvedBot | null {
    if (!botId) return this.fallback;
    if (!this.config || !this.models) return this.fallback;
    const bot = resolveBot(this.config, this.models, botId);
    if (!bot) {
      logEvent({
        type: "host_warn",
        message: `bot profile "${botId}" not found; using fallback`,
      });
      return this.fallback;
    }
    return bot;
  }
}

function contextScopeOf(bot: ResolvedBot): ContextScope {
  const raw = bot.policy.context_scope;
  if (raw === "bot" || raw === "account" || raw === "session") return raw;
  return "session";
}

/** Max transcript messages allowed before refusing a new prompt. 0 / missing = unlimited. */
function maxContextMessages(bot: ResolvedBot): number {
  const raw = bot.policy.max_context_messages;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return 0;
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

/** Collect plain text blocks from an assistant message (ignore toolCall parts). */
function extractAssistantText(message: AgentMessage | undefined): string {
  if (!message || message.role !== "assistant") return "";
  if (!Array.isArray(message.content)) return "";
  const parts: string[] = [];
  for (const c of message.content) {
    if (c && typeof c === "object" && "type" in c && c.type === "text" && "text" in c) {
      const t = c.text;
      if (typeof t === "string" && t.trim()) parts.push(t);
    }
  }
  return parts.join("\n").trim();
}

async function main() {
  const pendingCalls = new Map<string, PendingCall>();

  // ── Sentinel placeholders — never used when unconfigured ──────
  const PLACEHOLDER_MODEL = { id: "__unconfigured__", name: "Unconfigured", api: "faux" as Api, provider: "__unconfigured__", baseUrl: "", reasoning: false, input: [] as string[], maxTokens: 4096, temperature: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096 } as Model<Api>;
  const PLACEHOLDER_STREAM: StreamFn = () => { throw new Error("Agent not configured"); };

  let streamFn: StreamFn = PLACEHOLDER_STREAM;
  let defaultModel: Model<Api> = PLACEHOLDER_MODEL;
  let defaultSystemPrompt = DEFAULT_SYSTEM_PROMPT;
  let defaultToolsAllowlist: string[] = [];
  let config: ChronoConfig | null = null;
  let models: MutableModels | null = null;
  let fallbackBot: ResolvedBot | null = null;

  const chronoHome = process.env.CHRONO_HOME ?? ".chrono";
    const dbPath = `${chronoHome}/state/chrono.db`;
    config = openConfig(dbPath);
    models = buildModels(config);
    if (!models) {
      logEvent({
        type: "host_info",
        message: "No enabled LLM providers yet — configure via WebUI",
      });
    }

    if (models) {
      const botId = process.env.CHRONO_BOT;
      let bot: ResolvedBot | null = null;
      if (botId) {
        bot = resolveBot(config, models, botId);
        if (!bot) {
          logEvent({
            type: "host_info",
            message: `Bot "${botId}" not found — configure via WebUI`,
          });
        }
      } else {
        const bots = config.listBots();
        if (bots.length > 0) {
          bot = resolveBot(config, models, bots[0]!.id);
          if (!bot) {
            logEvent({
              type: "host_info",
              message: `Failed to resolve bot "${bots[0]!.id}"`,
            });
          }
        } else {
          logEvent({
            type: "host_info",
            message: "No bot profiles yet — configure via WebUI",
          });
        }
      }

      if (bot) {
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

    }
  // Push capabilities to gateway via HTTP (retry until success)
  (async () => {
    for (let i = 0; i < 30; i++) {
      try {
        await pushModelCapabilities(models);
        return;
      } catch { await new Promise(r => setTimeout(r, 1000)); }
    }
  })();

  // One Agent instance; transcript isolation is done by swapping state.messages.

  const profiles = new BotProfileResolver(config, models, fallbackBot);
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
          if (!models || !fallbackBot) {
            writeControl({
              type: "host_error",
              message: "Agent not configured. Add providers + bot profiles via WebUI.",
            });
            continue;
          }
          deliverInbound(msg);
          continue;
        }

        const controlType = messageTypeOf(msg);
        if (controlType === "steer") {
          const sessionId =
            msg && typeof msg === "object" && "session_id" in msg
              ? String((msg as { session_id: unknown }).session_id)
              : "";
          const text =
            msg && typeof msg === "object" && "text" in msg
              ? String((msg as { text: unknown }).text)
              : "";
          if (!text) {
            logEvent({
              type: "host_warn",
              message: "steer missing text",
            });
            continue;
          }
          // If agent is mid-run, inject via steer(); otherwise queue as inbound user message.
          if (agent.signal) {
            agent.steer({
              role: "user",
              content: text,
              timestamp: Date.now(),
            } as AgentMessage);
            logEvent({
              type: "host_info",
              message: `steer injected mid-run session_id=${sessionId}`,
            });
          } else {
            // Idle: deliver as a synthetic inbound for the active session if we can map it.
            // Without platform chat context we log and no-op for idle steer on unknown session.
            logEvent({
              type: "host_info",
              message: `steer received while idle session_id=${sessionId}; queueing as follow-up if active`,
            });
            agent.followUp({
              role: "user",
              content: text,
              timestamp: Date.now(),
            } as AgentMessage);
          }
          continue;
        }

        if (controlType === "abort") {
          const sessionId =
            msg && typeof msg === "object" && "session_id" in msg
              ? String((msg as { session_id: unknown }).session_id)
              : "";
          agent.abort();
          logEvent({
            type: "host_info",
            message: `abort requested session_id=${sessionId}`,
          });
          continue;
        }

        if (controlType === "config.reload") {
          if (config) {
            const newModels = buildModels(config);
            if (newModels) {
              models = newModels;
              streamFn = models.streamSimple.bind(models);
              pushModelCapabilities(models);
              // Re-resolve default bot
              const bots = config.listBots();
              if (bots.length > 0) {
                const bot = resolveBot(config, models, bots[0]!.id);
                if (bot) {
                  fallbackBot = bot;
                  defaultSystemPrompt = bot.systemPrompt || DEFAULT_SYSTEM_PROMPT;
                  defaultModel = bot.resolvedModel.model;
                  defaultToolsAllowlist = bot.toolsAllowlist;
                  logEvent({
                    type: "host_info",
                    message: `config.reload: bot=${bot.id} model=${bot.modelRef} providers=${models.getProviders().length}`,
                  });
                }
              }
            } else {
              logEvent({
                type: "host_warn",
                message: "config.reload: still no enabled providers",
              });
            }
          }
          continue;
        }

        logEvent({
          type: "host_warn",
          message: `unknown stdin message type: ${JSON.stringify(controlType)}`,
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

    // Hot-read bot profile from config DB each turn (no stale process cache).
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

    // Context limit (bot policy). Refuse before LLM if over cap.
    // Future: compaction + long-term memory should replace hard refuse.
    const maxMsgs = maxContextMessages(bot);
    if (maxMsgs > 0 && bucket.messages.length >= maxMsgs) {
      logEvent({
        type: "host_error",
        message: `context overflow refused bot=${bot.id} session_id=${bucket.sessionId} history=${bucket.messages.length} max_context_messages=${maxMsgs}`,
      });
      try {
        await sendBodyTextToCurrentChat(
          event.session_key,
          `上下文已满（${bucket.messages.length}/${maxMsgs} 条消息），本轮请求已拒绝。请发送 /new 开启新会话，或提高 bot policy.max_context_messages。`,
          pendingCalls,
          agent.signal,
        );
      } catch (err) {
        logEvent({
          type: "host_warn",
          message: `failed to notify context overflow: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      writeControl({ type: "done" });
      continue;
    }

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
      const historyBefore = bucket.messages.length;
      await agent.prompt(event.message.text);
      bucket.messages = agent.state.messages.slice();
      persistBucket(bucket);

      // Fallback: plain assistant body → current chat only (no cross-chat).
      // Prefer message_send (optional chat_id) for intentional / cross-chat delivery.
      const usedTool = bucket.messages.slice(historyBefore).some((m) => {
        if (m.role === "toolResult") return true;
        if (m.role !== "assistant" || !Array.isArray(m.content)) return false;
        return m.content.some(
          (c) => c && typeof c === "object" && "type" in c && c.type === "toolCall",
        );
      });

      if (!usedTool) {
        const lastAssistant = [...bucket.messages]
          .reverse()
          .find((m) => m.role === "assistant");
        const body = extractAssistantText(lastAssistant);
        if (body) {
          logEvent({
            type: "host_info",
            message: `body-text fallback to current chat only (${body.length} chars)`,
          });
          await sendBodyTextToCurrentChat(
            event.session_key,
            body,
            pendingCalls,
            agent.signal,
          );
        }
      }

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
  process.stderr.write(`\x1b[31;1m[agent] ${message}\x1b[0m\n`);
  try {
    writeControl({ type: "error", message });
  } catch {
    // stdout may already be closed
  }
  process.exit(1);
});
