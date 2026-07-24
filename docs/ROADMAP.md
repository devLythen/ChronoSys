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
- [x] Cargo workspace + `chrono-cli` stub
- [x] `agent-host` package with npm deps `@earendil-works/pi-agent-core@0.81.1` + `@earendil-works/pi-ai@0.81.1`
- [x] Shared JSON schema for `ChronoEvent` / tool IPC (JSON Schema + hand-written Rust/TS types)
- [x] `docker-compose` skeleton (no pollution: named volumes only)

**Exit:** `cargo build` + `bun install && bun run typecheck` green.

### M1 — Agent loop vertical slice (week 1–2)

**Deliverable:** CLI injects a fake inbound message → pi agent → tool `message.send` → log.

- [ ] agent-host: create `Agent` with system prompt + `message.send` tool
- [ ] tool IPC over UDS to gateway mock
- [ ] gateway: mock adapter that prints outbound messages
- [ ] session persistence under `$CHRONO_HOME/sessions`
- [ ] stream events to stdout JSONL

**Exit:** end-to-end demo script without real Telegram.

### M2 — Telegram adapter + sandbox (week 2–4)

**Deliverable:** real bot replies in a private chat.

- [ ] `chrono.adapter.telegram` (Bot API, long poll or webhook)
- [ ] media download to sandbox workspace
- [ ] `sandbox.exec` / `sandbox.read` / `sandbox.write` with bubblewrap or platform fallback
- [ ] rate limit + mention-only policy
- [ ] basic audit log

**Exit:** support bot answers in DM; cannot touch host FS.

### M3 — Control plane + WebUI MVP (week 4–6)

**Deliverable:** operators manage bots/sessions in browser.

- [ ] REST + WS API on gateway
- [ ] WebUI: overview, sessions detail (transcript + tool trace), bot editor
- [ ] bearer token auth (localhost)
- [ ] live steer/abort from UI

**Exit:** no need for log diving for normal ops.

### M4 — Plugin system (week 6–8)

**Deliverable:** install external tool plugin + skill.

- [ ] manifest load + capability grants
- [ ] TS tool plugins
- [ ] Python worker runtime (optional flag)
- [ ] WASM tool PoC
- [ ] `chrono plugin` CLI

**Exit:** example weather plugin works offline with mock HTTP.

### M5 — Multi-platform & hardening (week 8–12)

- [ ] QQ / WeChat adapters (as protocols allow; stubs earlier)
- [ ] bindings (pattern → bot profile)
- [ ] compaction + memory scopes
- [ ] human approval queue for dangerous tools
- [ ] container image + systemd unit
- [ ] backup/restore of `$CHRONO_HOME`

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
4. crates/chrono-cli          # chrono dev / up
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
| gateway, adapters, sandbox, plugin host, cli | Rust | edition 2021, tokio |
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
| `$CHRONO_HOME/config.toml` | Config |
| `$CHRONO_HOME/accounts/` | Encrypted credentials |
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

## 5. Config sketch (`config.toml`)

```toml
home = "/var/lib/chronosys"  # optional override

[gateway]
bind = "127.0.0.1:8787"
auth_token_env = "CHRONO_TOKEN"

[agent]
runtime = "bun"              # bun | node
workers = 2
default_model = { provider = "anthropic", id = "claude-sonnet-4-6" }

[sandbox]
backend = "bwrap"
default_network = false
workspace_quota_mb = 512
idle_ttl_secs = 3600

[pi]
# packages come from node_modules (npm pins); no packages_root path dep
import_user_skills = false

[platforms.telegram]
enabled = true
# secrets via env or accounts store
```

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