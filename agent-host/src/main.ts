import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateContextTokens, generateSummary, estimateTokens } from "@earendil-works/pi-agent-core";
import type { Model, Api, MutableModels, ThinkingLevel } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ChronoEvent, ToolIpcMessage } from "./ipc/types.ts";
import {
  sendBodyTextToCurrentChat,
  type PendingCall,
} from "./tools.ts";
import { ToolRegistry } from "./plugins/registry.ts";
import {
  readFrames,
  stdinAsWebStream,
  writeFrameStdout,
} from "./transport.ts";
import { openConfig, type ChronoConfig } from "./config.ts";
import type { LlmModel } from "./config-types.ts";
import {
  buildModels,
  resolveBot,
  resolveModelRef,
  queryModelCaps,
  resolveThinkingLevel,
  buildStreamOverrides,
  type ResolvedBot,
  type ModelCaps,
} from "./resolve.ts";
import { SessionStore, sessionsDbPath } from "./session-store.ts";

const DEFAULT_SYSTEM_PROMPT =
  "You are a chat bot.";

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
    case "turn_end": {
      // Extract tool calls from turn_end message (before tool execution)
      const msg = e.message as Record<string,unknown> | undefined;
      if (msg?.role === "assistant") {
        const content = msg.content as Array<Record<string,unknown>> | undefined;
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c?.type === "toolCall") {
              const name = c.name ?? "?";
              if (name === "message_send") {
                try {
                  const a = typeof c.arguments === "string" ? JSON.parse(c.arguments as string) : (c.arguments ?? {}) as Record<string,unknown>;
                  const text = typeof a.text === "string" ? a.text : "";
                  const preview = text.length > 100 ? text.slice(0, 100) + "…" : text;
                  logTool(`send: "${preview}"`);
                } catch {
                }
              } else {
                logTool(String(name));
              }
            }
          }
        }
      }
      return;
    }
    case "agent_end": {
      const msgs = e.messages as Array<Record<string,unknown>> | undefined;
      const last = msgs?.[msgs.length - 1];
      // Log tool calls embedded in assistant message content
      if (last && last.role === "assistant") {
        const content = last.content as Array<Record<string,unknown>> | undefined;
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c?.type === "toolCall") {
              const name = c.name ?? "?";
              const args = typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {});
              if (name === "message_send") {
                try {
                  const a = JSON.parse((typeof c.arguments === "string" ? c.arguments : "{}") as string);
                  const text = typeof a.text === "string" ? a.text : "";
                  const preview = text.length > 100 ? text.slice(0, 100) + "…" : text;
                  logTool(`send: "${preview}"`);
                } catch {
                  logTool(`message_send (parse error)`);
                }
              } else {
                logTool(`${name} ${args.slice(0, 80)}`);
              }
            }
          }
        }
      }
      // Token stats
      const stopReason = last?.stopReason ?? "?";
      const u = last?.usage as Record<string,number> | undefined;
      if (u) {
        const parts: string[] = [];
        if (typeof u.input === "number") parts.push(`${u.input} in`);
        if (typeof u.output === "number") parts.push(`${u.output} out`);
        if (typeof u.reasoning === "number" && u.reasoning > 0) parts.push(`${u.reasoning} think`);
        parts.push(`${u.totalTokens ?? 0} total`);
        logLine(level, `  finish ${stopReason} (${parts.join(", ")})`);
      } else {
        logLine(level, `  finish ${stopReason}`);
      }
      // Surface stream / model errors so operators can diagnose
      if (stopReason === "error") {
        const detail = JSON.stringify((last ?? e) as Record<string,unknown>, null, 0).slice(0, 500);
        logLine("error", `  ↳ ${detail}`);
      }
      return;
    }
    case "stream_delta": return;
    case "stream_end": return;
    case "message_update": return;
    case "message_start": return;
    case "message_end": return;
    case "tool_call": {
      const name = e.name ?? "?";
      if (name === "message_send") {
        try {
          const a = JSON.parse((typeof e.arguments === "string" ? e.arguments : "{}") as string);
          const text = typeof a.text === "string" ? a.text : "";
          const preview = text.length > 100 ? text.slice(0, 100) + "…" : text;
          logTool(`send: "${preview}"`);
        } catch {
          logTool(`message_send (parse error)`);
        }
      } else {
        const args = typeof e.arguments === "string" ? e.arguments : JSON.stringify(e.arguments ?? {});
        logTool(`${name} ${args.slice(0, 80)}`);
      }
      return;
    }
    case "tool_result": return;
    case "tool_execution_start": return;
    case "tool_execution_end": return;
  }

  // Only reachable for events NOT in the switch above
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

function logTool(message: string) {
  process.stderr.write(`\x1b[35m[tool] ${message}\x1b[0m\n`);
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

  reload(config: ChronoConfig | null, models: MutableModels | null, fallback: ResolvedBot | null) {
    this.config = config ?? this.config;
    this.models = models ?? this.models;
    if (fallback) this.fallback = fallback;
  }

  get(botId: string | undefined): ResolvedBot | null {
    if (!botId) return this.fallback;
    if (!this.config || !this.models) return this.fallback;
    try {
      const bot = resolveBot(this.config, this.models, botId);
      if (!bot) {
        logEvent({
          type: "host_warn",
          message: `bot profile "${botId}" not found; using fallback`,
        });
        return this.fallback;
      }
      return bot;
    } catch (err) {
      logEvent({
        type: "host_warn",
        message: `bot profile "${botId}" resolution error: ${err instanceof Error ? err.message : String(err)}`,
      });
      return this.fallback;
    }
  }
}

function contextScopeOf(bot: ResolvedBot): ContextScope {
  const raw = bot.policy.context_scope;
  if (raw === "bot" || raw === "account" || raw === "session") return raw;
  return "session";
}


// ── Context policy ─────────────────────────────────────────────

type CompactStrategy = "compact" | "drop";

interface ContextPolicy {
  /** Max turns before compaction triggers. -1 = disabled. Default -1. */
  maxTurns: number;
  /** Turns to discard when LLM compaction unavailable. Default 1. */
  dropTurns: number;
  /** Strategy when over limit. Default "drop". */
  compactStrategy: CompactStrategy;
  /** Model ref ("provider/model") for compaction LLM. Empty = use chat model. */
  compactModelRef: string;
  /** Custom system prompt for the compaction LLM call. */
  compactPrompt: string;
  /** Fallback context window when model unknown. Default 128000. */
  contextWindowFallback: number;
  /** Prepend [HH:MM:SS] to every message (user + assistant). Default false. */
  showTimestamp: boolean;
  /** How sender identity is attached to user messages. */
  senderIdentity: SenderIdentity;
  /** IANA timezone for timestamps and the get_time tool. Default "UTC". */
  timezone: string;
}

/** Sender identity attachment mode. */
type SenderIdentity = "none" | "prefix" | "block";

function parseSenderIdentity(raw: unknown): SenderIdentity {
  return raw === "prefix" || raw === "block" ? raw : "none";
}

function readContextPolicy(bot: ResolvedBot): ContextPolicy {
  const p = bot.policy;
  return {
    maxTurns: typeof p.max_turns === "number" ? p.max_turns : -1,
    dropTurns: typeof p.drop_turns === "number" && p.drop_turns > 0 ? p.drop_turns : 1,
    compactStrategy: p.compact_strategy === "compact" ? "compact" : "drop",
    compactModelRef: typeof p.compact_model_ref === "string" ? p.compact_model_ref : "",
    compactPrompt: typeof p.compact_prompt === "string" ? p.compact_prompt : "",
    contextWindowFallback:
      typeof p.context_window_fallback === "number" && p.context_window_fallback > 0
        ? p.context_window_fallback
        : 128000,
    showTimestamp: Boolean(p.show_timestamp),
    senderIdentity: parseSenderIdentity(p.sender_identity),
    timezone: typeof p.timezone === "string" && p.timezone ? p.timezone : "UTC",
  };
}
// ── Message prefix builders ────────────────────────────────────

function formatTime(iso: string, timezone: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-US", {
      hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
      timeZone: timezone,
    });
  } catch {
    return "??:??:??";
  }
}


function getDate(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}
/** Attach sender identity according to policy. "block" puts a verified
 *  header at the START of the message so users cannot preempt it; the
 *  system prompt must document this format and instruct the model to trust
 *  only the first occurrence. "prefix" is the legacy inline format. */
function buildSenderIdentity(event: ChronoEvent, policy: ContextPolicy): string {
  if (policy.senderIdentity === "block") {
    return `### SYSTEM SENDER\nid: ${event.sender.id}\nname: ${event.sender.name}\nplatform: ${event.platform}\n### END\n\n`;
  }
  if (policy.senderIdentity === "prefix") {
    return `[${event.platform} ${event.sender.name} (${event.sender.id})] `;
  }
  return "";
}

function buildUserPrefix(event: ChronoEvent, policy: ContextPolicy): string {
  return policy.showTimestamp ? `[${formatTime(event.received_at, policy.timezone)}] ` : "";
}
function resolveContextWindow(model: Model<Api>, policy: ContextPolicy): number {
  return model.contextWindow > 0 ? model.contextWindow : policy.contextWindowFallback;
}

/** Count user→assistant rounds. Each role:"user" message opens a new turn. */
function countTurns(messages: readonly AgentMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role === "user") n++;
  }
  return n;
}

/** True when a command is disabled by the bot's policy.disabled_commands
 *  blacklist. Absent or empty blacklist = all commands enabled. */
function commandDisabled(bot: ResolvedBot, name: string): boolean {
  const disabled = bot.policy.disabled_commands;
  return Array.isArray(disabled) && disabled.includes(name);
}

function newSessionCommandEnabled(bot: ResolvedBot): boolean {
  return !commandDisabled(bot, "new");
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

function isCompactCommand(text: string): boolean {
  return normalizeCommand(text).toLowerCase() === "/compact";
}

/** Default compaction instructions used when the bot policy leaves
 *  compact_prompt empty. */
const DEFAULT_COMPACT_PROMPT =
  "Preserve the assistant's persona, tone, and behavioral guidelines. " +
  "Keep every user constraint, decision, and unresolved task accurate.";

/** Compose compaction instructions: the configured compact prompt (or the
 *  default) plus the bot's system prompt so the summary retains its persona.
 *  The system prompt guides the summary — it is not part of the summarized
 *  conversation content. */
function buildCompactionInstructions(custom: string | undefined, systemPrompt: string | undefined): string | undefined {
  const parts: string[] = [];
  parts.push(custom && custom.trim() ? custom.trim() : DEFAULT_COMPACT_PROMPT);
  if (systemPrompt && systemPrompt.trim()) {
    parts.push(`The assistant's system prompt (preserve its persona and constraints):\n${systemPrompt.trim()}`);
  }
  return parts.join("\n\n");
}

async function compactSessionMessages(
  messages: AgentMessage[],
  models: MutableModels,
  model: Model<Api>,
  signal?: AbortSignal,
  customInstructions?: string,
  systemPrompt?: string,
): Promise<AgentMessage[]> {
  const countCut = Math.max(1, Math.floor(messages.length * 0.4));
  const keepTokens = Math.floor(model.contextWindow * 0.5);
  let cutIndex: number;
  if (messages.length < 20) {
    cutIndex = countCut;
  } else {
    let accum = 0;
    cutIndex = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      accum += estimateTokens(messages[i]!);
      if (accum >= keepTokens) { cutIndex = i; break; }
    }
    if (cutIndex <= 0) cutIndex = countCut;
  }
  const oldMessages = messages.slice(0, cutIndex);
  const recentMessages = messages.slice(cutIndex);

  const instructions = buildCompactionInstructions(customInstructions, systemPrompt);
  const result = await generateSummary(
    oldMessages,
    models,
    model,
    keepTokens,
    signal,
    instructions,
  );
  if (!result.ok) {
    logEvent({ type: "host_warn", message: `compaction failed: ${result.error.message}` });
    return messages;
  }

  const summaryMsg: AgentMessage = {
    role: "assistant",
    content: [{ type: "text", text: `[Previous conversation summary]\n${result.value}` }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };

  return [summaryMsg, ...recentMessages];
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
  /** Mutable cell for current DB model overrides — read by wrapped streamFn. */
  const currentOverrides: { v: LlmModel | null } = { v: null };

  function makeStreamFn(models: MutableModels): StreamFn {
    const base = models.streamSimple.bind(models);
    return (model, ctx, options) => {
      const ov = buildStreamOverrides(currentOverrides.v);
      return base(model, ctx, { ...options, ...ov });
    };
  }
  let defaultModel: Model<Api> = PLACEHOLDER_MODEL;
  let defaultSystemPrompt = DEFAULT_SYSTEM_PROMPT;
  let defaultToolsAllowlist: string[] = [];
  let config: ChronoConfig | null = null;
  let models: MutableModels | null = null;
  let fallbackBot: ResolvedBot | null = null;

  const chronoHome = process.env.CHRONO_HOME ?? ".chrono";
  const registry = new ToolRegistry(chronoHome, (message) => logEvent({ type: "host_warn", message }));
  try {
    await registry.reload();
  } catch (error) {
    logEvent({ type: "host_warn", message: `plugin registry initial reload failed: ${error instanceof Error ? error.message : String(error)}` });
  }
  const dbPath = `${chronoHome}/state/chrono.db`;
    config = openConfig(dbPath);
    await registry.reconcilePersonas(new Set(config.listPersonas().map((persona) => persona.id)));
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
        try {
          bot = resolveBot(config, models, botId);
        } catch (err) {
          logEvent({
            type: "host_warn",
            message: `Bot "${botId}" resolution failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        if (!bot) {
          logEvent({
            type: "host_info",
            message: `Bot "${botId}" not found — configure via WebUI`,
          });
        }
      } else {
        const bots = config.listBots();
        if (bots.length > 0) {
          try {
            bot = resolveBot(config, models, bots[0]!.id);
          } catch (err) {
            logEvent({
              type: "host_warn",
              message: `Bot "${bots[0]!.id}" resolution failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
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
        streamFn = makeStreamFn(models);
        currentOverrides.v = bot.resolvedModel.overrides;

        logEvent({
          type: "host_info",
          message: `default bot profile: id=${bot.id} model=${bot.modelRef} tools=${JSON.stringify(bot.toolsAllowlist)} scope=${contextScopeOf(bot)}`,
        });
      }

    }

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
  type Bucket = { sessionId: string; messages: AgentMessage[]; lastDate: string };
  const sessions = new Map<string, Bucket>();

  function getOrCreateBucket(
    route: string,
    sessionKey: string,
    botId: string,
  ): Bucket {
    let bucket = sessions.get(route);
    if (!bucket) {
      const rec = store.getOrCreateActive(route, sessionKey, botId);
      bucket = { sessionId: rec.sessionId, messages: rec.messages, lastDate: rec.lastDate };
      sessions.set(route, bucket);
      logEvent({
        type: "host_info",
        message: `session loaded route=${route} id=${rec.sessionId} history=${rec.messages.length}`,
      });
    }
    return bucket;
  }

  function persistBucket(bucket: Bucket): void {
    store.save(bucket.sessionId, bucket.messages, bucket.lastDate);
  }

  function rotateSession(
    route: string,
    sessionKey: string,
    botId: string,
  ): Bucket {
    const rec = store.rotate(route, sessionKey, botId);
    const bucket = { sessionId: rec.sessionId, messages: [] as AgentMessage[], lastDate: "" };
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

        if (controlType === "plugin.list") {
          const queryId = msg && typeof msg === "object" && "query_id" in msg ? String(msg.query_id) : "";
          writeControl({ type: "plugin.list", query_id: queryId, plugins: registry.list() });
          continue;
        }
        if (controlType === "plugin.reload") {
          const queryId = msg && typeof msg === "object" && "query_id" in msg ? String(msg.query_id) : "";
          try {
            await registry.reload();
            writeControl({ type: "plugin.reload", query_id: queryId, plugins: registry.list() });
          syncPluginCommands(registry);
          } catch (error) {
            logEvent({ type: "host_warn", message: `plugin.reload failed: ${error instanceof Error ? error.message : String(error)}` });
            writeControl({ type: "plugin.reload", query_id: queryId, plugins: registry.list(), error: error instanceof Error ? error.message : String(error) });
          }
          continue;
        }
        if (controlType === "plugin.policy") {
          const queryId = msg && typeof msg === "object" && "query_id" in msg ? String(msg.query_id) : "";
          const pluginId = msg && typeof msg === "object" && "plugin_id" in msg ? String(msg.plugin_id) : "";
          const policy = msg && typeof msg === "object" && "policy" in msg ? msg.policy : undefined;
          try {
            const plugin = await registry.updatePolicy(pluginId, policy as import("./plugins/policy.ts").PluginPolicy);
            writeControl({ type: "plugin.policy", query_id: queryId, plugins: registry.list(), plugin });
          } catch (error) {
            writeControl({ type: "plugin.policy", query_id: queryId, plugins: registry.list(), error: error instanceof Error ? error.message : String(error) });
          }
          continue;
        }
 
         if (controlType === "config.reload") {
          try { await registry.reload(); } catch (error) { logEvent({ type: "host_warn", message: `plugin registry reload failed: ${error instanceof Error ? error.message : String(error)}` }); }
          if (config) await registry.reconcilePersonas(new Set(config.listPersonas().map((p) => p.id)));
          syncPluginCommands(registry);
          if (config) {
            const newModels = buildModels(config);
            if (newModels) {
              models = newModels;
              streamFn = makeStreamFn(models);
              profiles.reload(config, models, fallbackBot);
              const bots = config.listBots();
              if (bots.length > 0) {
                try {
                  const bot = resolveBot(config, models, bots[0]!.id);
                  if (bot) {
                    fallbackBot = bot;
                    defaultSystemPrompt = bot.systemPrompt || DEFAULT_SYSTEM_PROMPT;
                    defaultModel = bot.resolvedModel.model;
                    defaultToolsAllowlist = bot.toolsAllowlist;
                    currentOverrides.v = bot.resolvedModel.overrides;
                  }
                } catch { /* keep old fallback */ }
                for (const bp of bots) {
                  try {
                    const b = resolveBot(config, models, bp.id);
                    logEvent({ type: "host_info", message: `config.reload: bot=${b?.id ?? bp.id} model=${b?.modelRef ?? "?"}` });
                  } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    logEvent({ type: "host_warn", message: `config.reload: bot "${bp.id}" model unavailable — ${message}` });
                  }
                }
              } else { logEvent({ type: "host_warn", message: "config.reload: no bot profiles" }); }
            } else { logEvent({ type: "host_warn", message: "config.reload: no providers" }); }
          }
          continue;
        }

        if (controlType === "model.caps") {
          const providerId =
            msg && typeof msg === "object" && "provider_id" in msg
              ? String(msg.provider_id)
              : "";
          const modelId =
            msg && typeof msg === "object" && "model_id" in msg
              ? String(msg.model_id)
              : "";
          const queryId =
            msg && typeof msg === "object" && "query_id" in msg
              ? String(msg.query_id)
              : "";
          const caps: ModelCaps | null = queryModelCaps(providerId, modelId);
          writeControl({ type: "model.caps", query_id: queryId, ...(caps ? caps : { error: "model not found" }) });
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
    currentOverrides.v = bot.resolvedModel.overrides;

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
      agent.state.thinkingLevel = resolveThinkingLevel(
        bot.resolvedModel.model,
        bot.resolvedModel.overrides,
      ) as ThinkingLevel;
      agent.state.messages = [];
      agent.state.tools = registry.createToolsForAllowlist(
        bot.toolsAllowlist.length > 0 ? bot.toolsAllowlist : defaultToolsAllowlist,
        event.session_key,
        pendingCalls,
        agent.signal,
        bot.personaId ?? undefined,
        readContextPolicy(bot).timezone,
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

    const disabledCommands = Array.isArray(bot.policy.disabled_commands) ? (bot.policy.disabled_commands as string[]) : undefined;
    if (await registry.executeCommand(event.message.text, event.session_key, pendingCalls, agent.signal, disabledCommands)) {
      logEvent({ type: "host_info", message: `plugin command executed for bot=${bot.id}` });
      writeControl({ type: "done" });
      continue;
    }

    // ── /compact — manual context compaction ─────────────────
    if (isCompactCommand(event.message.text)) {
      if (commandDisabled(bot, "compact")) {
        logEvent({ type: "host_info", message: `compact command disabled by policy for bot=${bot.id}` });
        writeControl({ type: "done" });
        continue;
      }
      const bucket = getOrCreateBucket(route, event.session_key, bot.id);
      if (bucket.messages.length < 2) {
        await sendBodyTextToCurrentChat(event.session_key, "对话太短，无需压缩。", pendingCalls, agent.signal);
        writeControl({ type: "done" });
        continue;
      }
      const ccp = readContextPolicy(bot);
      let cm = bot.resolvedModel.model;
      if (ccp.compactModelRef && models) {
        try { cm = resolveModelRef(config, models, ccp.compactModelRef).model; } catch { /* fall through */ }
      }
      const compacted = await compactSessionMessages(
        bucket.messages,
        models!,
        cm,
        agent.signal,
        ccp.compactPrompt || undefined,
        bot.systemPrompt,
      );
      const origEst = estimateContextTokens(bucket.messages);
      const origPct = Math.round((origEst.tokens / bot.resolvedModel.model.contextWindow) * 100);
      bucket.messages = compacted;
      agent.state.messages = compacted;
      persistBucket(bucket);
      const newEst = estimateContextTokens(compacted);
      const newPct = Math.round((newEst.tokens / bot.resolvedModel.model.contextWindow) * 100);
      const summary = `上下文已压缩：占用 ${newPct}%（压缩前 ${origPct}%）。`;
      await sendBodyTextToCurrentChat(event.session_key, summary, pendingCalls, agent.signal);
      writeControl({ type: "done" });
      continue;
    }

    // ── Load active UUID session transcript ──────────────────────
    const bucket = getOrCreateBucket(route, event.session_key, bot.id);

    // ── Context management (bot policy) ──────────────────────────
    const ctxPolicy = readContextPolicy(bot);
    const ctxWindow = resolveContextWindow(bot.resolvedModel.model, ctxPolicy);
    const turnCount = countTurns(bucket.messages);

    // Resolve compaction model (falls back to chat model if empty / unavailable)
    let compactModel = bot.resolvedModel.model;
    if (ctxPolicy.compactModelRef && models) {
      try {
        compactModel = resolveModelRef(config, models, ctxPolicy.compactModelRef).model;
      } catch (e) {
        logEvent({ type: "host_warn", message: `compact model ${ctxPolicy.compactModelRef} unavailable: ${e instanceof Error ? e.message : String(e)}` });
      }
    }

    if (ctxPolicy.maxTurns !== -1 && turnCount > ctxPolicy.maxTurns && bucket.messages.length >= 2) {
      if (ctxPolicy.compactStrategy === "compact" && models) {
        const compacted = await compactSessionMessages(
          bucket.messages,
          models,
          compactModel,
          agent.signal,
          ctxPolicy.compactPrompt || undefined,
          bot.systemPrompt,
        );
        if (compacted !== bucket.messages) {
          bucket.messages = compacted;
          persistBucket(bucket);
          logEvent({
            type: "host_info",
            message: `auto-compacted (policy) bot=${bot.id} turns=${turnCount}/${ctxPolicy.maxTurns} messages=${bucket.messages.length}`,
          });
        }
      } else {
        const dropCount = ctxPolicy.dropTurns;
        let cut = 0;
        let dropped = 0;
        for (let i = 0; i < bucket.messages.length && dropped < dropCount; i++) {
          if (bucket.messages[i]!.role === "user") dropped++;
          cut = i + 1;
        }
        if (cut > 0 && cut < bucket.messages.length) {
          bucket.messages = bucket.messages.slice(cut);
          persistBucket(bucket);
          logEvent({
            type: "host_info",
            message: `dropped old turns bot=${bot.id} turns=${turnCount}/${ctxPolicy.maxTurns} kept=${bucket.messages.length}`,
          });
        }
      }
    }

    agent.state.systemPrompt = bot.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    agent.state.model = bot.resolvedModel.model;
    agent.state.thinkingLevel = resolveThinkingLevel(
      bot.resolvedModel.model,
      bot.resolvedModel.overrides,
    ) as ThinkingLevel;

    // Inject date separator if the current message's date differs from the last stored date
    const today = getDate(event.received_at);
    if (today && today !== bucket.lastDate) {
      bucket.messages.push({ role: "user", content: `[${today}]` } as AgentMessage);
      bucket.lastDate = today;
      persistBucket(bucket);
    }
    agent.state.messages = bucket.messages;
    agent.state.tools = registry.createToolsForAllowlist(
      bot.toolsAllowlist.length > 0 ? bot.toolsAllowlist : defaultToolsAllowlist,
      event.session_key,
      pendingCalls,
      agent.signal,
      bot.personaId ?? undefined,
      ctxPolicy.timezone,
    );

    logEvent({
      type: "host_info",
      message: `${bot.id} #${bucket.sessionId.slice(0, 8)} h=${bucket.messages.length} model=${bot.modelRef}`,
    });

    // ── Request-time context window guard ──────────────────────────
    const preEst = estimateContextTokens(bucket.messages);
    if (preEst.tokens > ctxWindow * 0.85 && bucket.messages.length >= 2) {
      if (ctxPolicy.compactStrategy === "compact" && models) {
        const compacted = await compactSessionMessages(
          bucket.messages, models, compactModel, agent.signal,
          ctxPolicy.compactPrompt || undefined,
          bot.systemPrompt,
        );
        if (compacted !== bucket.messages) {
          bucket.messages = compacted;
          agent.state.messages = compacted;
          persistBucket(bucket);
          logEvent({ type: "host_info", message: `pre-prompt compact bot=${bot.id} tokens=${preEst.tokens}/${ctxWindow}` });
        }
      } else {
        const dropCount = ctxPolicy.dropTurns;
        let cut = 0;
        let dropped = 0;
        for (let i = 0; i < bucket.messages.length && dropped < dropCount; i++) {
          if (bucket.messages[i]!.role === "user") dropped++;
          cut = i + 1;
        }
        if (cut > 0 && cut < bucket.messages.length) {
          bucket.messages = bucket.messages.slice(cut);
          agent.state.messages = bucket.messages;
          persistBucket(bucket);
          logEvent({ type: "host_info", message: `pre-prompt drop bot=${bot.id} tokens=${preEst.tokens}/${ctxWindow}` });
        }
      }
    }

    try {
      const historyBefore = bucket.messages.length;
      const userPrefix = buildUserPrefix(event, ctxPolicy);
      const senderIdentity = buildSenderIdentity(event, ctxPolicy);
      await agent.prompt(senderIdentity + userPrefix + event.message.text);

      bucket.messages = agent.state.messages.slice();
      persistBucket(bucket);

      // ── Post-turn auto-compact when context exceeds 80% threshold ──
      const postEst = estimateContextTokens(bucket.messages);
      if (postEst.tokens > ctxWindow * 0.8 && bucket.messages.length >= 4 && ctxPolicy.compactStrategy === "compact" && models) {
        const compacted = await compactSessionMessages(
          bucket.messages, models, compactModel, agent.signal,
          ctxPolicy.compactPrompt || undefined,
          bot.systemPrompt,
        );
        if (compacted !== bucket.messages) {
          bucket.messages = compacted;
          agent.state.messages = compacted;
          persistBucket(bucket);
          logEvent({ type: "host_info", message: `post-turn compact bot=${bot.id} tokens=${postEst.tokens}/${ctxWindow}` });
        }
      }
      // Fallback: if agent responds with text instead of message_send tool,
      // deliver the text to the current chat anyway.
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
            message: `  text reply (no tool): "${body.slice(0, 80)}${body.length > 80 ? "…" : ""}"`,
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
      // Model/stream failures are recoverable (network, auth, provider
      // errors): keep the host alive for the next inbound message instead
      // of exiting the process. Only stdin loss is fatal (handled above).
      continue;
    }
  }

  await readerTask.catch(() => undefined);
  process.exit(process.exitCode ?? 0);
}

function syncPluginCommands(registry: ToolRegistry) {
  const commands = registry.list().flatMap((p) => p.commands.filter((c) => c.enabled).map((c) => ({ name: c.name, description: c.description })));
  writeControl({ type: "host_command_sync", commands });
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
