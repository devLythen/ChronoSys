# WebUI Design

Admin + observability surface for ChronoSys. Not a full IM client clone—operators manage bots, sessions, plugins, and watch agent tool traces in real time.

## 1. Goals

- Real-time: streaming tokens + tool timelines
- Low ceremony: works with single-node `chrono up`
- Modern stack, zero host pollution: static assets served by gateway or separate SPA
- Accessible dark-first UI; keyboard-friendly ops

## 2. Stack

| Layer | Choice |
|-------|--------|
| Build | Vite |
| UI | React 19 + TypeScript |
| Style | Tailwind CSS v4 + CSS variables (design tokens) |
| State | TanStack Query (server) + Zustand (ephemeral UI) |
| Realtime | WebSocket (`/api/v1/ws`) |
| Charts | Lightweight (e.g. uPlot) only if needed for token/cost |
| Auth | Session cookie / OIDC later; local-dev open with token |

Avoid heavy component kits that look generic; custom shell with clear density for ops.

## 3. Information architecture

```text
/                     Overview (status, throughput, errors)
/accounts             Platform accounts + health
/bots                 Bot profiles (prompt, model, tools)
/bindings             Account × chat pattern → bot
/sessions             Live & historical agent sessions
/sessions/:id         Session detail (transcript + tool trace)
/plugins              Installed plugins + grants
/sandbox              Active sandboxes, quotas
/memory               Scoped memory browser
/audit                Tool & adapter audit log
/settings             Models, providers, home dir, theme
```

Mobile: collapse nav; sessions + overview first.

## 4. Core screens (wire-level)

### 4.1 Overview

- Gateway / agent-host / sandbox supervisor health
- Events/min, open sessions, tool error rate
- Recent audit failures
- Quick actions: pause all bots, open logs

### 4.2 Bot profile editor

```
┌──────────────────────────────────────────────────────────┐
│ Bot: SupportCN                          [Save] [Duplicate]│
├─────────────────┬────────────────────────────────────────┤
│ Model           │ anthropic / claude-sonnet-…  Thinking  │
│ System prompt   │ multiline + skill chips                │
│ Tools           │ checklist from registry + plugins      │
│ Skills          │ enable/disable catalog                 │
│ Policies        │ rate, mention-only, human-approve list │
│ Memory scope    │ off | user | chat | both               │
└─────────────────┴────────────────────────────────────────┘
```

Preview: “Injected system prompt” dry-run with sample chat metadata.

### 4.3 Session detail (most important)

Split view:

```
┌─────────────────────────────┬────────────────────────────┐
│ Transcript                  │ Tool timeline              │
│  user / assistant bubbles   │  · message.send  42ms  ok  │
│  streaming cursor           │  · sandbox.exec  …running  │
│  platform meta (tg ids)     │  args + result expand      │
├─────────────────────────────┴────────────────────────────┤
│ Composer (operator inject / steer / abort)               │
└──────────────────────────────────────────────────────────┘
```

Actions: abort run, steer, follow-up, compact, open sandbox FS browser, export JSONL.

### 4.4 Plugins

- Card list: name, version, caps, status
- Grant matrix (toggle capabilities)
- Install from path / git / OCI
- Logs per plugin worker

### 4.5 Audit

Filterable table: time, session, tool, platform op, allow/deny, latency. Click → deep link session.

## 5. Realtime protocol

WebSocket messages (server → client):

```ts
type WsServer =
  | { type: "agent.delta"; session_id: string; text: string }
  | { type: "agent.message"; session_id: string; message: AgentMessage }
  | { type: "tool.trace"; session_id: string; phase: "start"|"update"|"end"; ... }
  | { type: "session.status"; session_id: string; status: "idle"|"running"|"error" }
  | { type: "metrics.sample"; ... }
  | { type: "audit.append"; entry: AuditEntry };
```

Client → server:

```ts
type WsClient =
  | { type: "subscribe"; topics: string[] } // sessions:*, audit, metrics
  | { type: "session.prompt"; session_id: string; text: string }
  | { type: "session.steer"; session_id: string; text: string }
  | { type: "session.abort"; session_id: string };
```

REST for CRUD (`/api/v1/bots`, `/accounts`, …). OpenAPI generated from gateway.

## 6. Visual design direction

Not “purple gradient AI SaaS”. Direction:

- **Industrial console**: deep neutral background, sharp 1px borders, monospace for ids/tool args
- Accent: single hue (e.g. teal or amber) for live/running states
- Typography: Inter/Geist UI + JetBrains Mono for traces
- Density: compact default; comfortable toggle
- Motion: only streaming cursor + subtle tool status pulse

Accessibility: WCAG AA contrast; focus rings; reduce-motion respected.

## 7. Auth & multi-user (phased)

| Phase | Auth |
|-------|------|
| v0.1 | Local bind `127.0.0.1` + optional bearer token |
| v0.3 | Password / passkey single admin |
| v1.0 | OIDC + RBAC (viewer / operator / admin) |

## 8. Build & serve (zero pollution)

```text
webui/                 # source
  dist/                # build output committed? NO — built in CI/image
```

- Dev: Vite proxy → gateway `:8787`
- Prod: gateway embeds `dist/` via `rust-embed` **or** serves volume mount
- No global `npm install -g`; use `pnpm`/`bun` in repo or CI only
- Assets hashed; CSP headers from gateway

## 9. Implementation phases (UI)

1. Shell + auth token + overview health
2. Sessions list + live transcript/tool trace
3. Bots / bindings CRUD
4. Plugins + grants
5. Audit + memory + sandbox browser
6. Polish, RBAC, export

## 10. Out of scope for WebUI

- Replacing Telegram/QQ/WeChat native clients
- Rich end-user chat for customers (unless later “public bot portal”)
- Training / fine-tune UIs