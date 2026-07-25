# ChronoSys Architecture

Agent-centric chat integration framework: platforms (Telegram / QQ / WeChat / …) are adapters; **all outbound actions go through AI tool calls**. Agent loop is powered by **pi** (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`).

## Design Philosophy

**No magic defaults.** Every runtime entity (provider, model, bot profile, platform account, binding) must be explicitly created by the operator. There is no built-in "default bot" or "first available model". An empty config database on first deploy is normal and expected — the system starts and waits for WebUI configuration, then hot-reloads.

**One process boundary.** Gateway (Rust) and agent-host (TypeScript/Bun) communicate over stdin/stdout framed IPC. The gateway spawns the agent-host as a child process. No network sockets between them — just pipes.

**Configuration lives in SQLite, not env vars.** `$CHRONO_HOME/state/chrono.db` is the source of truth for providers, models, bot profiles, accounts, bindings, and settings. Environment variables are for process bootstrap only: `CHRONO_HOME`, `CHRONO_AUTH_TOKEN`, `CHRONO_API_HOST`.

**WebUI is the primary management surface.** The operator configures everything through a browser, not config files or CLI flags. The gateway serves the WebUI SPA from `webui/dist/`.

---

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

```
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

## 3. Language Domains

| Domain | Language | Why |
|--------|----------|-----|
| Gateway (I/O, routing, HTTP, adapters) | **Rust** | High fan-in, zero-copy media, single static binary |
| Agent loop, LLM, tools | **TypeScript (Bun)** | Reuse pi stack; avoid rewriting providers/tool loop |
| WebUI | **TypeScript (React)** | Same event types as agent-host; fast SPA |

**Decision**: Do not reimplement the agent core in Rust. pi owns the agent loop; ChronoSys owns IM + routing + policy + ops.

---

## 4. Data Model

```
LlmProvider     provider slot (id, kind, base_url, enabled)
LlmCredential   secret material (auth_kind, secret_ref — never plaintext in API responses)
LlmModel        allowlisted model (provider_id + model_id, params)
BotProfile      "Config" in UI — system_prompt, model_ref, tools/skills, policy
PlatformAccount platform identity + secret_ref + adapter_config
Binding         "Attach config" in UI — account × chat_pattern → bot_profile
Session         durable conversation transcript (sessions.db)
```

**Persona is not a separate table.** Persona fields (system_prompt, tools_allowlist, skills_allowlist) live on `bot_profiles`. The Persona page in WebUI edits those fields independently, preserving config fields (display_name, model_ref, policy) via GET→merge→PUT.

---

## 5. Startup Behavior

1. `chrono` resolves `CHRONO_HOME` (default `.chrono`), canonicalizes to absolute path
2. Creates `$CHRONO_HOME/state/` if missing
3. Opens `chrono.db` (creates empty DB with schema if first run)
4. Spawns `bun run agent-host/src/main.ts` with `CHRONO_HOME` env set to absolute path
5. Gateway starts HTTP server on `127.0.0.1:8787`
6. Agent-host reads config DB; if empty, logs info and waits for `config.reload`

**No crash on empty config.** The system starts and stays alive. Operators configure via WebUI; gateway sends `config.reload` frame to agent-host when config changes.

---

## 6. Tools

The canonical tool registry is defined in `agent-host/src/tools.ts` and mirrored in `crates/chrono-api/src/api/tools.rs` (for the `/api/v1/tools` endpoint).

Currently implemented:
- `message_send` — send/forward text to a chat; preferred path for all intentional outbound messages

Tools are allowlisted per bot profile via `tools_allowlist_json` in `bot_profiles`. An empty allowlist means "all known tools".

---

## 7. Real-time Protocol

Gateway ↔ agent-host: length-prefixed JSON frames over stdin/stdout.

Gateway → agent-host:
- `inbound.message` — normalized platform event
- `tool.response` — result of a tool execution
- `config.reload` — config DB changed, re-resolve providers + default bot

Agent-host → gateway:
- `tool.request` — tool invocation to dispatch via adapter
- `host_error` / `host_info` / `host_warn` — operational messages

Gateway ↔ WebUI: WebSocket at `/api/v1/ws` for streaming session events and audit log.

---

## 8. Configuration Store

SQLite at `$CHRONO_HOME/state/chrono.db`. Schema managed by migrations in `crates/chrono-config/src/migrations/`.

| Table | Purpose |
|-------|---------|
| `llm_providers` | LLM backend definitions |
| `llm_credentials` | API keys / secret refs per provider |
| `llm_models` | Allowlisted models with per-model overrides |
| `bot_profiles` | Bot configs (model, prompt, tools, policy) |
| `platform_accounts` | Messaging platform identities |
| `bindings` | Account → bot profile routing rules |
| `settings` | Key-value operational settings |

Secrets are never stored in the DB. `secret_ref` values are references: `env:VAR_NAME`, `file:/path`, or literal strings (dev only). API responses return `has_secret: bool`, never the value.
