# Implementation Path & Zero-Pollution Deploy

## 0. Principles while building

1. Vertical slice first: one platform, one agent tool path, one UI screen.
2. pi is a library, not a process tree dependency (RPC only as debug escape hatch).
3. Fail closed on capabilities; empty allowlist = agent can only talk (if `message.send` granted).
4. Every side effect audited.
5. `$CHRONO_HOME` is the only writable root (default XDG).

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

### M1 — Agent loop vertical slice (week 1–2)

**Deliverable:** gateway spawns agent-host; inbound message → pi agent → tool `message.send` → log.

- [ ] agent-host: create `Agent` with system prompt + `message.send` tool
- [ ] tool IPC over UDS to gateway mock
- [ ] gateway: mock adapter that prints outbound messages
- [ ] session persistence under `$CHRONO_HOME/sessions`
- [ ] stream events to stdout JSONL

**Exit:** end-to-end demo script without real Telegram.

### M1.5 — Configuration store + pi-ai provider wiring (week 2–3)

**Deliverable:** multi-entity config DB; real LLM path uses only configured provider/model; no silent defaults.

- [ ] SQLite at `$CHRONO_HOME/state/chrono.db` + schema migrations
- [ ] Tables: `llm_providers`, `llm_credentials`, `llm_models`, `platform_accounts`, `bot_profiles`, `bindings`, `settings`
- [ ] Secrets by reference under `$CHRONO_HOME/secrets/` (or keychain)
- [ ] agent-host: build `createModels` + `CredentialStore` from DB; resolve `BotProfile.model_ref` only
- [ ] Remove M1 env fallbacks (`CHRONO_MODEL` / first-available model) from the non-fake path
- [ ] CLI: `chrono init`, `chrono llm …`, `chrono account …`, `chrono bot …`, `chrono bind …`, `chrono config doctor`
- [ ] `chrono config doctor` prints missing links (credential/model/binding) and exits non-zero if not live-ready
- [ ] Fail closed: empty DB ⇒ control plane may start; agent sessions and adapters refuse until configured

**Exit:** with only env vars and no DB rows, system starts cleanly and waits for WebUI configuration. After setup, `createModels` + `streamSimple` work for a configured model.

### M2 — Telegram adapter + sandbox (week 3–5)

**Deliverable:** real bot replies in a private chat **using config DB accounts/bindings**.

- [x] `chrono.adapter.telegram` (Bot API, long poll)
- [x] Load enabled `platform_accounts` + `bindings` from DB (no hardcoded token)
- [ ] media download to sandbox workspace *(deferred)*
- [ ] `sandbox.exec` / `sandbox.read` / `sandbox.write` *(deferred)*
- [x] rate limit + mention-only policy (from bot `policy_json`)
- [x] basic audit log
- [x] **Session-strong isolation** in agent-host (per route + UUID session_id)
- [x] Telegram `/new` command: new UUID session; archive previous transcript
- [x] `policy_json.context_scope` reserved (`session` default; `bot`/`account` TODO)
- [x] UUID session persistence (`$CHRONO_HOME/state/sessions.db`)
- [x] `message_send` supports optional `chat_id` (cross-chat); body-text fallback current-only
- [x] `policy_json.max_context_messages` hard refuse + error log (compaction/memory later)
- [x] Bot profile hot-read from config DB each turn

**Exit:** support bot answers in DM; cannot touch host FS; token only via account secret_ref.
Sandbox/media intentionally deferred to a later hardening pass.

### M3 — Control plane + WebUI MVP (week 5–7)

**Deliverable:** operators manage bots/sessions/providers/accounts in browser against the config DB.

- [ ] REST + WS API on gateway (CRUD for config entities; no raw secret read-back)
- [ ] WebUI: overview, sessions detail (transcript + tool trace), bot editor
- [ ] WebUI: `/providers`, `/accounts`, `/bots`, `/bindings` backed by state DB
- [ ] bearer token auth (localhost); refuse if auth token unset in non-dev
- [ ] live steer/abort from UI
- [ ] config hot-reload notification to agent-host

**Exit:** no need for log diving for normal ops; multi-entity state editable without hand-editing TOML.

### M4 — Plugin system (week 7–9)

**Deliverable:** install external tool plugin + skill.

- [ ] manifest load + capability grants
- [ ] TS tool plugins
- [ ] Python worker runtime (optional flag)
- [ ] WASM tool PoC
- [ ] `chrono plugin` CLI

**Exit:** example weather plugin works offline with mock HTTP.

### M5 — Multi-platform & hardening (week 9–12)

- [ ] compaction + memory scopes
- [ ] replace hard `max_context_messages` refuse with: rolling summary → long-term memory
      (RAG and/or graph) → inject retrieved snippets under ACL
- [ ] **Shared-context mode** (`policy_json.context_scope = bot|account`): platform-wide or
      bot-wide transcript **only** after compaction + long-term memory (RAG/graph) + ACL
      retrieval land; until then runtime stays session-isolated
- [ ] human approval queue for dangerous tools
- [ ] container image + systemd unit
- [ ] backup/restore of `$CHRONO_HOME` (includes state DB + secrets)

**Exit:** production-ready single-node checklist complete.

### M6 — Scale (post-v1)

- multi-node gateway, session affinity
- OIDC RBAC
- marketplace signatures
- OpenTelemetry
- multi-agent / subagent orchestration (reuse pi subagent patterns)

---

## 2. Suggested implementation order (files)

```text
1. crates/chrono-ipc          # types + framing
2. agent-host/src/pi-bridge   # Agent + tools
3. crates/chrono-gateway      # event loop + mock adapter
4. crates/chrono-sys          # entry crate → chrono binary
5. crates/chrono-adapters/telegram
6. crates/chrono-sandbox
7. webui (sessions first)
8. crates/chrono-plugin
9. plugins/examples/*
```

Do not start WebUI polish before M1 demo works.

---

## 3. Language assignment (concrete)

| Crate / package | Lang | Notes |
|-----------------|------|-------|
| gateway, adapters, sandbox, plugin host, chrono-sys | Rust | edition 2021, tokio |
| agent-host | TypeScript (Bun) | pi peer; Node 22.19+ fallback |
| webui | TypeScript (Vite) | static |
| example data plugins | Python 3.12+ | uv-managed venv under CHRONO_HOME |
| pi | TypeScript | external, npm-published (`@earendil-works/pi-*`) |

Python is **never** required for core install.

---

## 4. Zero-pollution strategy

### 4.1 Filesystem contract

| Path | Purpose |
|------|---------|
| `$CHRONO_HOME` | Single root (default: `$XDG_DATA_HOME/chronosys` or `~/.local/share/chronosys`) |
| `$CHRONO_HOME/config.toml` | Bootstrap only (bind, workers, sandbox backend) |
| `$CHRONO_HOME/state/chrono.db` | Config DB: providers, models, accounts, bots, bindings |
| `$CHRONO_HOME/secrets/` | Encrypted credential blobs / keychain refs |
| `$CHRONO_HOME/sessions/` | pi-compatible session stores |
| `$CHRONO_HOME/plugins/` | installed plugins + grants |
| `$CHRONO_HOME/venvs/` | per-plugin Python envs |
| `$CHRONO_HOME/sandboxes/` | session workspaces |
| `$CHRONO_HOME/logs/` | audit + process logs |
| `$CHRONO_CACHE` | optional model/http cache (default XDG cache) |

Env overrides:

```bash
export CHRONO_HOME=/var/lib/chronosys
export CHRONO_CONFIG=/etc/chronosys/config.toml
export CHRONO_NO_USER_PI=1          # never read/write ~/.pi
export CHRONO_SANDBOX=bwrap         # none|bwrap|docker
```

### 4.2 What we never do by default

- Global `npm install -g` / `pip install` on host
- Write to `~/.pi`, `~/.npm`, project dirs outside sandbox
- Mutate system systemd without explicit `chrono install-service`
- Require root (sandbox features degrade with warning if unprivileged)

### 4.3 Dependency isolation

| Runtime | Isolation |
|---------|-----------|
| Rust binary | static/almost-static; vendored where practical |
| agent-host | `node_modules` inside app dir or Nix/OCI layer |
| Python plugins | `uv venv` only under `$CHRONO_HOME/venvs` |
| Sandbox | ephemeral; wiped on GC |

### 4.4 Container (recommended prod)

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

### 4.5 Dev mode

```bash
chrono dev
# uses ./ .chrono/ as CHRONO_HOME for the repo (gitignored)
# hot reload webui + agent-host
# never touches real ~/.local/share/chronosys unless CHRONO_HOME set
```

`.chrono/` and `target/` and `node_modules/` are gitignored.

### 4.6 Supply chain

- Pin pi workspace via path in dev; lock versions in release
- `npm ci --ignore-scripts` for agent-host (align with pi hardening)
- Rust: `cargo deny` / audited deps in CI
- Plugin install: checksum + optional cosign

---

## 5. Config: bootstrap TOML vs state DB

**Principle: no business defaults.** A fresh `$CHRONO_HOME` is not a working bot. Operators must create providers, credentials, models, accounts, bot profiles, and bindings (CLI or WebUI) before live traffic.

### 5.1 Bootstrap only (`$CHRONO_HOME/config.toml` or `CHRONO_CONFIG`)

Process-level knobs. Safe to ship a minimal sample. Does **not** define bots or models.

```toml
# Bootstrap only — not product state.
[gateway]
bind = "127.0.0.1:8787"
auth_token_env = "CHRONO_TOKEN"   # if unset, control plane requires explicit setup

[paths]
# optional overrides; default under CHRONO_HOME
# state_db = "state/chrono.db"
# secrets_dir = "secrets"

[agent]
runtime = "bun"   # bun | node
workers = 2

[sandbox]
backend = "bwrap" # none | bwrap | docker
default_network = false

[pi]
import_user_skills = false
# packages from node_modules only; never packages_root path dep
```

There is **no** `default_model` in bootstrap. Model selection is always `bot_profiles.model_ref` → `llm_models` → pi-ai `getModel(provider, id)`.

### 5.2 State database (`$CHRONO_HOME/state/chrono.db`)

See ARCHITECTURE §5.1. Owns:

- multi LLM providers + credentials (refs) + allowlisted models
- multi platform accounts + adapter config
- multi bot profiles + bindings
- feature flags in `settings` (still explicit rows, not code defaults for safety-critical paths)

### 5.3 Operator flows (target UX)

```bash
# 1) init home (creates empty DB + dirs; still not runnable for live chat)
chrono init

# 2) LLM provider + credential
chrono llm provider add my-llm --kind builtin
chrono llm credential set my-llm --api-key-env MY_LLM_API_KEY

# 3) Refresh model catalogue from pi-ai → operator selects models in WebUI/CLI
chrono llm provider refresh my-llm
chrono llm model select my-llm main-model --temperature 0.7
chrono llm model select my-llm fast-model

# 4) Platform account
chrono account add tg1 --platform telegram --token-env TELEGRAM_BOT_TOKEN

# 5) Bot profile (model_ref = provider_id/model_id)
chrono bot add greeter --model my-llm/main-model --system-prompt-file ./prompts/greeter.md
chrono bot tools greeter --allow message.send,chat.history
chrono bind add --account tg1 --pattern 'dm:*' --bot greeter --mode dm


Missing any required link → start fails with a structured checklist (provider / credential / model / account / binding), not a silent fallback.

### 5.4 Demo / CI exception

The system starts with an empty config DB and waits for WebUI setup. It does not create production defaults. A demo seed script (`agent-host/src/seed.ts`) can populate the DB for testing, but it is never run automatically.

---

## 6. Testing strategy

| Layer | How |
|-------|-----|
| IPC contract | golden JSON fixtures |
| agent-host | pi faux provider; mock gateway |
| adapters | recorded HTTP fixtures |
| sandbox | integration tests on Linux CI only |
| e2e | `scripts/e2e-fake-chat.sh` |

No live LLM required for CI (`CHRONO_FAKE_LLM=1`).

---

## 7. Definition of done for v1.0

1. Telegram DM + group (mention-gated) with tool-only side effects.
2. Sandbox cannot read host `$HOME`.
3. WebUI: sessions + bots + plugins grants.
4. Plugin install for TS tools + skills.
5. Single binary/cli + OCI image; data only in volume/`CHRONO_HOME`.
6. Docs: deploy, plugin authoring, threat model.
7. Audit log of all tool invocations.

---

## 8. Immediate next actions (when coding starts)

1. Init Cargo workspace + `chrono` CLI.
2. Scaffold `agent-host` with path dependency on pi agent+ai.
3. Implement UDS IPC + mock send tool loop.
4. Add `.gitignore` for `.chrono/`, `target/`, `node_modules/`, `webui/dist/`.
5. Keep docs updated when contracts change.

Design freeze for M0–M1: **embed pi Agent**, **Rust gateway**, **tools-only effects**, **CHRONO_HOME isolation**.