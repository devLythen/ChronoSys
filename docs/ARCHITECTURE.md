# ChronoSys Architecture

Agent-centric chat integration framework: platforms (Telegram / QQ / WeChat / …) are adapters; **all outbound actions go through AI tool calls**. Agent loop is powered by **pi** (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`).

## Design Philosophy

**No magic defaults.** Every runtime entity (provider, model, bot profile, platform account, binding) must be explicitly created by the operator. There is no built-in "default bot" or "first available model". An empty config database on first deploy is normal and expected — the system starts and waits for WebUI configuration, then hot-reloads.

**Exist = enabled.** Providers and configs have no on/off switch. If they exist in the database, they are active. Only platform accounts have an enable/disable toggle — that's where operational control lives.

**Secrets are plaintext.** `secret_ref` stores the actual API key or bot token directly. No `env:VAR` or `file:PATH` indirection — just the value. The API returns it in responses so the WebUI can display and edit it.

**No legacy compatibility.** The project is pre-v1 and in active breaking-change development. When a data format, API contract, or policy schema is redesigned, the old format is removed immediately — not deprecated, not dual-path. Config migrations update existing data; no code carries backward-compatibility branches. This keeps the codebase lean and avoids the accumulation of "temporary" adapters that ossify into permanent complexity.

## 1. Crate Map

```
crates/
├── chrono-sys/              ┌─ entry point ─┐
│   └── main.rs              │  cargo run -p  │
│       → spawn gateway      │  chrono-sys    │
│       → open config DB     │  → ./chrono    │
│       → call run_gateway   └────────────────┘
│
├── chrono-gateway/          library — gateway core
│   ├── runner.rs            main event loop, adapter lifecycle, tool dispatch
│   ├── http.rs              axum HTTP server setup (bind, auth, webui dist)
│   ├── lib.rs               GatewayChild (agent-host process), frame I/O
│   ├── adapters.rs          adapter registry
│   └── adapter.rs           PlatformAdapter trait
│
├── chrono-api/              REST + WebSocket routes
│   ├── providers.rs         /api/v1/providers
│   ├── bots.rs              /api/v1/bots    (Config in UI)
│   ├── accounts.rs          /api/v1/accounts
│   ├── bindings.rs          /api/v1/bindings (Attach config in UI)
│   ├── sessions.rs          /api/v1/sessions
│   ├── tools.rs             /api/v1/tools — canonical tool catalog
│   ├── personas.rs          /api/v1/personas
│   ├── audit.rs             /api/v1/audit
│   ├── settings.rs          /api/v1/settings
│   ├── health.rs            /api/v1/health
│   └── ws.rs                /api/v1/ws
│
├── chrono-config/           SQLite config store (chrono.db schema + CRUD)
├── chrono-ipc/              length-prefixed JSON frame protocol
└── chrono-adapter-telegram/ Telegram platform adapter
```

---

## 2. Process Architecture
---

## 2. LLM Credential Flow

Agent-host bridges the config DB to pi-ai via `ChronoCredentialStore` (`agent-host/src/credential-store.ts`). When pi-ai needs an API key:

1. pi-ai calls `CredentialStore.read(providerId)`
2. `ChronoCredentialStore` queries `llm_credentials` in the config DB
3. Returns `{ type: "api_key", key: secret_ref }` — the plaintext key

This is the only path for LLM auth. There is no separate env var or config file for API keys.

---

## 4. Process Architecture
┌──────────────────────────────────────────────────────────┐
│  chrono (Rust)  — single binary, entry point             │
│  crates/chrono-sys/src/main.rs                           │
│  · resolve CHRONO_HOME  · open config DB                 │
│  · call run_gateway()                                    │
└──────────────────────┬───────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────┐
│  chrono-gateway (Rust)  — library, no binary              │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ HTTP server  │  │ Adapter mgr  │  │ Event router   │  │
│  │ (axum)       │  │ (telegram…)  │  │ (inbound→agent)│  │
│  │ :8787        │  │              │  │                │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                 │                   │           │
│         │   REST/WS       │   platform API    │  stdin    │
│         ▼                 ▼                   ▼           │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │  WebUI   │    │  Telegram    │    │  agent-host   │   │
│  │  (SPA)   │    │  QQ, WeChat  │    │  (Bun child)  │   │
│  └──────────┘    └──────────────┘    └──────────────┘   │
└──────────────────────────────────────────────────────────┘
```

**Hot path**: adapter inbound → `ChronoEvent` → frame to agent-host stdin → agent processes → tool call frame on stdout → gateway dispatches to adapter → outbound message.

---
## 5. Language Domains

| Domain | Language | Why |
|--------|----------|-----|
| Gateway (I/O, routing, HTTP, adapters) | **Rust** | High fan-in, zero-copy media, single static binary |
| Agent loop, LLM, tools | **TypeScript (Bun)** | Reuse pi stack; avoid rewriting providers/tool loop |
| WebUI | **TypeScript (React)** | Same event types as agent-host; fast SPA |

**Decision**: Do not reimplement the agent core in Rust. pi owns the agent loop; ChronoSys owns IM + routing + policy + ops.

---
## 6. Data Model

```
LlmProvider     provider slot (id, kind, base_url)
LlmCredential   API key (auth_kind, secret_ref — plaintext)
LlmModel        allowlisted model (provider_id + model_id, params)
Persona         system prompt + tools allowlist + skills allowlist
BotProfile      "Config" in UI — model_ref, persona_id FK, policy
PlatformAccount platform identity + secret_ref + adapter_config
Binding         "Attach config" in UI — account × chat_pattern → bot_profile
Session         durable conversation transcript (sessions.db)
```

**Persona is a separate table.** Persona fields (system_prompt, tools_allowlist, skills_allowlist) live in their own `personas` table. `bot_profiles` references a persona via `persona_id`. Creating or deleting a config does not affect the persona, and vice versa.

---
## 7. Startup Behavior

1. `chrono` resolves `CHRONO_HOME` (default `.chrono`), canonicalizes to absolute path
2. Creates `$CHRONO_HOME/state/` if missing
3. Opens `chrono.db` (creates empty DB with schema if first run)
4. Spawns `bun run agent-host/src/main.ts` with `CHRONO_HOME` env set to absolute path
5. Gateway starts HTTP server on `127.0.0.1:8787`
6. Agent-host reads config DB; if empty, logs info and waits for `config.reload`

**No crash on empty config.** The system starts and stays alive. Operators configure via WebUI; gateway sends `config.reload` frame to agent-host when config changes.

---
## 8. Tools

The canonical tool registry is defined in `agent-host/src/tools.ts` and mirrored in `crates/chrono-api/src/api/tools.rs` (for the `/api/v1/tools` endpoint).

Currently implemented:
- `message_send` — send/forward text to a chat; preferred path for all intentional outbound messages

Tools are allowlisted per persona via `tools_allowlist_json` in the `personas` table. An empty allowlist means "all known tools".
---

## 9. Real-time Protocol

Gateway ↔ agent-host: length-prefixed JSON frames over stdin/stdout.

Gateway → agent-host:
- `inbound.message` — normalized platform event
- `tool.response` — result of a tool execution
- `config.reload` — config DB changed, re-resolve providers + default bot

Agent-host → gateway:
- `tool.request` — tool invocation to dispatch via adapter
- `host_error` / `host_info` / `host_warn` — operational messages

Gateway ↔ WebUI: WebSocket at `/api/v1/ws`. Clients subscribe to exact topics or prefix wildcards (for example, `platform:telegram` and `sessions:*`). Telegram inbound and tool-driven outbound messages publish `platform.inbound` / `platform.outbound` events to both their platform and session topics. A lagging client receives `resync` and must refresh via REST.

## 10. Configuration Store


SQLite at `$CHRONO_HOME/state/chrono.db`. Schema managed by migrations in `crates/chrono-config/src/migrations/`.

| Table | Purpose |
| `llm_providers` | LLM backend definitions |
| `llm_credentials` | API keys per provider (plaintext) |
| `llm_models` | Allowlisted models with per-model overrides |
| `personas` | System prompts + tool/skill allowlists |
| `bot_profiles` | Bot configs (model_ref, persona_id, policy) |
| `platform_accounts` | Messaging platform identities |
| `bindings` | Account → bot profile routing rules |
| `settings` | Key-value operational settings |

`secret_ref` values are plaintext API keys or bot tokens. API responses return them directly.
---

## 11. Logging

All processes write to stderr. Stdout is reserved for framed IPC (agent-host ↔ gateway).

### Format

```
[component] message
```

No timestamps, no JSON, no log levels in the text. The prefix identifies the component; ANSI color communicates severity.

### Components

| Prefix | Process | Language |
|--------|---------|----------|
| `[chrono]` | chrono-sys entry point | Rust |
| `[gateway]` | chrono-gateway | Rust |
| `[agent]` | agent-host | TypeScript |
| `[adapter:N]` | platform adapters | Rust |

### Levels & Colors

| Level | ANSI | When |
|-------|------|------|
| `info` | `\x1b[36m` (cyan) | Normal operations: startup, reload, session lifecycle |
| `warn` | `\x1b[33m` (yellow) | Recoverable issues: config sync failure, rate limit hit, orphan tool response |
| `error` | `\x1b[31;1m` (red bold) | Non-recoverable: agent crash, IPC failure, DB corruption |

Expected empty-config startup (all `info`, no warnings):

```
[chrono] starting (CHRONO_HOME=/.../ChronoSys/.chrono)
[chrono] configure via WebUI → http://127.0.0.1:8787
[gateway] control plane listening on http://127.0.0.1:8787
[gateway] config reloaded (0 live adapter(s))
[gateway] control plane ready (adapters managed from config DB / WebUI)
[agent] No enabled LLM providers yet — configure via WebUI
```

### Rules

1. **Messages are one line.** No multi-line logs, no stack traces on stderr.
2. **No secret material.** Never log API keys, tokens, or `secret_ref` values.
3. **No IDs in info.** Session IDs and message IDs go in `warn`/`error` only — not in normal flow.
4. **Prefer info.** If the system can recover automatically, it's `info`, not `warn`.
5. **Empty config is normal.** "No providers yet" and "No bot profiles yet" are `info` — expected state before WebUI setup.

### Implementation

**Rust** — use `gateway_log!` macro (defined in `chrono-gateway/src/lib.rs`):

```rust
gateway_log!(info, "control plane listening on http://{addr}");
gateway_log!(warn, "initial config sync: {e:#}");
gateway_log!(error, "agent stdout read error: {e}");
```

**TypeScript** — use `logEvent()` (defined in `agent-host/src/main.ts`):

```ts
logEvent({ type: "host_info", message: "No enabled LLM providers yet" });
logEvent({ type: "host_warn", message: `orphan tool.response for ${id}` });
logEvent({ type: "host_error", message: err.message });
```

The function strips the `host_` prefix and maps the remainder to ANSI color.
