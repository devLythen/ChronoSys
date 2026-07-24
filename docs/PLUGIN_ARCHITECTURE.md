# Plugin Architecture

Plugins extend ChronoSys without forking core. Every extension surface is capability-gated and runs outside the agent’s default trust boundary unless explicitly granted.

## 1. Plugin kinds

| Kind | Role | Typical language |
|------|------|------------------|
| `adapter` | IM platform connector | Rust crate / subprocess |
| `tool` | Extra tools for the LLM | TS / WASM / Python / Rust |
| `skill` | Progressive-disclosure instructions (`SKILL.md`) | Markdown + assets |
| `hook` | Policy / lifecycle (block tool, inject context) | TS (agent-host) or WASM |
| `runtime` | Tool execution backend (e.g. Python venv runner) | Any |

A single package may ship multiple kinds (manifest lists them).

---

## 2. Package layout

```text
my-plugin/
├── chrono.plugin.toml          # required manifest
├── README.md
├── skills/                     # optional Agent Skills
│   └── weather/
│       └── SKILL.md
├── tools/                      # optional
│   ├── index.ts                # agent-host native tools
│   └── compute.wasm
├── hooks/
│   └── policy.ts
├── adapter/                    # optional platform adapter
│   └── ...
├── python/                     # optional Python tool pack
│   ├── pyproject.toml
│   └── src/...
└── assets/
```

### 2.1 Manifest (`chrono.plugin.toml`)

```toml
id = "com.example.weather"
name = "Weather"
version = "0.1.0"
chrono_api = "1"
description = "Weather tools and skill"

[entry]
# At least one
tools = ["tools/index.ts"]
hooks = ["hooks/policy.ts"]
skills = ["skills"]
# adapter = { kind = "subprocess", command = "./bin/adapter" }
# python  = { project = "python", expose = ["forecast"] }

[capabilities]
required = ["net.https:api.open-meteo.com", "memory.session"]
optional = ["media.download"]

[resources]
memory_mb = 128
cpu_millis = 500
disk_mb = 64
timeout_ms = 30_000

[ui]
icon = "assets/icon.svg"
```

Install flow:

1. Validate signature / checksum (optional allowlist in enterprise).
2. Parse manifest → show capabilities to user.
3. Grant subset → write grant record under `$CHRONO_HOME/plugins/grants/`.
4. Materialize into `$CHRONO_HOME/plugins/installed/<id>/<version>/`.
5. Hot-reload registry (gateway + agent-host).

---

## 3. Capability model

Capabilities are strings with optional scope:

```text
platform.send                 # send messages via bound accounts
platform.history              # read chat history
sandbox.exec                  # run commands in session sandbox
sandbox.fs                    # read/write sandbox workspace
memory.session | memory.user | memory.global
net.https:<host>              # HTTPS egress to host
net.proxy                     # use gateway outbound proxy
vault.read:<name>             # named secret
plugin.call:<id>              # call another plugin
ui.notify                     # push notification to WebUI
```

Rules:

- Agent tools inherit the **intersection** of BotProfile allowlist and plugin grants.
- Gateway denies undeclared caps before execution (fail closed).
- `net.*` only via gateway proxy so audit + SSRF controls apply.
- Skills **cannot** grant capabilities; they only instruct the model.

---

## 4. Tool registration paths

### 4.1 Native TypeScript tools (agent-host)

Same shape as pi `AgentTool` / coding-agent `registerTool`:

```ts
import { Type } from "typebox";
import type { ChronoToolAPI } from "@chronosys/agent-host/plugin";

export default function register(api: ChronoToolAPI) {
  api.registerTool({
    name: "weather.forecast",
    description: "Get weather forecast for a city",
    parameters: Type.Object({
      city: Type.String(),
      days: Type.Optional(Type.Integer({ minimum: 1, maximum: 7 })),
    }),
    capabilities: ["net.https:api.open-meteo.com"],
    async execute(_id, params, signal, onUpdate, ctx) {
      const data = await ctx.http.get("https://api.open-meteo.com/...", { signal });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    },
  });
}
```

`ctx` is a **facade**: `http`, `memory`, `sandbox`, `platform` (capability-checked). No raw Node `fs` of host.

Loading: jiti/tsx like pi extensions, or prebundled ESM for prod.

### 4.2 WASM tools

- WASI preview or wasmtime component model.
- Host imports: `chrono_http`, `chrono_memory`, `chrono_log` (capability filtered).
- Best for pure compute + portable plugins; no arbitrary OS access.

### 4.3 Python tools

```
agent-host  --plugin.call-->  gateway  --JSON-RPC-->  python-runtime worker
```

- One **venv per plugin version** under `$CHRONO_HOME/venvs/<plugin-id>/<version>/`.
- Worker started on demand; idle timeout; cgroup limits.
- Protocol (stdio JSONL):

```json
{"id":"1","method":"tool.execute","params":{"name":"forecast","args":{...}}}
{"id":"1","result":{"content":[{"type":"text","text":"..."}]}}
```

- Python never holds platform credentials; uses gateway RPC for side effects.

### 4.4 Subprocess adapter plugins

Long-lived child implementing adapter protocol (same as internal adapters). Health checks + restart policy owned by gateway.

---

## 5. Hooks

### 5.1 Agent-host hooks (pi-aligned)

Map to pi `beforeToolCall` / harness hooks / coding-agent extension events:

| Chrono hook | pi analogue | Can |
|-------------|-------------|-----|
| `on_inbound` | input | drop / rewrite user text |
| `before_prompt` | before_agent_start | inject messages, patch system prompt |
| `before_tool` | tool_call / beforeToolCall | `{ block, reason }` |
| `after_tool` | afterToolCall / tool_result | patch result |
| `on_agent_end` | agent_end | cleanup, metrics |

Hooks run in install order; `before_tool` short-circuits on first block.

### 5.2 Gateway hooks

Rust-side for security that must not be bypassable from agent-host:

- rate limit
- ACL on chat/user
- DLP on outbound text
- human approval queue

Plugins can register **policy modules** as WASM with pure function interface: `(ToolRequest, PolicyContext) -> Allow|Deny|Challenge`.

---

## 6. Skills

Reuse **Agent Skills** standard (as pi does):

- Discovered from plugin `skills/` + profile overrides.
- Catalog name/description always in system prompt; body loaded on demand (`read` of skill file **inside** plugin package, RO).
- Commands: `/skill:name` in chat or WebUI.

ChronoSys does **not** load host `~/.pi` skills unless `CHRONO_IMPORT_PI_SKILLS=1`.

---

## 7. Plugin API versions & stability

- `chrono_api = "1"` in manifest.
- Host exposes `@chronosys/plugin-sdk` (TS) and `chrono_plugin` (Rust) with semver.
- Breaking IPC → bump major; dual-run adapters for one release when possible.

---

## 8. Isolation matrix

| Execution | Process | FS | Network | Crash blast radius |
|-----------|---------|----|---------|--------------------|
| TS tool in agent-host | shared host | facade only | proxy | medium (prefer WASM for untrusted) |
| WASM tool | sandbox isolate | imports only | proxy | low |
| Python worker | own PID + cgroup | plugin dir + tmp | proxy | low |
| Adapter subprocess | own PID | declared paths | platform only | medium |
| Session sandbox.exec | bwrap/etc | workspace | deny default | low |

**Untrusted marketplace plugins** → WASM or Python worker only; never in-process TS until signed + reviewed.

---

## 9. Discovery & distribution

```text
chrono plugin install ./my-plugin
chrono plugin install git+https://...#v0.1.0
chrono plugin install oci://ghcr.io/org/plugin:0.1.0
chrono plugin list
chrono plugin grant com.example.weather net.https:api.open-meteo.com
chrono plugin disable com.example.weather
```

Registry format (optional v1.5): static JSON index; signature via cosign.

---

## 10. Built-in first-party plugins (planned)

| ID | Kind | Notes |
|----|------|-------|
| `chrono.adapter.telegram` | adapter | Bot API / MTProto choice later |
| `chrono.adapter.qq` | adapter | stub → protocol research |
| `chrono.adapter.wechat` | adapter | stub / official channels first |
| `chrono.tools.web` | tool | search/fetch via proxy |
| `chrono.tools.cron` | tool + gateway | scheduled agent wakes |
| `chrono.hooks.guard` | hook | dangerous-tool confirmation |

---

## 11. Developer experience

Minimal tool plugin scaffold:

```bash
chrono plugin new weather --template tool-ts
chrono dev --plugin ./weather
```

Test harness:

```bash
chrono test tool weather.forecast --args '{"city":"Shanghai"}'
```

Uses faux LLM (pi faux provider pattern) + mock gateway for CI without network.