# ChronoSys Architecture

Agent-centric chat integration framework: platforms (Telegram / QQ / WeChat / …) are adapters; **all side effects go through AI tool calls**. Agent loop is powered by the **pi** agent harness via npm (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`).

## 1. Goals

| Goal | How |
|------|-----|
| Agent-first | Inbound IM events become agent prompts; outbound actions only via tools (`send_message`, `sandbox.exec`, …) |
| Reuse pi | TypeScript runtime embeds `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` (not coding-agent CLI) |
| Modern / fast | Rust gateway + IPC; Bun/Node agent workers; streaming events end-to-end |
| Extensible | Manifest plugins (tools / skills / adapters / hooks) with capability-scoped sandbox |
| Easy deploy | Single binary + sidecar OCI image; `chrono up` with zero host pollution |
| Zero pollution | XDG data dirs, no global npm/pip, no host `~/.pi` mutation unless opted in |

Non-goals (v1): reimplement LLM providers; fork pi; full desktop IM client UI.

---

## 2. Language domains

```
┌─────────────────────────────────────────────────────────────────┐
│  WebUI (TypeScript / Vite)                                      │
│  Admin · sessions · plugins · live tool traces                   │
└────────────────────────────┬────────────────────────────────────┘
                             │ WebSocket / HTTP (JSON)
┌────────────────────────────▼────────────────────────────────────┐
│  chrono-gateway  (Rust)  ★ process boundary                       │
│  Platform adapters · auth · rate limits · media · event bus      │
│  Plugin host (WASM + subprocess) · sandbox supervisor            │
└──────────────┬─────────────────────────────┬────────────────────┘
               │ NATS-like inproc + UDS/JSONL │
┌──────────────▼──────────────┐  ┌───────────▼────────────────────┐
│  agent-host (TypeScript)    │  │  tool runtimes                  │
│  pi Agent / AgentHarness    │  │  · Rust sandbox (default)       │
│  chat tools + convertToLlm  │  │  · Python plugin worker (opt)   │
│  session / compaction       │  │  · WASM tools (pure compute)    │
└─────────────────────────────┘  └────────────────────────────────┘
```

| Domain | Language | Why |
|--------|----------|-----|
| Platform I/O, media, concurrency, sandbox OS | **Rust** | High fan-in bots, zero-copy media, Landlock/seccomp/bwrap, single static binary |
| Agent loop, LLM, tool schema, skills | **TypeScript (pi)** | Reuse mature pi stack; avoid rewriting providers/tool loop |
| Optional data/ML tools, notebooks-style plugins | **Python** | Ecosystem; isolated venv per plugin; never on hot path |
| WebUI | **TypeScript** | Same event types as agent-host; fast SPA |

**Decision:** Do **not** reimplement the agent core in Rust or Python. pi owns the loop; ChronoSys owns IM + policy + isolation + ops.

---

## 3. Reused pi surface

Published npm packages (pin `@0.81.1` in M0; bump both packages together on upgrades).

| Package | Use in ChronoSys |
|---------|------------------|
| `@earendil-works/pi-agent-core` | `Agent`, `AgentHarness`, session storage, tool execution modes, hooks |
| `@earendil-works/pi-ai` | Multi-provider models, auth, streaming, cost tracking |
| `@earendil-works/pi-storage-sqlite-node` | Durable sessions (optional; also JSONL) |
| coding-agent **patterns only** | Skills (`SKILL.md`), extension/tool registration shapes, RPC event names |
| coding-agent CLI / TUI | **Not** required at runtime |

Integration style (preferred):

```ts
// agent-host: embed SDK, not `pi --mode rpc` subprocess (lower latency, typed)
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
// register ChronoSys tools only (no default read/write/bash of host FS)
```

Fallback: spawn pi coding-agent RPC for debugging parity; production uses embedded host.

### 3.1 Tool philosophy (aligned with pi)

- Tools are `AgentTool` with TypeBox schemas.
- Side effects **only** in `execute()`; errors throw (pi maps to `isError`).
- `beforeToolCall` / `afterToolCall` for policy (allowlist, rate, human-in-the-loop).
- Parallel tool execution by default; sequential for message-order-sensitive tools.
- Custom `AgentMessage` roles via declaration merging for platform system events (join/leave, reactions) that `convertToLlm` may filter or summarize.

### 3.2 Built-in chat tools (v1)

| Tool | Purpose |
|------|---------|
| `message.send` | Send text/media to chat/thread |
| `message.reply` | Reply to message id |
| `message.edit` / `message.delete` | Mutate own messages where platform allows |
| `message.react` | Reactions |
| `chat.history` | Fetch recent messages (paginated, redacted) |
| `chat.members` | Roster / permissions (capped) |
| `media.download` | Pull attachment into sandbox workspace |
| `sandbox.exec` | Run command in per-session sandbox |
| `sandbox.read` / `sandbox.write` | Sandbox FS only |
| `memory.get` / `memory.put` | Scoped key-value (agent/user/chat) |
| `plugin.call` | Invoke named plugin capability |

Platform adapters implement a **Capability** trait; missing capabilities return structured “unsupported” tool errors.

---

## 4. System components

### 4.1 `chrono-gateway` (Rust)

Single long-lived process (or HA cluster later).

Responsibilities:

1. **Adapter runtime** — load platform plugins (dynamic lib or subprocess protocol).
2. **Ingress** — normalize platform events → `ChronoEvent`.
3. **Routing** — map `(platform, account, chat_id[, thread_id])` → agent session key.
4. **Egress** — execute tool effects requested by agent-host (send, react, …).
5. **Policy** — ACLs, rate limits, content filters, human approval gates.
6. **Sandbox supervisor** — create/destroy session sandboxes; enforce cgroup/network.
7. **Control plane** — HTTP/WS API for WebUI + ops.
8. **Plugin host** — lifecycle, capabilities, resource quotas.

Hot path: adapter → event bus → session router → agent-host (UDS) → tools → gateway effects.

### 4.2 `agent-host` (TypeScript / Bun preferred)

One process per machine (or pool of workers). Multiple concurrent agent sessions.

- Owns `Agent` / `AgentHarness` instances keyed by `SessionId`.
- Builds system prompt from bot persona + chat context + skill catalog.
- Registers tools that **call back into gateway** over IPC (tools never talk to Telegram/QQ APIs directly).
- Streams pi events → gateway → WebUI / optional platform “typing” indicators.
- Session persistence under ChronoSys data dir (not `~/.pi` unless configured).

### 4.3 Platform adapters

Unified interface:

```rust
#[async_trait]
trait PlatformAdapter: Send + Sync {
    fn id(&self) -> &str; // "telegram" | "qq" | "wechat" | ...
    async fn start(&self, sink: EventSink) -> Result<()>;
    async fn stop(&self) -> Result<()>;
    async fn invoke(&self, op: PlatformOp) -> Result<PlatformResult>;
    fn capabilities(&self) -> Capabilities;
}
```

`PlatformOp`: send, edit, delete, react, get_history, download_media, set_presence, …

Adapters ship as:

- Built-in crates for first-party platforms.
- **Out-of-tree plugins**: WASM (pure logic) or **stdio JSON-RPC child** (any language) with capability manifest.

### 4.4 Sandbox

Default: **per-session** workspace.

| Layer | Mechanism |
|-------|-----------|
| FS | Overlay / bind mount of empty workdir + optional RO mounts |
| Process | bubblewrap or Landlock + seccomp (Linux); Seatbelt/sandbox-exec notes on macOS |
| Network | Default **deny**; allowlist egress via gateway proxy only |
| Secrets | Never mounted; tools request secrets via gateway vault API with audit |
| Lifetime | TTL + idle GC; hard disk quota |

Agent `sandbox.*` tools talk to supervisor; pi’s built-in host `bash`/`write` tools are **disabled** by default.

### 4.5 Plugin system

See [PLUGIN_ARCHITECTURE.md](./PLUGIN_ARCHITECTURE.md).

### 4.6 WebUI

See [WEBUI.md](./WEBUI.md).

---

## 5. Data model (core)

```text
Account        platform + credentials + adapter config
BotProfile     system prompt, model prefs, default tools/skills, policies
Binding        Account × ChatPattern → BotProfile + plugin set
Session        durable agent conversation tree (pi Session semantics)
ChronoEvent    normalized inbound (message, reaction, member, …)
ToolInvocation audited outbound effect
MemoryItem     scoped K/V with TTL
PluginManifest name, version, capabilities, entry, resources
```

Session key (default):

```text
session_key = hash(account_id, chat_id, thread_id?, mode)
// mode: "shared" (group one agent) | "dm" | "per_user" (group but private state)
```

---

## 6. Event & IPC contracts

### 6.1 Ingress → agent

```json
{
  "type": "inbound.message",
  "session_key": "...",
  "event_id": "...",
  "platform": "telegram",
  "chat": { "id": "...", "kind": "group", "title": "..." },
  "sender": { "id": "...", "name": "..." },
  "message": {
    "id": "...",
    "text": "...",
    "reply_to": null,
    "attachments": []
  },
  "received_at": "2026-07-24T00:00:00Z"
}
```

Agent-host turns this into:

1. Optional system/context injection (chat metadata, memory hits).
2. `agent.prompt(...)` or steer if already running (policy: queue follow-up vs interrupt).

### 6.2 Agent tools → gateway

```json
{
  "type": "tool.request",
  "session_id": "...",
  "tool_call_id": "...",
  "name": "message.send",
  "args": { "text": "hi", "reply_to": "..." },
  "timeout_ms": 15000
}
```

Gateway validates capability + ACL, executes, returns:

```json
{
  "type": "tool.response",
  "tool_call_id": "...",
  "ok": true,
  "result": { "message_id": "..." }
}
```

Transport: **Unix domain socket + length-prefixed JSON** (or MessagePack later). Multiplex many sessions on one connection.

### 6.3 Streaming to UI

Map pi events:

| pi event | UI channel |
|----------|------------|
| `message_update` text_delta | `agent.delta` |
| `tool_execution_*` | `tool.trace` |
| `agent_end` | `agent.idle` |
| errors | `agent.error` |

---

## 7. Security model

1. **Least privilege tools** — profile-defined allowlist; no host shell by default.
2. **Adapter credentials** — encrypted at rest (OS keychain or age/sops file under data dir).
3. **Tool policy hooks** — block/confirm dangerous ops (mass DM, file exfil).
4. **Sandbox default-deny network**.
5. **Audit log** — append-only JSONL of tool invocations and adapter ops.
6. **Plugin capabilities** — declare required caps in manifest; user grants at install.
7. **Zero pollution** — see deploy doc; never write outside `CHRONO_HOME`.

---

## 8. Deployment topology

### Dev

```bash
chrono dev          # gateway + agent-host + webui (hot reload)
```

### Prod (single node)

```text
chrono-gateway (systemd/docker)
  ├── agent-host (child or sidecar)
  ├── sandboxes (transient)
  └── data volume: $CHRONO_HOME
```

### Prod (split)

- Gateway N replicas behind LB (sticky by session_key).
- Agent-host pool; session affinity via redis/nats (v2).
- Shared object store for media.

---

## 9. Package layout (repo)

```text
ChronoSys/
├── crates/
│   ├── chrono-gateway/       # binary + lib
│   ├── chrono-adapter/       # trait + common types
│   ├── chrono-adapters/       # telegram, qq (stub), wechat (stub)
│   ├── chrono-sandbox/        # supervisor
│   ├── chrono-plugin/         # host + protocol
│   ├── chrono-ipc/            # framing + schema
│   └── chrono-cli/            # chrono binary
├── agent-host/               # TypeScript package (Bun)
│   ├── src/
│   │   ├── main.ts
│   │   ├── session-manager.ts
│   │   ├── tools/
│   │   └── pi-bridge.ts
│   └── package.json          # deps: npm pins @earendil-works/pi-agent-core, pi-ai
├── plugins/
│   ├── python-runtime/       # protocol worker
│   └── examples/
├── webui/
├── deploy/
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── chrono.service
├── docs/
│   ├── ARCHITECTURE.md       # this file
│   ├── PLUGIN_ARCHITECTURE.md
│   ├── WEBUI.md
│   └── ROADMAP.md
└── README.md
```

Install pi from npm (never path-link a local monorepo):

```json
"@earendil-works/pi-agent-core": "0.81.1",
"@earendil-works/pi-ai": "0.81.1"
```

A personal local pi clone for reading upstream source is fine on a developer machine; it must not appear in `package.json`, lockfiles, or CI.

---

## 10. Performance notes

- Gateway: Tokio, bounded channels, no unbounded session queues.
- Media: stream to disk/object store; agent receives paths or signed URLs, not full base64 in context unless small.
- Context: compact via pi compaction; inject only recent window + memory hits.
- Tool parallel: safe tools concurrent; `message.*` ordering per chat via session-local mutex when needed.
- Prefer Bun for agent-host startup; Node ≥ 22.19 as pi requires.

---

## 11. Comparison: why not pure Rust / pure Python agent

| Approach | Cost |
|----------|------|
| Rewrite pi in Rust | Years of provider edge cases; loses pi updates |
| LangChain-style Python agent | Weaker tool/session semantics than pi harness; GIL on hot path |
| **pi embedded + Rust gateway** | Best reuse + best IM/sandbox performance |

This is the ChronoSys default.