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
LlmProvider    logical provider slot (my-llm | openai | custom id)
LlmCredential  secret material for a provider (encrypted / env-ref / oauth)
LlmModelRef    allowlisted model (provider_id + model_id); no implicit catalog use
Account        platform + credentials + adapter config (one login identity)
BotProfile     system prompt, model_ref, tools/skills allowlist, policies
Binding        Account × ChatPattern → BotProfile + plugin set
Session        durable agent conversation tree (pi Session semantics)
ChronoEvent    normalized inbound (message, reaction, member, …)
ToolInvocation audited outbound effect
MemoryItem     scoped K/V with TTL
PluginManifest name, version, capabilities, entry, resources
```

**Fail closed / no business defaults:** entities that gate runtime must be **explicitly created**. There is no built-in default bot, default model, default account, or “first available provider”. Missing config → refuse to start the affected path (clear error), never invent a fallback.

Session key:

```text
session_key = hash(account_id, chat_id, thread_id?, mode)
// mode: "shared" (group one agent) | "dm" | "per_user" (group but private state)
```

### 5.1 Configuration store (source of truth)

Runtime multi-entity state lives in a **local SQLite database** under `$CHRONO_HOME`, not scattered env vars.

| Path | Role |
|------|------|
| `$CHRONO_HOME/state/chrono.db` | Config + binding + account metadata + model allowlist + grants index |
| `$CHRONO_HOME/secrets/` | Encrypted credential blobs (or OS keychain refs); never plaintext in DB by default |
| `$CHRONO_HOME/config.toml` | **Process bootstrap only** (bind address, log level, db path override). Not the place for bots/models/accounts. |
| `$CHRONO_HOME/sessions/` | pi session transcripts (orthogonal to config DB) |

Why SQLite (not only TOML):

- Multi-row entities: many accounts, many bots, many providers, many bindings.
- Atomic updates + migrations; WebUI / CLI / gateway share one store.
- Easy backups (`chrono backup` = copy `CHRONO_HOME`).
- Extensible: versioned schema + `json_ext` column per row for forward-compatible fields without rewriting core tables every feature.

**TOML is bootstrap, DB is product state.** Shipping a sample `config.toml` must not imply a runnable bot without `chrono config` / WebUI setup.

#### Schema (logical tables)

```text
schema_migrations(version, applied_at)

llm_providers(
  id TEXT PK,                 -- "my-llm" | "openai" | "my-proxy"
  kind TEXT NOT NULL,         -- "builtin" | "openai_compat" | "anthropic_compat" | ...
  base_url TEXT,              -- required for custom; null = pi builtin default for kind
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL,   -- 0/1
  json_ext TEXT,              -- headers, routing prefs, …
  created_at, updated_at
)

llm_credentials(
  provider_id TEXT PK → llm_providers,
  auth_kind TEXT NOT NULL,     -- "api_key" | "oauth" | "env_ref"
  secret_ref TEXT NOT NULL,   -- path under secrets/ or keychain id or env name
  -- NEVER store raw API keys in this row when auth_kind=api_key; store ref only
  json_ext TEXT,
  updated_at
)

--- Per-model allowlist: only rows explicitly selected by the operator are loaded.
--- Discovery: after registering a provider, the operator refreshes the model
--- catalogue from pi-ai → presented in WebUI → checks desired models →
--- each checked row is INSERTed here with optional per-model overrides.
llm_models(
  provider_id TEXT NOT NULL → llm_providers,   -- composite PK
  model_id TEXT NOT NULL,     -- pi catalog id, e.g. "gpt-5" or "claude-sonnet-4-6"
  display_name TEXT,          -- optional alias shown in WebUI
  enabled INTEGER NOT NULL,
  -- Per-model overrides (all optional; null = provider / bot default):
  temperature REAL,
  max_tokens INTEGER,
  top_p REAL,
  extra_headers_json TEXT,    -- extra HTTP headers appended to provider defaults
  extra_body_json TEXT,       -- extra JSON body fields merged into each request
  thinking_level TEXT,        -- default thinking level for this model
  json_ext TEXT,              -- future extensions without schema churn
  created_at, updated_at,
  PRIMARY KEY (provider_id, model_id)
)

platform_accounts(
  id TEXT PK,
  platform TEXT NOT NULL,     -- "telegram" | "qq" | …
  display_name TEXT NOT NULL,
  adapter_id TEXT NOT NULL,   -- plugin / builtin adapter id
  enabled INTEGER NOT NULL,
  secret_ref TEXT NOT NULL,   -- bot token etc.
  adapter_config_json TEXT NOT NULL,  -- non-secret adapter knobs (webhook url, …)
  json_ext TEXT,
  created_at, updated_at
)

--- Model reference: "provider_id/model_id" string, resolved at runtime
--- against llm_models. No foreign key — the string is self-describing
--- and portable; missing rows surface as clear error, not silent null.
bot_profiles(
  id TEXT PK,
  display_name TEXT NOT NULL,
  system_prompt TEXT NOT NULL,       -- empty string allowed only if explicitly set
  model_ref TEXT NOT NULL,           -- "my-llm/main-model" format; REQUIRED
  tools_allowlist_json TEXT NOT NULL,        -- [] = no tools
  skills_allowlist_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  json_ext TEXT,
  created_at, updated_at
)

bindings(
  id TEXT PK,
  account_id TEXT NOT NULL → platform_accounts,
  chat_pattern TEXT NOT NULL,  -- exact id | glob | "dm:*" | …
  bot_profile_id TEXT NOT NULL → bot_profiles,
  session_mode TEXT NOT NULL,  -- shared | dm | per_user
  priority INTEGER NOT NULL,  -- higher wins
  enabled INTEGER NOT NULL,
  json_ext TEXT,
  UNIQUE(account_id, chat_pattern, bot_profile_id)
)

settings(
  key TEXT PK,                -- process/feature flags only
  value_json TEXT NOT NULL,
  updated_at
)
```

#### Model discovery & selection flow

```text
1. Operator: chrono llm provider add my-llm --kind builtin
   → INSERT llm_providers row; llm_models is empty

2. Operator: chrono llm provider refresh my-llm   (or WebUI "Refresh models" button)
   → agent-host calls pi-ai getModels("my-llm") → returns all known model ids
   → WebUI presents checklist: ☐ gpt-5, ☐ claude-haiku-4-5, …
   → checked models → INSERT llm_models rows with operator's per-model overrides

3. Operator creates a bot:
   chrono bot add greeter --model my-llm/main-model --system-prompt-file …
   → model_ref = "my-llm/main-model"

4. Runtime: agent-host parses model_ref → looks up llm_models WHERE provider_id='my-llm' AND model_id='main-model'
   → not found or disabled → hard error
   → build pi Model<Api> + apply per-model overrides (temperature, extra_headers, …)
```

Per-model overrides merge order (later wins):

```text
provider defaults (base_url, headers)
   → llm_models overrides (temperature, max_tokens, extra_headers, …)
      → bot_profiles.json_ext per-bot overrides (if any in future)
         → runtime signal (abort timeout, …)
```

Rules:

1. **No row ⇒ no capability.** Empty `llm_models` ⇒ agent-host refuses non-fake runs. Empty `platform_accounts` ⇒ gateway starts control plane only (or `chrono dev --fake-llm` demo path).
2. **`bot_profiles.model_ref` is mandatory** and must resolve to an enabled `llm_models` row. Format: `"provider_id/model_id"` (e.g. `"my-llm/main-model"`, `"my-proxy/my-fine-tune"`).
3. **Model catalogue is pi-ai's job.** ChronoSys does not maintain its own model directory. Discovery calls pi-ai; selection is stored in `llm_models`.
4. **Secrets by reference.** Gateway / agent-host load secrets through a vault interface; audit who resolved what.
5. **`json_ext` + migrations** for evolution; do not fork the core entity set for every new knob.
6. **IDs are stable strings** (ULID/UUID or user-chosen slugs); WebUI and CLI share the same IDs.
```

Rules:

1. **No row ⇒ no capability.** Empty `llm_models` ⇒ agent-host refuses non-fake runs. Empty `platform_accounts` ⇒ gateway starts control plane only (or `chrono dev --fake-llm` demo path).
2. **`bot_profiles.model_ref` is mandatory.** Profiles without a resolvable enabled model are invalid and cannot be bound.
3. **Secrets by reference.** Gateway / agent-host load secrets through a vault interface; audit who resolved what.
4. **`json_ext` + migrations** for evolution; do not fork the core entity set for every new knob.
5. **IDs are stable strings** (ULID/UUID or user-chosen slugs); WebUI and CLI share the same IDs.

#### LLM runtime: reuse `@earendil-works/pi-ai` (not a parallel provider stack)

ChronoSys **does not** reimplement multi-provider HTTP. Configuration DB → pi `Models` at process start (and on hot-reload):

```ts
import { createModels, createProvider } from "@earendil-works/pi-ai";

// 1. Build CredentialStore from llm_credentials + vault adapter
// 2. For each enabled llm_providers row:
//    - builtin → models already have stream; just resolve credential
//    - custom (compat_openai / compat_anthropic kind) → createProvider({ id, baseUrl, api }) + setProvider
// 3. Per-bot resolution at prompt time:
//    const [providerId, modelId] = bot.model_ref.split("/");
//    const piModel = models.getModel(providerId, modelId);
//    if (!piModel) throw error("model not configured");
//    // Fetch per-model overrides from llm_models row:
//    const overrides = db.getModelOverrides(providerId, modelId);
//    // Pass to streamSimple as options: { temperature: overrides.temperature, ... }
// 4. streamFn = models.streamSimple.bind(models)
```

| Concern | Owner |
|---------|--------|
| Provider HTTP, streaming, retries, cost, model catalogue | **pi-ai** |
| Which providers/credentials exist | **Chrono config DB** |
| Which models from a provider are selected + per-model tuning | **Chrono `llm_models`** |
| Auth material storage | **Chrono secrets/** + thin `CredentialStore` adapter |
| Per-bot model choice | **BotProfile.model_ref** |
| Demo without keys | Explicit `CHRONO_FAKE_LLM=1` / `--fake-llm` only |

M1 temporary wiring (`CHRONO_MODEL` env + "first available model") is **not** the product model and must be removed once the config store lands.

#### Platform accounts & adapters

```text
platform_accounts.adapter_id  →  PlatformAdapter implementation
platform_accounts.secret_ref  →  bot token / cookie / device session
platform_accounts.adapter_config_json → non-secret knobs
bindings                     →  which BotProfile handles which chats
```

- Adding a platform = new adapter plugin + optional JSON Schema for `adapter_config_json` (validated on write).
- Adding an account = insert row + secret; **no auto-bind**. Operator must create a `bindings` row or traffic is dropped with audit reason `no_binding`.
- Adding an LLM = provider row + credential + **explicit** `llm_models` allowlist entry + bot profile pointing at it.

#### Lifecycle / multi-state

| State | Meaning |
|-------|---------|
| `enabled=0` | Soft-disabled; retained for audit; not loaded into runtime |
| missing secret | Config present but **unhealthy**; surface in WebUI; refuse sessions using it |
| binding conflict | Highest `priority` wins; ties → deterministic id order; log warning |
| config reload | Gateway watches DB version / notifies agent-host; in-flight sessions keep old snapshot until idle (document cutover) |

Control plane APIs (CLI + WebUI later) are the only writers; agent tools never mutate provider credentials.

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