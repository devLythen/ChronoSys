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
│   └── plugins.rs           /api/v1/plugins
│
├── chrono-config/           SQLite config store (chrono.db schema + CRUD)
├── chrono-ipc/              length-prefixed JSON frame protocol
└── chrono-adapter-telegram/ Telegram platform adapter
```

---

## 2. LLM Credential Flow

Agent-host bridges the config DB to pi-ai via `ChronoCredentialStore` (`agent-host/src/credential-store.ts`). When pi-ai needs an API key:

1. pi-ai calls `CredentialStore.read(providerId)`
2. `ChronoCredentialStore` queries `llm_credentials` in the config DB
3. Returns `{ type: "api_key", key: secret_ref }` — the plaintext key

This is the only path for LLM auth. There is no separate env var or config file for API keys.

---

## 3. Provider Runtime

`buildModels()` (`agent-host/src/resolve.ts`) starts from pi-ai `createModels`, registers every builtin pi-ai provider, then registers config-DB providers that are absent from the builtin catalog as custom OpenAI-compatible providers.

**Custom providers**

- `llm_providers.kind` must be `openai-completions` or `openai-responses`. Unknown/legacy kinds are rejected at reload with a `[agent]` warning; there is no silent default.
- `base_url` is required. The API key comes from `llm_credentials` through `ChronoCredentialStore`.
- A DB model whose id matches a builtin catalog model inherits that model's capabilities by name (context window, reasoning/thinking levels, cost, input modalities).
- Connection fields always come from the custom provider row: inherited `baseUrl` and `api` are stripped, then re-applied from the provider config.
- A model id unknown to the catalog still registers with conservative defaults: 128K context, 8K max tokens (or the DB override), text-only input, no reasoning.

**Catalog changes**

- Pi model catalogs are tied to the pinned `@earendil-works/pi-*` versions.
- An allowlisted model that disappears from the catalog stays usable if its provider still exists: the runtime clones the provider's protocol/endpoint and applies 128K / 8K fallback capabilities. It logs `model ... is not in the pi catalog; using fallback capabilities`.
- New catalog models are not auto-added to `llm_models`; operators import them explicitly through the provider UI.
- Capability changes for an existing model id are picked up after a gateway restart.

**Request path**

- `bot_profiles.model_ref` must be `provider_id/model_id`; the model must be allowlisted in `llm_models` and have a provider runtime (catalog entry or fallback).
- Per-model overrides: `temperature`, `max_tokens`, `top_p`, `thinking_level` (clamped to model support), and `extra_body_json`.
- `extra_body_json` is parsed as an object and merged over the provider request payload via `onPayload`.
- `models.streamSimple` is wrapped with `maxRetries = 2` for transient failures (network, 5xx, 429, timeout): up to three attempts per request.
- A model stream failure is logged with its stop reason and does not terminate agent-host; the session transcript remains available for the next inbound message.

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

### 4.1 Telegram connectivity

`Bot::new` uses a direct HTTPS client. In networks where `api.telegram.org` is
blocked or reset, configure a transport explicitly:

- Per account: `platform_accounts.adapter_config_json.proxy_url`
  (`http://…`, `socks5://…`, or bare `host:port` → normalized to `http://`).
  Proxy is empty by default.
- Environment fallback: `CHRONO_TELEGRAM_PROXY`, `TELOXIDE_PROXY`,
  `HTTPS_PROXY`/`https_proxy`, `ALL_PROXY`/`all_proxy`.
- Self-hosted Bot API: `adapter_config_json.api_url` or
  `CHRONO_TELEGRAM_API_URL`; localhost API URLs bypass the proxy. New accounts
  default `api_url` to `https://api.telegram.org`.

`unexpected EOF`, connection timeouts, or TLS resets before `GetMe` mean the
network path failed — not an invalid bot token.

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
                kind: builtin pi id, openai-completions, or openai-responses
LlmCredential   API key (auth_kind, secret_ref — plaintext)
LlmModel        allowlisted model (provider_id + model_id; temperature,
                max_tokens, top_p, thinking_level, extra_body_json)
Persona         system prompt + tools allowlist + skills allowlist
BotProfile      "Config" in UI — model_ref, persona_id FK, policy
PlatformAccount platform identity + secret_ref + adapter_config
Binding         "Attach config" in UI — account × chat_pattern → bot_profile
Session         durable conversation transcript (sessions.db)
```

**Persona is a separate table.** Persona fields (system_prompt, tools_allowlist, skills_allowlist) live in their own `personas` table. `bot_profiles` references a persona via `persona_id`. Creating or deleting a config does not affect the persona, and vice versa.

---
## 7. Startup Behavior

1. `chrono` resolves `--home` or `CHRONO_HOME` (current default `./.chrono`; XDG default is planned), canonicalizes to an absolute path
2. Creates `$CHRONO_HOME/state/` if missing
3. Opens `chrono.db` (creates empty DB with schema if first run)
4. Spawns `bun run agent-host/src/main.ts` with `CHRONO_HOME` set to the absolute path
5. Gateway starts HTTP on `--host <IP:PORT>` or `CHRONO_API_HOST:CHRONO_API_PORT` (default `127.0.0.1:8787`). The first WebUI visit creates an admin password (Argon2 hash in `admin_credentials`); subsequent API/WebSocket access uses an HttpOnly session cookie. `server.public_url` controls the startup banner and CORS allow-list (restart required).
6. Agent-host reads the config DB; if empty, logs info and waits for `config.reload`

**No crash on empty config.** The system starts and stays alive. Operators configure via WebUI; gateway sends `config.reload` to agent-host when config changes. A provider or bot resolution failure is logged with its concrete reason; the process keeps running.

---
## 8. Tools

The canonical tool registry is defined in `agent-host/src/tools.ts` and mirrored in `crates/chrono-api/src/api/tools.rs` (for the `/api/v1/tools` endpoint).

Currently implemented built-in tools:
- `message_send` — send/forward text to a chat; preferred path for all intentional outbound messages
- `get_time` — return the current date/time in the bot's configured timezone (see policy `timezone`)
- `sandbox_exec` — run a shell command in the session's Docker workspace (see §13)
- `sandbox_send_file` — send a `/workspace/...` file back to the current chat (see §13)
- `sandbox_view_image` — read an image from `/workspace` as native multimodal content (see §13)
- `sandbox_browser` — run a Playwright action batch when `sandbox.browser=playwright` (see §13)

Built-in tools are allowlisted per persona via `tools_allowlist_json` in the `personas` table. An empty allowlist means "all known built-in tools". Plugin tools are NOT part of this allowlist — they are gated by the plugin enable toggle and per-tool persona blacklist (see PLUGIN_ARCHITECTURE §7).
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
| `admin_credentials` | Single admin username + Argon2 password hash; never exposed via the settings API |

`secret_ref` values are plaintext API keys or bot tokens. API responses return them directly.

Server-level settings:

| Key | Default | Meaning |
|-----|---------|---------|
| `server.public_url` | empty | Public WebUI base URL used by the startup banner and CORS allow-list; empty keeps permissive CORS. Applies after gateway restart. |
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

---

## 12. Context Management

Transcripts are stored per route (`session_key#bot_id`) in
`$CHRONO_HOME/state/sessions.db`. A bucket holds the active session UUID,
the full `AgentMessage[]`, and the last date separator. `/new` rotates the
session; `/compact` summarizes in place.

Policy fields (`bot_profiles.policy_json`):

| Field | Meaning |
|-------|---------|
| `max_turns` | Trigger threshold in user turns; `-1` disables |
| `compact_strategy` | `drop` (default) or `compact` |
| `drop_turns` | User turns discarded per drop event (default 1) |
| `compact_model_ref` | Optional dedicated `provider/model`; empty = chat model |
| `compact_prompt` | Instructions for the summarizer; bot system prompt always appended |
| `context_window_fallback` | Used when the model has no context window (default 128000) |

Compaction (`compactSessionMessages`) summarizes the oldest messages and keeps
the recent tail: 40% of messages for short transcripts, otherwise enough recent
messages to fit 50% of the model context window. The summary is stored as an
assistant message carrying `[Previous conversation summary]`, followed by the
kept tail. A failed summarize call keeps the original transcript and logs a
warning.

Triggers, all in `agent-host/src/main.ts`:

1. `/compact` (unless disabled by `disabled_commands`)
2. before a prompt when `max_turns` is exceeded (compact or drop)
3. before a prompt when the estimate exceeds 85% of the context window
4. after a turn when the estimate exceeds 80% (compact strategy only)

`context_scope` (`session` / `bot` / `account`) is reserved: the runtime logs a
warning for non-session values and falls back to session isolation until
long-term memory lands (M5).

---

## 13. Sandbox Runtime

The Rust gateway owns Docker containers. agent-host only declares
`sandbox_exec` / `sandbox_send_file` / `sandbox_view_image` /
`sandbox_browser` and sends `tool.request` messages; it never talks to Docker
or touches the host filesystem.

```
agent-host sandbox_exec
  → tool.request (session_id, cmd, cwd?, timeout_ms?)
  → gateway ToolRouter (async task, hard timeout)
  → SandboxToolBackend
  → SandboxManager (chrono-sandbox crate)
  → docker create/start/exec/rm
  → tool.response { exit_code, stdout, stderr, truncated }

agent-host sandbox_send_file
  → gateway resolves /workspace/... inside the session workspace
  → adapter file_send (Telegram sendDocument)

agent-host sandbox_view_image
  → gateway reads /workspace/... and returns base64 + mime
  → agent-host emits Pi ImageContent to the multimodal model

agent-host sandbox_browser
  → gateway writes a fixed Playwright helper + JSON action job into /workspace
  → docker exec node helper job (Playwright, network required)
  → helper returns results/screenshot paths
  → gateway optionally returns the first screenshot as base64 ImageContent
```

Browser capability is off by default. `sandbox.browser=playwright` exposes the
tool only when the sandbox is enabled; the image must provide Node, a resolvable
Playwright package, and Chromium browser binaries. Configure the in-container
Node binary (`sandbox.browser_node`), Playwright module path
(`sandbox.browser_playwright_path`), and browser binaries path
(`sandbox.browser_browsers_path`) in WebUI Settings. Defaults match the
recommended image; adjust them for a different image layout. Playwright typically needs more than the
default 512 MB memory limit; operators should raise `sandbox.memory_mb` for real
pages. Private-host
blocking covers literal IPs and common local names; DNS rebinding is not fully
preventable inside the container, so network-enabled sandboxes remain a trusted
operator choice.

Inbound images are both saved under `/workspace/upload/…` and, for
image-capable models, passed to `agent.prompt(text, images)` as native image
content. Persisted transcripts strip inline image bytes; later turns can use
`sandbox_view_image` to re-read them.

### Configuration

Stored as explicit `settings` rows and reloaded on config change:

| Key | Default | Meaning |
|-----|---------|---------|
| `sandbox.enabled` | `false` | Fail closed until enabled |
| `sandbox.image` | empty | Image with a POSIX shell; required |
| `sandbox.network` | `false` | `false` → `--network none` |
| `sandbox.browser` | `none` | `none` \| `playwright`; Playwright also requires network and image support |
| `sandbox.browser_node` | `node` | Node executable inside the container |
| `sandbox.browser_playwright_path` | `/opt/chrono/node_modules/playwright` | Playwright module path inside the container |
| `sandbox.browser_browsers_path` | `/ms-playwright` | `PLAYWRIGHT_BROWSERS_PATH` for Chromium binaries |
| `sandbox.timeout_ms` | `30000` | Default per-exec wall clock, hard cap 295000 |
| `sandbox.memory_mb` | `512` | Container memory limit |
| `sandbox.cpus` | `1.0` | CPU limit |
| `sandbox.pids_limit` | `256` | PID limit |
| `sandbox.idle_secs` | `300` | Idle container GC; `0` disables |
| `sandbox.max_lifetime_secs` | `0` | Absolute container TTL; `0` disables |
| `sandbox.destroy_on_new` | `true` | `/new` destroys the session container and workspace |

### Lifecycle

- One container per bot-scoped session key (`session_key#bot_profile_id`); name is `chrono-sandbox-<fnv64(session_key)>`.
- Workspace: `$CHRONO_HOME/sandboxes/<fnv64>/`, bind-mounted at `/workspace`.
- Telegram attachments are downloaded and imported by a gateway background job
  into `$CHRONO_HOME/inbox/...` and `/workspace/upload/<message-id>/`; only the
  completed inbound event reaches agent-host. Attachment-only and file+text
  messages both trigger one AI turn; the prompt lists the uploaded paths and
  image-capable models also receive inline image bytes.
- Container root is read-only; `/tmp` is a tmpfs; workspace is read-write.
- `--cap-drop ALL`, `--security-opt no-new-privileges`, current uid/gid,
  memory/CPU/PID caps.
- Lazy create on first exec; reaper every 30s enforces idle and max lifetime;
  shutdown removes all containers; startup removes orphans tagged with this
  `CHRONO_HOME`.
- `/new` sends `sandbox.reset`; the gateway destroys the container and workspace
  when `sandbox.destroy_on_new` is enabled. In-flight uploads from the old
  session are cancelled by a generation check instead of leaking into the new one.
- The session detail page exposes a manual **Reset sandbox** action through
  `POST /api/v1/sessions/{id}/sandbox/reset`.
- A timeout kills the process and removes the container; the workspace is
  removed by reset/idle cleanup, so background commands cannot survive.
- `destroy` removes both container and workspace; shutdown/reaper use the same path.
- stdout/stderr are capped at 1 MiB each; excess is drained and discarded.
- `sandbox_send_file` resolves `/workspace/...` with canonicalization, rejects
  traversal/symlink escapes, and enforces the 50 MiB Telegram document limit.
- `sandbox_view_image` uses the same canonicalization and rejects non-image
  extensions and files over 6 MiB before base64 encoding.
- `sandbox_browser` writes a fixed helper and a JSON job under
  `/workspace/upload/browser/`, then runs `node` with a hard timeout. The
  helper blocks `file://`, private/local hosts, and non-http(s) navigation, and
  refuses to escape `/workspace` for screenshots. Chromium runs with
  `--no-sandbox` inside the already isolated container. Browser tools are hidden when
  `sandbox.browser=none`, the sandbox is disabled, or `sandbox.network=false`.
- `sandbox_browser` returns the first screenshot as `ImageContent` only when the
  resolved model supports image input; otherwise paths and text results are
  returned.
- Plugin `ctx.sandbox.browser` is not implemented; plugins can use
  `ctx.sandbox.exec` to run their own browser helper.

### Current limits

Core `sandbox_browser` is implemented for the Playwright preset only; Chromium-only
mode is not offered. Each call starts a fresh browser, so dependent interactions
must be placed in one action batch. The plugin `ctx.sandbox.browser` facade is
still pending.
File read/write intentionally goes through `sandbox_exec`. Changing the image
does not recreate an already-running container; it takes effect after
idle/max-lifetime expiry, shutdown, or an explicit reset.
