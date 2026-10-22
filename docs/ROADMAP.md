# Implementation Path & Zero-Pollution Deploy

## 0. Principles while building

1. Vertical slice first: one platform, one agent tool path, one UI screen.
2. pi is a library, not a process tree dependency (RPC only as debug escape hatch).
3. Installed and enabled plugins expose all tools; Persona blacklists gate per-tool visibility.
4. Every side effect audited.
5. `$CHRONO_HOME` is the only writable root (default XDG).
6. **No legacy compatibility.** Pre-v1 breaking-change phase: old formats are removed, not deprecated. No dual-path code. Config migrations update existing data.

---

## 1. Milestones

### M0 — Skeleton (week 0–1)

**Deliverable:** monorepo builds; `chrono --help`; docs present.

- [x] Architecture / plugin / WebUI / roadmap docs
- [x] Cargo workspace + `chrono-sys` (entry crate → `chrono` binary)
- [x] `agent-host` package with npm deps `@earendil-works/pi-agent-core@0.81.1` + `@earendil-works/pi-ai@0.81.1`
- [x] Shared JSON schema for `ChronoEvent` / tool IPC (JSON Schema + hand-written Rust/TS types)
- [x] `docker-compose` skeleton (no pollution: named volumes only)

**Exit:** `cargo build -p chrono-sys` + `bun install && bun run typecheck` green.

### M1 — Agent loop vertical slice (week 1–2) ✅

**Deliverable:** gateway spawns agent-host; inbound message → pi agent → tool `message.send` → log.

- [x] agent-host: create `Agent` with system prompt + `message.send` tool
- [x] tool IPC via stdin/stdout framed protocol (chrono-ipc)
- [x] gateway: Telegram adapter with Bot API long-poll
- [x] session persistence under `$CHRONO_HOME/state/sessions.db` (UUID sessions)
- [x] agent resilience: try-catch on `resolveBot` at all call sites

**Exit:** end-to-end: Telegram DM → agent → reply via `message_send`.

### M1.5 — Configuration store + pi-ai provider wiring (week 2–3) ✅

**Deliverable:** multi-entity config DB; real LLM path uses only configured provider/model; no silent defaults.

- [x] SQLite at `$CHRONO_HOME/state/chrono.db` + schema migrations
- [x] Tables: `llm_providers`, `llm_credentials`, `llm_models`, `platform_accounts`, `bot_profiles`, `personas`, `bindings`, `settings`
- [x] agent-host: `buildModels()` + `ChronoCredentialStore` from DB; `resolveModelRef()`
- [x] Fail closed: empty DB → system starts cleanly, waits for WebUI configuration
- [x] `display_name` removed from all config entities — `id` is the sole identifier
- [x] CLI config commands (`chrono init`, `chrono llm …`, `chrono config doctor`) removed — WebUI is the only operator surface

**Exit:** system starts with empty DB, configures via WebUI; `createModels` + `streamSimple` work for configured model.

### M2 — Telegram adapter (week 3–5) ✅

**Deliverable:** real bot replies in a private chat **using config DB accounts/bindings**.

- [x] `chrono.adapter.telegram` (Bot API)
- [x] Long-poll with exponential backoff + jitter; timeout 12s; fatal error detection
- [x] Load enabled `platform_accounts` + `bindings` from DB
- [x] rate limit + mention-only policy (from bot `policy_json`)
- [x] basic audit log
- [x] Session-strong isolation (per route + UUID session_id)
- [x] Telegram `/new` command (registered via setMyCommands)
- [x] UUID session persistence (`$CHRONO_HOME/state/sessions.db`)
- [x] `message_send` + `message_reply` with optional `chat_id`
- [x] `policy_json.max_context_messages` hard refuse (superseded by M3.5 compaction/drop policy)
- [x] Bot profile hot-read from config DB each turn

**Exit:** bot answers in DM; token via account secret_ref; model via config DB.

### M3 — Control plane + WebUI MVP (week 5–7) ✅

**Deliverable:** operators manage bots/sessions/providers/accounts/personas in browser.

- [x] REST API: CRUD for providers, credentials, models, accounts, bots, personas, bindings, sessions, audit
- [x] Runtime model capabilities query via agent-host IPC (replaces compile-time `model_caps.json`)
- [x] WebUI: Providers, Configs, Personas, Platforms, Sessions (read-only), Audit, Settings
- [x] Config editor: structured policy form (compaction, commands blacklist, mention, sender identity, timezone)
- [x] Session detail: chat bubbles + thinking collapse + tool call display
- [x] Model settings: thinking level dropdown populated from runtime capabilities
- [x] Persona editor: tools allowlist checkbox grid, skills tag editor
- [x] Config hot-reload notification to agent-host
- [x] bearer token auth (loopback bypass)
- [x] WebSocket real-time push — Telegram inbound/outbound topics, subscriptions, reconnect/resync
- [x] Plugin-native registry: manifest [[tools]]/[[commands]]/[[config]], policy toggle/blacklist, install/delete
**Exit:** operators configure everything via WebUI; no log diving for normal ops.

### M3.5 — Provider/runtime hardening (post-M3) ✅

**Deliverable:** production-usable model connections without silent fallbacks.

- [x] Built-in pi provider catalog registration + custom OpenAI-compatible providers
      (`openai-completions` / `openai-responses`); unknown provider kinds rejected at reload
- [x] Custom providers inherit capabilities by model name; unknown model names register
      with conservative defaults (128K context, 8K max tokens) instead of being skipped
- [x] Per-model overrides: temperature, max_tokens, top_p, thinking_level, and
      `extra_body_json` merged into the provider request payload
- [x] Transient model-request retries (network / 5xx / 429 / timeout; 2 retries → 3 attempts)
- [x] Model stream failures are non-fatal: reason logged, agent-host and session survive
- [x] Context compaction: `/compact`, policy max-turns trigger, pre-prompt 85% guard,
      post-turn 80% trigger; dedicated compaction model/prompt; persona preserved
- [x] Policy: sender identity (none/prefix/block), IANA timezone + `get_time` tool,
      command blacklist replacing the old command whitelist
- [x] `config.reload` logs the concrete bot/model resolution failure
- [x] Pi 1.4.0 migration: new token-estimation and `completeSimple` summary APIs,
      transcript system-message replay, and provider fallback for removed catalog models

### M4 — Plugin system + Docker sandbox (week 7–9) 🚧

**Deliverable:** installable native plugins with AI tools and user commands; ephemeral Docker containers for arbitrary code execution.

**Progress:** plugin registry complete; Docker runtime, `sandbox_exec`, native image input/viewing, chat file bridge, and configurable destruction are complete. Browser tools and the plugin sandbox facade remain.

- [x] Manifest-driven registry: `[[tools]]`/`[[commands]]` metadata, `[[config]]` schema
- [x] JS entry cross-validation: manifest names must exactly match `registerTool`/`registerCommand`
- [x] Policy: `enabled` toggle, per-tool Persona blacklist in `chrono.policy.toml`
- [x] `[config]` values edited in WebUI with typed controls (Input / Toggle)
- [x] Disabled plugins show metadata without loading JS (lazy)
- [x] WebUI: Extensions list, plugin editor, install ZIP/GitHub, delete
- [x] Persona editor: plugin tool modal with per-tool blacklist toggles
- [x] `host_command_sync` → Telegram `setMyCommands` for registered user commands
- [x] Gateway-managed Docker runtime: lazy create, workspace mount, resource caps,
      read-only root, no network by default, idle/max-lifetime cleanup, timeout destroy
- [x] `sandbox_exec` built-in tool: async IPC dispatch, hard timeout, capped output, audit
- [x] `sandbox_view_image` for image-capable models; inbound images also use native
      `agent.prompt(text, images)` while remaining available under `/workspace/upload/`
- [x] Chat ↔ sandbox file bridge: Telegram attachments are downloaded/imported to
      `/workspace/upload/…` by a background job; attachment-only and file+text messages
      both trigger an AI turn. `sandbox_send_file` delivers generated files back.
- [x] Destruction controls: idle timeout, max lifetime, `/new` reset, manual session reset;
      destroy removes both the container and workspace directory
- [ ] `sandbox_browser`
- [ ] Plugin context: `ctx.sandbox.*` facade for sandbox access

File read/write is intentionally handled by `sandbox_exec`; no separate
`sandbox_read` / `sandbox_write` tools are planned. Image bytes use
`sandbox_view_image` because text tools cannot deliver native multimodal input.
### M5 — Multi-platform & hardening (week 9–12)

- [x] rolling compaction (manual + automatic, persona-preserving; see M3.5)
- [ ] long-term memory scopes: RAG and/or graph store with ACL-filtered retrieval
- [ ] inject retrieved memory snippets after the rolling summary under the same ACL
- [ ] **Shared-context mode** (`policy_json.context_scope = bot|account`): platform-wide or
      bot-wide transcript **only** after long-term memory (RAG/graph) + ACL
      retrieval land; until then runtime stays session-isolated (current code logs
      a warning and falls back to `session`)
- [ ] human approval queue for dangerous tools
- [ ] container image + systemd unit
- [ ] backup/restore of `$CHRONO_HOME` (includes state DB + secrets)

**Exit:** production-ready single-node checklist complete.

### M6 — Scale (post-v1)

- multi-node gateway, session affinity
- OIDC RBAC
- marketplace signatures
- OpenTelemetry

---

---

## 2. Language assignment (concrete)

| Crate / package | Lang | Notes |
|-----------------|------|-------|
| gateway, adapters, chrono-sys | Rust | edition 2021, tokio |
| agent-host | TypeScript (Bun) | pi peer; Node 22.19+ fallback |
| webui | TypeScript (Vite) | static |
| pi | TypeScript | external, npm-published (`@earendil-works/pi-*`) |

Python is **never** required for core install.

---

## 3. Zero-pollution strategy

### 3.1 Filesystem contract

| Path | Purpose | Status |
|------|---------|--------|
| `$CHRONO_HOME` | Single writable root. Current default: `./.chrono`; XDG default (`$XDG_DATA_HOME/chronosys`) is a roadmap item. | implemented |
| `$CHRONO_HOME/config.toml` | Bootstrap knobs (bind, agent runtime, sandbox) | planned — no TOML is read today |
| `$CHRONO_HOME/state/chrono.db` | Config DB: providers (+ plaintext credentials), models, personas, accounts, bots, bindings, settings | implemented |
| `$CHRONO_HOME/state/sessions.db` | Durable conversation transcripts + route → active session mapping | implemented |
| `$CHRONO_HOME/plugins/installed/<id>/` | Installed native plugins | implemented |
| `$CHRONO_HOME/logs/audit.jsonl` | Audit log | implemented |
| `$CHRONO_HOME/secrets/` | Encrypted credential blobs / keychain refs | not used — secrets are plaintext in the state DB |
| `$CHRONO_HOME/inbox/` | Adapter download staging; files move into the session workspace | implemented |
| `$CHRONO_HOME/sandboxes/` | Per-session sandbox workspaces (bind-mounted at `/workspace`) | implemented |
| `$CHRONO_CACHE` | Optional model/HTTP cache | planned |

Implemented environment variables:

```bash
export CHRONO_HOME=/var/lib/chronosys     # default: ./.chrono
export CHRONO_API_HOST=127.0.0.1          # default 127.0.0.1
export CHRONO_API_PORT=8787               # default 8787
export CHRONO_AUTH_TOKEN=…                # required when API binds off-loopback
export CHRONO_WEBUI_DIST=/path/to/webui/dist
```

Planned (not read by the current binary): `CHRONO_CONFIG`, `CHRONO_NO_USER_PI`,
`CHRONO_SANDBOX`, `CHRONO_CACHE`.

### 3.2 What we never do by default

- Global `npm install -g` / `pip install` on host
- Write to `~/.pi`, `~/.npm`, project dirs outside sandbox
- Mutate system systemd without explicit `chrono install-service`
- Require root (sandbox features degrade with warning if unprivileged)

### 3.3 Dependency isolation

| Runtime | Isolation |
|---------|-----------|
| Rust binary | static/almost-static; vendored where practical |
| agent-host | `node_modules` inside app dir or Nix/OCI layer |
| Python plugins | `uv venv` only under `$CHRONO_HOME/venvs` |
| Sandbox | ephemeral; wiped on GC |

### 3.4 Container (recommended prod)

```yaml
# deploy/docker-compose.yml (sketch)
services:
  chronosys:
    image: ghcr.io/…/chronosys:latest
    volumes:
      - chrono-data:/var/lib/chronosys
    ports:
      - "127.0.0.1:8787:8787"   # WebUI/API localhost by default
    environment:
      CHRONO_HOME: /var/lib/chronosys
      CHRONO_NO_USER_PI: "1"
    # no host network unless webhook needs it
volumes:
  chrono-data:
```

Rootless Podman supported. Media/tmp use container volume only.

### 3.5 Dev mode (current)

```bash
# Gateway + agent-host, state in the repo (gitignored)
CHRONO_HOME=./.chrono cargo run -p chrono-sys
# `cargo run -p chrono-sys` defaults to ./.chrono, so the explicit env is optional.

# WebUI dev server (Vite :5173, proxies /api → :8787)
cd webui && bun run dev
```

There is no `chrono dev` command and no hot reload for Rust or agent-host;
restart the gateway after changing them. `.chrono/`, `target/`, `node_modules/`,
`webui/dist/`, and `agent-host/dist/` are gitignored.

### 3.6 Supply chain

- Pin pi workspace via path in dev; lock versions in release
- `npm ci --ignore-scripts` for agent-host (align with pi hardening)
- Rust: `cargo deny` / audited deps in CI
- Plugin install: checksum + optional cosign

---

## 4. Config: bootstrap vs state DB

**Principle: no business defaults.** A fresh `$CHRONO_HOME` is not a working bot. Operators must create providers, credentials, models, accounts, bot profiles, and bindings in the WebUI before live traffic.

### 4.1 Bootstrap (current: environment only; TOML planned)

The current binary reads process knobs from environment variables only (see §3.1).
No `config.toml` / `CHRONO_CONFIG` loading exists yet. The TOML sketch below is the
planned target shape; do not rely on it today.

```toml
# PLANNED — not read by the current binary.
[gateway]
bind = "127.0.0.1:8787"
auth_token_env = "CHRONO_AUTH_TOKEN"

[agent]
runtime = "bun"   # bun | node

[sandbox]
backend = "docker" # none | bwrap | docker
default_network = false

[pi]
import_user_skills = false
# packages from node_modules only; never packages_root path dep
```

There is **no** `default_model` in bootstrap. Model selection is always `bot_profiles.model_ref` → `llm_models` → pi-ai provider runtime.

### 4.2 State database (`$CHRONO_HOME/state/chrono.db`)

See ARCHITECTURE §6. Owns:

- multi LLM providers + plaintext credentials + allowlisted models
- multi platform accounts + adapter config
- multi bot profiles + persona references + bindings
- feature flags in `settings` (still explicit rows, not code defaults for safety-critical paths)

### 4.3 Operator flow (current)

```text
1. Providers  → add provider (kind + base_url) → set API key → fetch/select models
                → optional per-model temperature / max_tokens / top_p /
                  thinking_level / extra_body_json
2. Persona    → system prompt + built-in tool allowlist + skills
3. Config     → select model_ref + persona + context/command policy
4. Platforms  → add platform account (Telegram token) → attach one Config
5. Settings   → optionally enable Sandbox and set image/limits (required for sandbox_exec)
```

The WebUI is the only configuration surface. There is no `chrono init`,
`chrono llm …`, or `chrono bind …` CLI today. A missing provider/credential/model/
account/attachment does not crash the process: the gateway starts, the bot simply
does not route, and the Overview closure checklist shows the missing step.

### 4.4 Demo / CI exception

The system starts with an empty config DB and waits for WebUI setup. It does not create production defaults. `agent-host/src/seed.ts` can create the schema and example rows for testing, but it is never run automatically.

---

## 5. Testing strategy

| Layer | How |
|-------|-----|
| IPC contract | golden JSON fixtures + frame roundtrip (`chrono-ipc`) |
| config store | SQLite migration + CRUD integration (`chrono-config`) |
| gateway/API | WebSocket topic routing + async tool router (concurrency, timeout, fail-closed) |
| agent-host | IPC fixtures, session store, plugin registry, provider resolution, tool allowlist |
| sandbox | unit tests for config/workdir/session slug; Docker exec/timeout test is `#[ignore]` and runs with `cargo test -p chrono-sandbox -- --ignored` |
| adapters | no recorded HTTP fixtures yet; manual Telegram smoke |
| e2e | not implemented (no `scripts/` harness, no fake LLM mode) |

---

## 6. Definition of done for v1.0

1. Telegram DM + group (mention-gated) with tool-only side effects.
2. Sandbox: Docker containers per session with exec + browser.
3. WebUI: full config management + plugin extensions.
4. Plugin install via ZIP upload or GitHub clone.
5. Single binary + OCI image; data only in `CHRONO_HOME`.
6. Docs: deploy, plugin authoring, architecture.
