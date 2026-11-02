# ChronoSys

Agent-centric framework for connecting chat platforms to tool-calling AI agents. **All side effects go through agent tools** (send message, plugins). Powered by [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`).

> Status: **M4 (active development)**. Telegram bot works end-to-end with native image input; WebUI manages all config entities; native plugin tools/commands are installable; LLM context compaction is operational; Docker `sandbox_exec`, Playwright browser automation, image viewing, and chat file transfer work per session. The plugin `ctx.sandbox.browser` facade and long-term memory remain. See [Roadmap](docs/ROADMAP.md).

## Docs

| Doc | Content |
|-----|---------|
| [Architecture](docs/ARCHITECTURE.md) | System design, language split, pi reuse, data model, design philosophy |
| [Plugin architecture](docs/PLUGIN_ARCHITECTURE.md) | Manifests, capabilities, tools/hooks/skills/adapters |
| [WebUI](docs/WEBUI.md) | Operator console information architecture and page specs |
| [Roadmap](docs/ROADMAP.md) | Implementation milestones, current progress, deferred items |

## Architecture

```
Chat platforms ──► chrono-gateway (Rust)
                      │  adapters · policy · sandbox · audit
                      ▼
                 agent-host (TypeScript + pi)
                      │  tools only
                      ▼
                 message / plugins
```

| Layer | Language | Role |
|-------|----------|------|
| Gateway, adapters, HTTP API | Rust (tokio, axum) | IM I/O, routing, config store, audit |
| Agent loop, LLM providers, tools | TypeScript (Bun + pi) | Prompt processing, model orchestration |
| WebUI | TypeScript (React + Vite) | Operator console for full config management |

## Principles

1. **Agent-first** — inbound chat → agent prompt; outbound only via tools.
2. **Reuse pi** — do not reimplement the agent loop or provider matrix.
3. **Zero pollution** — single `$CHRONO_HOME` (XDG); no host `~/.pi` or global npm/pip.
4. **Capability-gated plugins** — fail closed.
5. **No legacy compatibility** — pre-v1 breaking-change phase. Old formats are removed, not deprecated. No dual-path code.
6. **Secrets are plaintext** — `secret_ref` stores the actual API key directly.

## Getting started

### Prerequisites

- Rust toolchain (edition 2021)
- Bun (or Node ≥ 22.19)
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- Docker daemon (optional; required for `sandbox_exec`)

### Build & run

```bash
# Build everything
cargo build
cd agent-host && bun install --ignore-scripts

# Start the gateway (serves WebUI on :8787)
cargo run -p chrono-sys

# Expose on all interfaces; the first browser visit creates the admin account
cargo run -p chrono-sys -- --host 0.0.0.0:8787

# Full CLI reference
cargo run -p chrono-sys -- --help
```

Complete the first-run onboarding before exposing the port to an untrusted
network: until an admin password exists, whoever reaches the UI can claim it.
Then open `http://127.0.0.1:8787` (or your public URL) and configure via WebUI.
Set **Settings → Server access → Public URL** for the startup banner and CORS
allow-list; it needs a gateway restart. The first WebUI visit shows onboarding:
create the admin username/password. Later visits show the login page; the
password can be changed under **Settings → Authentication**.

1. **Providers** — add an LLM provider (e.g. DeepSeek) with API key
2. **Persona** — create a persona with system prompt and tools
3. **Config** — create a bot profile selecting model + persona
4. **Platforms** — add your Telegram bot token and attach the config

If `api.telegram.org` is unreachable, set a proxy in **Platforms → Proxy URL**
(e.g. `http://127.0.0.1:7890` or `socks5://127.0.0.1:7891`) or export
`CHRONO_TELEGRAM_PROXY` / `HTTPS_PROXY`. A self-hosted Bot API server can be set
via **Platforms → Bot API URL** or `CHRONO_TELEGRAM_API_URL`.

### Testing

```bash
cargo test                          # 53 Rust tests
cd agent-host && bun test           # 36 TypeScript tests
cd webui && npx tsc --noEmit        # TypeScript typecheck
cargo test -p chrono-sandbox -p chrono-gateway -- --ignored  # Docker sandbox smoke
```

### Pi dependency policy

`@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` are pinned to exact
upstream versions in `agent-host/package.json` and `agent-host/bun.lock`.
Local version overrides are intentionally unsupported. Upgrade Pi only through
a dedicated dependency commit that updates both files and passes the test suite.

## License

MIT.
