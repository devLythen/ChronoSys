# ChronoSys

Agent-centric framework for connecting chat platforms to tool-calling AI agents. **All side effects go through agent tools** (send message, plugins). Powered by [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`).

> Status: **M3 (active development)**. Telegram bot works end-to-end; WebUI manages all config entities; context compaction operational. See [Roadmap](docs/ROADMAP.md).

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

### Build & run

```bash
# Build everything
cargo build
cd agent-host && bun install --ignore-scripts

# Start the gateway (serves WebUI on :8787)
cargo run -p chrono-sys
```

Then open `http://127.0.0.1:8787` and configure via WebUI:

1. **Providers** — add an LLM provider (e.g. DeepSeek) with API key
2. **Persona** — create a persona with system prompt and tools
3. **Config** — create a bot profile selecting model + persona
4. **Platforms** — add your Telegram bot token and attach the config

### Testing

```bash
cargo test                          # 20 Rust tests
cd agent-host && bun test           # 10 TypeScript tests
cd webui && npx tsc --noEmit        # TypeScript typecheck
```

## License

MIT.
