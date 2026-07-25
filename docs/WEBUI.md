# WebUI Design

Admin + observability surface for ChronoSys. Operators manage platforms, configs, personas, providers, sessions, and audit logs through a browser.

## Design Philosophy

**Swiss Modernism.** Typography is the primary visual element — not gradients, shadows, or decorative UI chrome. Black-on-white, sharp edges, generous whitespace. Halftone dot patterns and monochrome gradient blocks provide texture without distraction.

**Editorial layout, not dashboard.** Pages are designed to be read top-to-bottom with clear typographic hierarchy. No cramped data tables unless the data demands it. Content determines form.

**Minimal motion.** Page enter and scroll reveal animations serve readability, not spectacle. `prefers-reduced-motion` is respected.

---

## 1. Stack

| Layer | Choice |
|-------|--------|
| Build | Vite 6 |
| UI | React 19 + TypeScript |
| Style | Tailwind CSS v4 + CSS design tokens |
| State | TanStack Query (server) + Zustand (auth token) |
| Routing | HashRouter (`/#/overview`, `/#/platforms`, …) |
| Realtime | WebSocket (`/api/v1/ws`) |
| Icons | Lucide (SVG) |
| Animation | GSAP (ScrollTrigger) |

---

## 2. Information Architecture

```
/#/overview      System health + configuration completeness checklist
/#/platforms     Messaging accounts + attach configs
/#/config        Bot profiles — assemble model + settings
/#/config/:id    Config editor
/#/providers     LLM providers, credentials, model catalog
/#/persona       System prompts + tool allowlists (independent creation)
/#/persona/:id   Persona editor
/#/sessions      Live & historical agent sessions
/#/sessions/:id  Session transcript + tool trace
/#/audit         Tool & adapter audit log
/#/settings      Auth token + instance info
```

**Nav order reflects the operator workflow**: first set up a platform account → then create a config that selects a model and persona → models come from providers, personas are created independently.

---

## 3. Visual Design

### Typography Scale

| Class | Size | Use |
|-------|------|-----|
| `.t-display` | clamp(1.75rem, 4vw, 2.75rem) | Page titles |
| `.t-headline` | clamp(1.1rem, 2vw, 1.35rem) | Section headers, card titles |
| `.t-title` | 1rem | Modal titles |
| `.t-body` | 0.875rem | Body text |
| `.t-label` | 0.6875rem uppercase | Form labels, metadata |
| `.t-mono` | 0.8125rem | IDs, model refs, code |

Fonts: **Inter** (body) + **JetBrains Mono** (code).

### Decorative Elements

| Class | Effect |
|-------|--------|
| `.halftone` | Black dot pattern, 12px grid |
| `.halftone-light` | Gray dot pattern, 10px grid |
| `.grad-block` | Black → gray diagonal gradient |
| `.rule-heavy` | 4px black horizontal divider |
| `.rule-thin` | 1px gray horizontal divider |

### Color Palette

| Token | Value | Use |
|-------|-------|-----|
| `--color-bg` | `#FAFAFA` | Page background |
| `--color-fg` | `#0A0A0A` | Text, accents |
| `--color-card` | `#FFFFFF` | Card surfaces |
| `--color-muted` | `#F0F0F0` | Subtle backgrounds |
| `--color-muted-fg` | `#6B6B6B` | Secondary text |
| `--color-border` | `#E0E0E0` | Borders, dividers |
| `--color-success` | `#16A34A` | Enabled, online, ok |
| `--color-destructive` | `#DC2626` | Errors, delete actions |

No border-radius anywhere. No box-shadows. Depth is conveyed through borders and color contrast alone.

---

## 4. Component Patterns

### Shell
- Sticky top navigation bar with horizontal text links
- Active nav item: black background, white text
- No sidebar. No icons in nav.
- Footer with version info
- Content: `max-w-6xl` centered, responsive padding

### Pages
- Hero header: `.t-display` title + `.t-body` subtitle + `.rule-heavy` divider
- Sections separated by `space-y-6` to `space-y-8`
- Halftone blocks as visual breaks between major sections
- Empty states: halftone-light background, centered text with CTA link
- Loading states: centered `.t-body` muted text
- Error states: destructive-colored message

### Cards
- White background, 1px border
- Minimal padding (`p-4`)
- Full-width horizontal layout: info on left, actions on right
- Clickable cards use `<button>` element for accessibility

### Modals & Toasts
- Rendered via `React.createPortal` to `document.body`
- Modal: `z-[100]`, locks body scroll
- Toast: `z-[200]`, auto-dismiss 4s, stacked bottom-right

### Forms
- Labels: `.t-label` above inputs
- Inputs: 1px border, focus ring matches text color
- Selects: same styling as inputs
- Save buttons: prominent, full-width or right-aligned

---

## 5. Key Interactions

### Config Editor
- `model_ref` is a Select dropdown populated from enabled providers + enabled models
- Persona fields (system_prompt, tools, skills) are preserved on save (GET→merge→PUT)
- Policy JSON editor with validation

### Persona Editor
- Independent of Config — persona can be created and edited without going through Config
- Tools checklist fetched from `/api/v1/tools` (no hardcoded placeholders)
- Skills managed as tag chips (add/remove)

### Platforms Page
- UI terminology: "Attach Config" / "Detach" — never "Binding"
- Secret input: "Leave blank to keep existing secret"
- Attachment IDs generated as `${accountId}-${configId}-${timestamp36}`

### Overview
- 5-step configuration completeness checklist
- Each step links to the relevant page for resolution
- Stats cards for uptime, agent status, adapter count, session count

---

## 6. API Integration

All REST calls go through `src/api/client.ts`. Query keys follow a flat convention:

```ts
["health"]   ["providers"]   ["bots"]   ["bots", id]
["accounts"] ["bindings"]    ["tools"]  ["sessions"]
["audit"]    ["settings"]
```

Mutations invalidate relevant query keys on success. WebSocket connection is managed by `useWebSocket` hook.

---

## 7. Build & Serve

```
webui/
├── src/          TypeScript source
├── dist/         build output (git-ignored)
├── package.json  bun install
└── vite.config.ts  Vite 6 + Tailwind v4 + proxy → :8787
```

- **Dev**: `bun run dev` — Vite on `:5173`, proxies `/api` → `:8787`
- **Prod**: `bun run build` → `dist/`; gateway serves it via `tower-http::ServeDir`
- Gateway locates `dist/` via `CHRONO_WEBUI_DIST` env or default `webui/dist/`
