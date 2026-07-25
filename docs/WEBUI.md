# WebUI

ChronoSys 的管理与观测面板。操作员通过浏览器管理平台账号、配置文件、人格、模型目录、会话和审计日志。

## 设计理念

**Swiss Modernism.** 排版本身就是视觉元素——不用渐变、阴影或装饰性 UI 控件。黑白对比、直角边缘、充裕留白。半调点阵和单色渐变块提供纹理，不分散注意力。

**编辑式布局，非仪表盘。** 页面自上而下阅读，具有清晰的排版层次。表格只在数据需要时才出现。内容决定形式。

**极简动效。** 页面进入和滚动揭示动画服务于可读性，非炫技。尊重 `prefers-reduced-motion`。

---

## 1. 技术栈

| 层 | 选择 |
|----|------|
| 构建 | Vite 6 |
| UI | React 19 + TypeScript |
| 样式 | Tailwind CSS v4 + CSS 设计令牌 |
| 状态 | TanStack Query（服务端）+ Zustand（auth token） |
| 路由 | HashRouter（`/#/overview`，`/#/platforms`，…） |
| **Providers** | LLM 后端与可用模型目录 | `llm_providers` / `llm_credentials` / `llm_models` | 模型参数在模型行上 |
| **Config** | 一份可被平台选用的运行配置 | `bot_profiles` | model_ref + persona_id FK + policy |
| **Persona** | 提示词与工具/技能权限 | `personas`（独立表） | 与 Config 独立创建和删除 |
| **Platforms** | 消息平台账号 + 选用哪份配置 | `platform_accounts` + `bindings` | UI 称「Attach config」 |

### 闭环关系

```
Providers
  provider + credential (plaintext API key) + model
        │
        │  model_ref = "provider_id/model_id"
        ▼
Config (bot_profiles)
  model_ref + persona_id → Persona (system_prompt + tools + skills)
  + policy
        ▲
        │  平台选用配置（bindings）
Platforms (platform_accounts)
  secret_ref (plaintext bot token) + adapter_config
```

### 命名对照

| UI 用语 | REST 路径 | 数据库表 |
|---------|-----------|----------|
| Config | `/api/v1/bots` | `bot_profiles` |
| Persona | `/api/v1/personas` | `personas` |
| Platform account | `/api/v1/accounts` | `platform_accounts` |
| Attach config | `/api/v1/bindings` | `bindings` |
| Provider / Model | `/api/v1/providers` | `llm_providers` / `llm_models` |

消息跑通的最小条件（Overview 页逐项检查）：

1. 至少一个 **enabled provider**，有 credential，至少一个 **enabled model**
2. 至少一份 **enabled config**，`model_ref` 指向上述模型
---
## 3. 信息架构

```
/#/overview      系统健康 + 配置完整性检查清单
/#/platforms     消息平台账号 + Attach config
/#/config        配置文件列表 — 装配 model + policy
/#/config/:id    配置编辑器
/#/providers     LLM 提供商、凭证、模型目录
/#/persona       人格列表 — 独立创建编辑
/#/persona/:id   人格编辑器（system prompt + tools + skills）
/#/sessions      活跃与历史会话
/#/sessions/:id  会话详情（transcript + 元数据）
/#/audit         工具与适配器审计日志
/#/settings      Auth token + 实例信息
```

**导航顺序反映操作员工作流**：先设平台账号 → 再建配置选模型 → 模型来自 Providers，人格独立创建。

---

## 4. 视觉设计

### 排版层级

| Class | 尺寸 | 用途 |
|-------|------|------|
| `.t-display` | clamp(1.75rem, 4vw, 2.75rem) | 页面标题 |
| `.t-headline` | clamp(1.1rem, 2vw, 1.35rem) | 区块标题、卡片名称 |
| `.t-title` | 1rem | 弹窗标题 |
| `.t-body` | 0.875rem | 正文 |
| `.t-label` | 0.6875rem uppercase | 表单标签、元数据 |
| `.t-mono` | 0.8125rem | ID、模型引用、代码 |

字体：**Inter**（正文）+ **JetBrains Mono**（等宽）。

### 调色板

| 令牌 | 值 | 用途 |
|------|-----|------|
| `--color-bg` | `#FAFAFA` | 页面背景 |
| `--color-fg` | `#0A0A0A` | 文字、强调 |
| `--color-card` | `#FFFFFF` | 卡片表面 |
| `--color-muted` | `#F0F0F0` | 次级背景 |
| `--color-muted-fg` | `#6B6B6B` | 次级文字 |
| `--color-border` | `#E0E0E0` | 边框、分割线 |
| `--color-success` | `#16A34A` | 启用、在线、正常 |
| `--color-destructive` | `#DC2626` | 错误、删除 |

无圆角。无阴影。深度仅通过边框和颜色对比传达。

### 装饰元素

| Class | 效果 |
|-------|------|
| `.halftone` | 黑色点阵，12px 网格 |
| `.halftone-light` | 灰色点阵，10px 网格 |
| `.rule-heavy` | 4px 黑色水平分割线 |
| `.rule-thin` | 1px 灰色水平分割线 |

---

## 5. REST 契约

Base：`/api/v1`。loopback 无需 token；非 loopback 需 `Authorization: Bearer $CHRONO_AUTH_TOKEN`。

### 路由

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/health` | 闭环状态摘要 |
| GET/POST | `/providers` | 列表 / 创建 provider |
| GET/PUT/DELETE | `/providers/{id}` | 读写删 |
| GET/PUT/DELETE | `/providers/{id}/credential` | 凭证 |
| GET/POST | `/providers/{id}/models` | 列表 / upsert model |
| GET/DELETE | `/providers/{id}/models/{model_id}` | 读 / 删 model |
| GET/POST | `/bots` | 列表 / 创建 Config |
| GET/PUT/DELETE | `/bots/{id}` | 读 / 全量更新 / 删 |
| GET/POST | `/accounts` | 列表 / 创建平台账号 |
| GET/PUT/DELETE | `/accounts/{id}` | 更新时 secret 可省略保留 |
| GET/POST | `/bindings` | 列表 / 创建 attachment（id 必填） |
| GET/PUT/DELETE | `/bindings/{id}` | |
| GET | `/tools` | 可用工具目录 |
| GET | `/sessions` `/sessions/{id}` | 观测 |
| GET | `/audit` | 审计日志 |
| WS | `/ws` | 实时推送 |

### 关键语义

**`PUT /bots/{id}` 是全量替换，不是 PATCH。** Config 和 Persona 页共享同一行数据，各自只改自己负责的字段。保存时必须：GET 全量 → 合并本页修改 → PUT 全量。否则两页互相覆盖。

**`POST /bindings` 要求 body.id 非空。** 前端生成：`{accountId}-{configId}-{timestamp36}`。

**`secret_ref` 永不回传。** 列表返回 `has_secret: bool`。编辑时输入框默认为空，留空表示保留原值。

**写操作自动触发 `config.reload`。** 保存后 gateway 重新 sync adapter，agent-host 热读新配置，无需手动重启。

### 字段所有权矩阵

| 字段 | Providers | Config | Persona | Platforms |
|------|:---------:|:------:|:-------:|:---------:|
| provider / credential / model 参数 | ✅ | 只读 | — | — |
| display_name / enabled / model_ref / policy | — | ✅ | 保留 | — |
| system_prompt / tools / skills | — | 只读 | ✅ | — |
| account secret / adapter_config | — | — | — | ✅ |
| attachment（account → config） | — | 只读 | — | ✅ |

**硬规则**：不负责的字段，保存时必须从 GET 原样回写。同一字段只有一个主编辑入口。

---

## 6. 页面规格

### Shell
- 顶部固定导航栏，水平文字链接（无图标、无侧栏）
- 激活项：黑底白字
- 内容区 `max-w-6xl` 居中，响应式 padding
- 页脚显示版本号

### Overview
- 统计卡片网格：uptime、agent 状态、adapter 数、session 数
- 五步闭环检查清单，每项带状态标记和跳转链接
- 半调装饰块分隔区块

### Platforms
- 账号卡片：横向全宽，左信息右操作
- 展开显示已 attach 的 config 列表
- Attach 表单：config 下拉 / chat_pattern / session_mode / priority
- Secret 输入提示：「留空保留现有 secret」
- 术语：「Attach config」/「Detach」，禁用「Binding」

### Config
- **model_ref 是 Select 下拉**，数据源：enabled provider + enabled model 的交集
- Policy 编辑器：JSON textarea，保存前 `JSON.parse` 校验
- Persona 字段只读预览，链接到 Persona 页编辑
- 创建时 model 必选

### Persona
- **独立于 Config**：可直接创建、编辑，不依赖 Config 页
- System prompt：大文本框，等宽字体
- Tools：从 `/api/v1/tools` 动态获取，checkbox 网格，带 label 说明
- Skills：标签式增删

### Providers
- 横向全宽卡片，可展开显示 model 列表
- Credential 弹窗：auth_kind 选择 + secret_ref 输入
- Model 弹窗：model_id / display_name / temperature / max_tokens / thinking_level

### Sessions
- 列表：5 秒自动刷新
- 详情：左侧 transcript 气泡，右侧元数据卡片
- 支持 Abort 和 Steer（未配置时返回提示）

### Audit
- 可筛选表格：limit / account_id / session_id / event
- 等宽字体显示 ID，状态 Badge

### Settings
- Auth token 管理：设置 / 显示 / 清除
- 实例信息（版本、gateway 地址、技术栈）

---

## 7. 组件模式

### 空态
半调浅色背景，居中文字 + CTA 链接。示例：「No accounts yet. Create one to get started.」

### 加载态
居中 `.t-body` 灰色文字：「Loading…」

### 错误态
红色文字显示错误信息。

### 弹窗与提示
- Modal：`React.createPortal` 渲染到 `document.body`，`z-[100]`，锁定 body 滚动
- Toast：`z-[200]`，4 秒自动消失，右下角堆叠

---

## 8. 常见错误

1. 把 Persona 当成独立资源路径（`/personas`）——后端无此表
2. Config 页直接改 temperature——那是 model 行字段，应在 Providers
3. Platforms 页只建账号不 attach config——永远不会路由
4. PUT bots 只提交脏字段——擦掉另一页的编辑
5. model_ref 手填自由文本——必须来自 allowlist 下拉
6. 创建 binding 不传 id——API 400
7. 列表展示 secret 明文
8. tools / skills 存成对象或逗号字符串
9. 忽略 enabled 标志——disabled 的实体运行时会跳过

---

## 9. 构建与部署

```
webui/
├── src/           TypeScript 源码
├── dist/          构建输出（git-ignored）
├── package.json   bun install
└── vite.config.ts Vite 6 + Tailwind v4 + proxy → :8787
```

- **开发**：`cd webui && bun run dev` — Vite 在 `:5173`，`/api` 代理到 `:8787`
- **生产**：`bun run build` → `dist/`；gateway 通过 `tower-http::ServeDir` 提供静态文件
