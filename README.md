# ChronoSys

Agent-centric framework for connecting chat platforms (Telegram, QQ, WeChat, …) to tool-calling AI agents. **All side effects go through agent tools** (send message, sandbox, plugins). The agent loop reuses the [pi](https://github.com/earendil-works/pi) harness via npm (`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`).

> Status: **M0 scaffold**. Workspace builds; agent loop / gateway / adapters land in later milestones. See docs.

## Docs

| Doc | Content |
|-----|---------|
| [Architecture](docs/ARCHITECTURE.md) | System design, Rust/TS/Python split, pi reuse, data model |
| [Plugin architecture](docs/PLUGIN_ARCHITECTURE.md) | Manifests, capabilities, tools/hooks/skills/adapters |
| [WebUI](docs/WEBUI.md) | Operator console IA and realtime protocol |
| [Roadmap](docs/ROADMAP.md) | Implementation path, deploy, zero-pollution |

## Design snapshot

```text
Chat platforms ──► chrono-gateway (Rust)
                      │  adapters · policy · sandbox · audit
                      ▼
                 agent-host (TypeScript + pi)
                      │  tools only
                      ▼
                 message / sandbox / plugins
```

| Concern | Language |
|---------|----------|
| IM I/O, sandbox, plugins host, CLI | Rust |
| Agent loop, LLM providers, tools | TypeScript (pi) |
| Optional scientific tools | Python (isolated venvs) |
| Admin UI | TypeScript (Vite SPA) |

## Principles

1. **Agent-first** — inbound chat → agent prompt; outbound only via tools.
2. **Reuse pi** — do not reimplement the tool loop or provider matrix.
3. **Zero pollution** — single `$CHRONO_HOME` (XDG); no host `~/.pi` / global npm/pip by default.
4. **Capability-gated plugins** — fail closed.
5. **Easy deploy** — CLI + OCI; rootless-friendly.

## Prerequisites

- Rust toolchain (edition 2021)
- Bun (or Node ≥ 22.19)
- Linux recommended for full sandbox (`bubblewrap`); macOS dev with reduced isolation
- Network for `bun install` — pi packages come from npm (`@earendil-works/pi-agent-core@0.81.1`, `@earendil-works/pi-ai@0.81.1`). No local `../pi` clone is required.

## Build (M0)

```bash
# Rust workspace
cargo build
cargo test -p chrono-ipc
cargo run -p chrono-cli -- --help
cargo run -p chrono-cli -- version

# agent-host (TypeScript + published pi)
cd agent-host
bun install --ignore-scripts
bun run typecheck
bun test
```

## Quick links (future CLI)

```bash
chrono dev          # local stack, .chrono/ as home
chrono up           # production-ish single node
chrono plugin install ./examples/weather
```

## License

TBD.
