# ChronoSys WebUI 开发指南

从零实现一个能**正常编辑配置并形成可运行闭环**的 WebUI 时，需要同时满足三件事：

1. **正确的领域模型**（平台 / 配置文件 / 人格面 / 模型目录）
2. **正确的交互闭环**（谁选择谁、谁编辑谁、保存后谁热加载）
3. **与现有 REST + SQLite 契约一致的数据结构**（当前没有独立 Persona 表）

本文以仓库当前实现为准：`chrono.db` + `/api/v1/*` + `webui/`。

---

## 1. 先建立心智模型

### 1.1 四个概念

| 概念 | 运营语义 | 当前落库 | 备注 |
|------|----------|----------|------|
| **Providers** | LLM 后端与可用模型目录 | `llm_providers` / `llm_credentials` / `llm_models` | 模型参数（temp/max_tokens/…）在模型行上 |
| **Config（配置文件）** | 一份可被平台选用的运行配置 | `bot_profiles` | 含模型引用 + 人格字段 + policy |
| **Persona（人格）** | 配置文件中的提示词与工具权限 | **同一行** `bot_profiles` 的子集字段 | **不是独立表** |
| **Platforms** | 消息平台账号 + 选用哪份配置 | `platform_accounts` + `bindings` | UI 应叫「Attach config」，底层 API 仍是 `/bindings` |

### 1.2 闭环关系（必须先通）

```text
Providers
  provider + credential + allowlisted model
        │
        │  model_ref = "provider_id/model_id"
        ▼
Config (bot_profiles)
  identity / enabled / model_ref / policy
  + persona fields: system_prompt / tools / skills
        ▲
        │  平台选用配置（bindings 行）
        │  account_id + chat_pattern → bot_profile_id
Platforms (platform_accounts)
  secret_ref + adapter_config
```

消息真正跑通的最小条件：

1. 至少一个 **enabled provider**，且有 **credential** 和至少一个 **enabled model**
2. 至少一份 **enabled config**，`model_ref` 指向上述模型
3. 该 config 的 **system_prompt** 非空（或你接受空提示词）
4. 至少一个 **enabled platform account**，且 `secret_ref` 可解析
5. 至少一条 **enabled attachment**（`bindings`）把 account 指到该 config

缺任一步，WebUI 应在 Overview 标红并给出跳转，而不是只显示“成功保存”。

### 1.3 命名对照（UI 词 vs API/DB 词）

| UI 用语 | REST | 表 |
|---------|------|----|
| Config | `/api/v1/bots` | `bot_profiles` |
| Persona | 仍用 `/api/v1/bots/:id`（只改人格字段） | `bot_profiles` 子集 |
| Platform account | `/api/v1/accounts` | `platform_accounts` |
| Attach config | `/api/v1/bindings` | `bindings` |
| Provider / Model | `/api/v1/providers...` | `llm_*` |

**不要**在后端还没改名时，把前端请求路径改成 `/configs` / `/personas`——当前网关没有这些路由。

---

## 2. 数据结构（配置编辑所需的全部字段）

DB 路径：`$CHRONO_HOME/state/chrono.db`（默认 `.chrono/state/chrono.db`）。

### 2.1 `llm_providers`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | 如 `deepseek` |
| `kind` | TEXT | `openai` / `deepseek` / `anthropic` / `custom`… |
| `base_url` | TEXT? | 自定义网关 |
| `display_name` | TEXT | UI 显示名 |
| `enabled` | 0/1 | |
| `json_ext` | JSON object | 扩展 |

### 2.2 `llm_credentials`（1:1 provider）

| 字段 | 类型 | 说明 |
|------|------|------|
| `provider_id` | TEXT PK FK | |
| `auth_kind` | TEXT | 如 `api_key` / `env_ref` |
| `secret_ref` | TEXT | 见 §2.7 |
| `json_ext` | JSON | |

API 返回时 **永不回传明文 secret**，只给 `has_credential: bool`。

### 2.3 `llm_models`（PK = provider_id + model_id）

| 字段 | 类型 | 说明 |
|------|------|------|
| `provider_id` | TEXT | |
| `model_id` | TEXT | 如 `deepseek-v4-flash` |
| `display_name` | TEXT? | |
| `enabled` | 0/1 | |
| `temperature` | REAL? | |
| `max_tokens` | INTEGER? | |
| `top_p` | REAL? | |
| `thinking_level` | TEXT? | `off/minimal/low/medium/high` 等 |
| `extra_body_json` | JSON? | 请求体附加字段 |
| `extra_headers_json` | JSON? | |
| `json_ext` | JSON | |

**Config 只引用模型，不复制参数。**  
`model_ref` 解析规则：

```text
model_ref = "{provider_id}/{model_id}"
例：deepseek/deepseek-v4-flash
```

agent-host 用该字符串查 allowlist；查不到会报错。

### 2.4 `bot_profiles` = 配置文件（核心）

| 字段 | 类型 | 归属 UI | 说明 |
|------|------|---------|------|
| `id` | TEXT PK | Config 创建 | 稳定 id，attachment 依赖它 |
| `display_name` | TEXT | Config | |
| `enabled` | 0/1 | Config | disabled → resolveBot 返回 null |
| `model_ref` | TEXT | Config | 必须是 allowlist 中的 `provider/model` |
| `policy_json` | JSON object | Config | 路由/会话策略，见 §2.8 |
| `system_prompt` | TEXT | **Persona** | 人格主体 |
| `tools_allowlist_json` | JSON array of string | **Persona** | 如 `["message_send"]` |
| `skills_allowlist_json` | JSON array of string | **Persona** | 技能 id 列表 |
| `json_ext` | JSON object | 预留 | |
| `created_at` / `updated_at` | TEXT | 只读 | |

运行时解析结果（agent-host `ResolvedBot`）需要：

- `modelRef` + 解析后的 model overrides
- `systemPrompt`
- `toolsAllowlist` / `skillsAllowlist`
- `policy`

所以 WebUI 若漏写 `model_ref` 或把 tools 存成非数组，配置“看起来保存了”但 agent 起不来。

### 2.5 `platform_accounts`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | 如 `tg1` |
| `platform` | TEXT | 目前主路径 `telegram` |
| `display_name` | TEXT | |
| `adapter_id` | TEXT | 如 `telegram` 或 `chrono.adapter.telegram` |
| `enabled` | 0/1 | |
| `secret_ref` | TEXT | token/env/file，**API 列表不回传**，只有 `has_secret` |
| `adapter_config_json` | JSON | 平台私有配置，Telegram 常用 `{"bot_username":"..."}` |
| `json_ext` | JSON | |

### 2.6 `bindings` = 平台选用配置（attachment）

| 字段 | 类型 | UI 语义 |
|------|------|---------|
| `id` | TEXT PK | attachment id（创建时需提供） |
| `account_id` | TEXT FK | 哪个平台账号 |
| `bot_profile_id` | TEXT FK | 选用哪份 Config |
| `chat_pattern` | TEXT | 路由模式：`*` / `dm:*` / `group:*` / `chat:{id}` |
| `session_mode` | TEXT | `shared` / `dm` / `group` |
| `priority` | INTEGER | 大者优先（网关按 priority DESC 取） |
| `enabled` | 0/1 | |
| `json_ext` | JSON | |

唯一约束：`UNIQUE(account_id, chat_pattern, bot_profile_id)`。

**同一账号可 attach 多份 config**（不同 pattern/priority）。  
UI 不应把这层叫“binding 业务对象”，应呈现为：

> 这个平台账号在哪些会话模式/pattern 下使用哪份配置文件。

### 2.7 `secret_ref` 格式

三种合法形式（`validate_secret_ref`）：

| 形式 | 例子 | 说明 |
|------|------|------|
| literal | `123456:AA...` | 明文写入 DB（仅本地/开发） |
| env | `env:TG_TOKEN` | 运行时读环境变量 |
| file | `file:/path/to/token` | 运行时读文件 |

规则：

- 创建 account / credential：**必填非空**
- 更新 account：`secret_ref` 省略或空 → **保留原值**
- UI 编辑时 secret 输入框默认空；提示 “leave blank to keep”
- 列表页只显示 `has_secret` / `has_credential`，永不回显 secret

### 2.8 `policy_json` 常见形状

无强 schema，但现网 greeter 使用类似：

```json
{
  "commands": { "new_session": true },
  "context_scope": "session",
  "max_context_messages": 0,
  "mention_required": false
}
```

WebUI 至少要：

- 能 JSON 编辑 + 保存前 `JSON.parse` 校验
- 默认 `{}`
- 不在 Persona 页改 policy（归属 Config）

### 2.9 JSON 字段类型约定

| 字段 | 必须是 |
|------|--------|
| `tools_allowlist_json` | `string[]` |
| `skills_allowlist_json` | `string[]` |
| `policy_json` | `object` |
| `adapter_config_json` | `object` |
| `extra_body_json` / `extra_headers_json` | `object` 或 null |
| `json_ext` | `object` |

保存时不要把数组字段写成对象，也不要把对象写成字符串。

---

## 3. REST 契约（配置编辑最小集合）

Base：`/api/v1`  
Auth：loopback 可无 token；非 loopback 需要 `Authorization: Bearer $CHRONO_AUTH_TOKEN`。

### 3.1 路由清单

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/health` | 闭环状态摘要 |
| GET/POST | `/providers` | 列表 / 创建 provider |
| GET/PUT/DELETE | `/providers/{id}` | 读写删 |
| GET/PUT/DELETE | `/providers/{id}/credential` | 凭证 |
| GET/POST | `/providers/{id}/models` | 列表 / upsert model（body 带 `model_id`） |
| GET/DELETE | `/providers/{id}/models/{model_id}` | 读 / 删 model |
| GET/POST | `/bots` | 列表 / 创建 **Config** |
| GET/PUT/DELETE | `/bots/{id}` | 读 / 全量更新 / 删 Config |
| GET/POST | `/accounts` | 列表 / 创建平台账号 |
| GET/PUT/DELETE | `/accounts/{id}` | 更新时 secret 可省略保留 |
| GET/POST | `/bindings` | 列表 / 创建 attachment（**id 必填**） |
| GET/PUT/DELETE | `/bindings/{id}` | |
| GET | `/sessions` `/sessions/{id}` | 观测 |
| GET | `/audit` | 失败排查 |
| WS | `/ws` | 实时（sessions/audit/metrics） |

### 3.2 关键写入语义（极易踩坑）

`PUT /bots/{id}` **不是 PATCH**。  
Body 必须带齐字段；漏字段会用默认值覆盖，例如：

- 漏 `system_prompt` → 可能变成空字符串
- 漏 `tools_allowlist_json` → 可能回落到默认 `["message_send"]`

**正确做法：**

1. `GET /bots/:id` 拉全量
2. 只改本页负责的字段
3. 其余字段原样回写
4. `PUT` 全量

Config 页与 Persona 页都遵守这条，否则两页互相“擦掉”对方的编辑。

### 3.3 创建 attachment 时 id 必填

`POST /bindings` 当前要求 body.`id` 非空。  
前端可生成：

```text
{accountId}-{configId}-{base36Time}
```

### 3.4 保存后的系统行为

bots / accounts / bindings / providers 的写操作会 `notify_reload()`：

- gateway 重新 `sync_from_config`
- 未解析的 secret → skip adapter，**不崩溃**
- agent-host 下轮读取新配置

WebUI 不需要手动调 reload；但应在 UI 上提示：secret 未解析时 adapter_count 可能仍为 0。

---

## 4. 页面与交互逻辑（从零必做）

### 4.1 信息架构（推荐侧栏顺序）

```text
Overview
Sessions
Platforms     ← 平台账号 + 选用配置
Config        ← 配置文件装配
Persona       ← 人格字段编辑
Providers     ← 模型目录
```

顺序表达工作流：**先有模型 → 再有配置/人格 → 平台选用配置 → 可观测**。

### 4.2 Overview（闭环检查器）

不要做成纯装饰仪表盘。至少：

| 检查项 | 判定 |
|--------|------|
| Provider + model | 存在 enabled provider 且 has_credential 且有 enabled model |
| Config file | 存在 enabled config 且 model_ref 非空 |
| Persona | 存在 enabled config 且 system_prompt trim 非空 |
| Platform account | 存在 enabled account 且 has_secret |
| Attach config | 存在 enabled binding |

每一项失败时提供跳转按钮。  
附加：`/health` 的 `adapter_count`、`agent_host`，以及 `/audit` 中的失败事件。

### 4.3 Providers

**职责：** 维护模型目录与凭证，不装配平台。

必做交互：

1. 创建 provider（id/kind/display_name/base_url/enabled）
2. 设置 credential（auth_kind + secret_ref 三态）
3. upsert model（model_id + 参数 + extra_body/headers）
4. 启用/禁用 model、删除 model
5. 列表清晰显示：credential 有无、models 列表

Config 页的模型下拉 **只应列出** `provider.enabled && model.enabled` 的项。

### 4.4 Config（配置文件）

**职责：装配，不深挖人格正文，不改模型采样参数。**

#### 列表页

- 卡片：display_name、id、model_ref、enabled
- 摘要：persona 前几十字 / tools 数量
- 显示哪些 platform 已 attach 此 config
- 创建：id + name + **model 下拉（必选）**
- 删除：确认后 `DELETE /bots/:id`（会级联影响 bindings）

#### 编辑页字段

| UI 区块 | 字段 | 来源 |
|---------|------|------|
| Identity | display_name, enabled | bots |
| Model | model_ref 下拉 | providers 展平 |
| Persona 摘要 | 只读 system_prompt 预览 + tools chips | bots GET |
| 入口 | “Edit persona” → `/persona/:id` | 路由 |
| Policy | policy_json 高级编辑 | bots |

保存时：

```ts
PUT /bots/:id {
  display_name,
  enabled,
  model_ref,
  policy_json,
  // 原样回写：
  system_prompt,
  tools_allowlist_json,
  skills_allowlist_json,
  json_ext
}
```

禁止在 Config 页放大型 prompt 编辑器（会与 Persona 职责冲突）。

### 4.5 Persona（人格面）

**职责：只编辑提示词与工具/技能权限。**

#### 列表页

- 以 config 为条目（因为无独立 persona 实体）
- 显示 prompt 预览、tools/skills 计数、关联 model_ref
- 空态引导去 `/config` 先建配置文件

#### 编辑页字段

| UI | 字段 |
|----|------|
| System prompt | `system_prompt` 大文本 |
| Tools | `tools_allowlist_json` 勾选（当前内置至少 `message_send`） |
| Skills | `skills_allowlist_json` 增删字符串 id |

保存时同样全量 PUT，但只改上述字段，其余从 GET 回写：

```ts
PUT /bots/:id {
  system_prompt, tools_allowlist_json, skills_allowlist_json,
  display_name, model_ref, policy_json, enabled, json_ext // 原样
}
```

页头应显示所属 config id 与 model_ref，并链回 `/config/:id`。

### 4.6 Platforms（平台 + 选用配置）

**职责：账号生命周期 + attach/detach 配置文件。**

#### 账号 CRUD

- 创建：id、platform、display_name、adapter_id、bot_username（进 adapter_config_json）、enabled、secret
- 编辑：secret 空白保留
- 删除：确认（级联删 bindings）

#### Attach config（不要叫 Binding）

每个账号展开后：

1. 列表：已 attach 的 config（显示 config 名、model_ref、persona 摘要、pattern、mode、priority）
2. 操作：Attach / Detach
3. Attach 表单：
   - config 下拉（来自 `/bots`）
   - chat_pattern（默认 `dm:*` 或 `*`）
   - session_mode（`dm`/`group`/`shared`）
   - priority（数字）
4. 无 config 时引导去 `/config`

创建 attachment：

```ts
POST /bindings {
  id: generated,
  account_id,
  bot_profile_id: selectedConfigId,
  chat_pattern,
  session_mode,
  priority,
  enabled: true,
  json_ext: {}
}
```

展示文案示例：

- “Attached configs”
- “Attach config”
- “Detach”
- “No config attached. Messages will not route.”

### 4.7 Sessions（观测，非配置主路径）

- 列表：session_id / bot_profile_id / 更新时间 / active
- 详情：transcript + tool trace
- 不负责改 config；可从 bot_profile_id 深链到 `/config/:id`

---

## 5. 前端实现结构（可复用当前栈）

### 5.1 推荐技术栈

| 层 | 建议 |
|----|------|
| Build | Vite |
| UI | React + TypeScript |
| Server state | TanStack Query |
| Ephemeral UI | Zustand（仅 auth token 等） |
| Style | Tailwind + 少量 form CSS tokens |
| Realtime | WebSocket `/api/v1/ws` |

### 5.2 建议模块划分

```text
webui/src/
  api.ts                 # fetch 封装 + 类型（Config/Account/ConfigAttachment/...）
  store.ts               # auth token
  components/
    Shell.tsx            # 侧栏导航
    ConfigCard.tsx
    forms.css
  pages/
    Overview.tsx
    PlatformsList.tsx
    ConfigList.tsx
    ConfigEditor.tsx
    PersonaList.tsx
    PersonaEditor.tsx
    ProvidersPage.tsx
    SessionsList.tsx
    SessionDetail.tsx
```

### 5.3 类型命名建议（前端）

即使 REST 仍叫 bots/bindings，前端类型也建议语义化：

```ts
type Config = { /* bot_profiles row */ };
type ConfigAttachment = { /* bindings row; bot_profile_id 即 config id */ };
type AccountView = { has_secret: boolean; /* ... */ };
type ProviderView = { has_credential: boolean; models: ModelInfo[] };
```

请求路径仍写 `/bots`、`/bindings`。

### 5.4 Query keys 约定

```ts
["providers"]
["bots"]            // configs
["bots", id]
["accounts"]
["bindings"]        // attachments
["health"]
["sessions"]
["audit"]
```

任何写操作后 `invalidateQueries` 对应 key；attachment 变更同时影响 platforms 与 config 卡片上的 attach 状态。

---

## 6. 字段所有权矩阵（防串改）

| 字段 | Providers | Config | Persona | Platforms |
|------|:---------:|:------:|:-------:|:---------:|
| provider/credential/model params | ✅ | 只读摘要 | ❌ | ❌ |
| config identity / enabled / model_ref / policy | ❌ | ✅ | 回写 | ❌ |
| system_prompt / tools / skills | ❌ | 只读摘要 | ✅ | ❌ |
| account secret / adapter_config | ❌ | ❌ | ❌ | ✅ |
| attachment account→config | ❌ | 只读展示 | ❌ | ✅ |

**两条硬规则：**

1. 谁不负责的字段，保存时必须从最新 GET 回写，禁止用空默认值覆盖  
2. 同一字段只允许一个主编辑入口

---

## 7. 从零开发的最小交付清单

### Phase A — 能读

- [ ] Shell 导航 + token 输入
- [ ] `GET /health` Overview
- [ ] Providers / Configs / Accounts / Attachments 只读列表

### Phase B — 能建目录

- [ ] Provider CRUD + credential + model upsert
- [ ] 模型下拉数据源可用

### Phase C — 能建配置文件

- [ ] `POST /bots` 创建 config（强制选 model）
- [ ] ConfigEditor：改 name/enabled/model/policy
- [ ] PersonaEditor：改 prompt/tools/skills
- [ ] 两端都做 GET→merge→PUT

### Phase D — 能挂到平台

- [ ] Account CRUD + secret 三态
- [ ] Attach/Detach config（`/bindings`）
- [ ] 列表显示“谁 attach 了谁”

### Phase E — 能自检

- [ ] Overview 五步闭环
- [ ] audit 失败可见
- [ ] 空态全部有下一步 CTA

### Phase F — 可观测

- [ ] Sessions list/detail
- [ ] WS 状态指示（可选订阅）

---

## 8. 验收用例（配置编辑是否“正常”）

### 8.1 数据闭环

```bash
# 1) 有模型
curl -s localhost:8787/api/v1/providers | jq '.[].models[].model_id'

# 2) 有配置且 model_ref 合法
curl -s localhost:8787/api/v1/bots | jq '.[]|{id,model_ref,enabled}'

# 3) 有人格
curl -s localhost:8787/api/v1/bots/greeter | jq '.system_prompt|length'

# 4) 有平台
curl -s localhost:8787/api/v1/accounts | jq '.[]|{id,has_secret,enabled}'

# 5) 有 attachment
curl -s localhost:8787/api/v1/bindings | jq '.[]|{account_id,bot_profile_id,chat_pattern,enabled}'
```

### 8.2 编辑互不破坏

1. Persona 保存 prompt = `A`  
2. Config 只改 display_name 并保存  
3. 再读 bot：prompt 仍为 `A`  
4. Config 改 model_ref 并保存  
5. 再读：prompt 仍为 `A`，tools 不变

### 8.3 Attach 可逆

1. Detach 后 `/bindings` 为空 → 消息不应路由到该 config  
2. Reattach 后恢复  
3. Config 卡片应显示 platform chip

### 8.4 Secret 未就绪时的可解释性

`secret_ref=env:TG_TOKEN` 但进程无该环境变量时：

- health 可能 `adapter_count=0`
- gateway 日志 skip account  
- WebUI 仍应显示 attachment 存在，并提示 secret 未解析（而不是假装 live）

---

## 9. 常见错误（实现时直接避免）

1. **把 Persona 做成独立资源路径**（`/personas`）但后端没有表/API  
2. **Config 页直接改 temperature**（那是 model 行字段，应在 Providers）  
3. **Platforms 页只建账号不 attach config**（永远不会路由）  
4. **PUT bots 只提交脏字段**（擦掉 prompt/tools）  
5. **model_ref 手填自由文本**（必须来自 allowlist 下拉）  
6. **创建 binding 不传 id**（API 400）  
7. **UI 继续使用 Binding 作为主文案**（运营心智应是“选用配置文件”）  
8. **列表展示 secret 明文**  
9. **tools/skills 存成对象或逗号字符串**  
10. **忽略 enabled 标志**（disabled config/account/model 运行时会被跳过）

---

## 10. 参考样例数据（闭环模板）

```text
llm_providers:  deepseek
llm_credentials: provider=deepseek secret_ref=env:DEEPSEEK_API_KEY
llm_models:     deepseek / deepseek-v4-flash  (enabled, temperature=0.7)

bot_profiles:   greeter
  model_ref=deepseek/deepseek-v4-flash
  system_prompt=...
  tools_allowlist_json=["message_send"]
  enabled=1

platform_accounts: tg1
  platform=telegram
  secret_ref=env:TG_TOKEN  (或 literal token)
  enabled=1

bindings: tg1-greeter
  account_id=tg1
  bot_profile_id=greeter
  chat_pattern=dm:*
  session_mode=dm
  priority=10
  enabled=1
```

有了以上五行关系，配置编辑才算“支撑运行”，而不是“表单能保存”。

---

## 11. 与旧文档的差异

`docs/WEBUI.md` 早期 IA 以 Bots/Bindings 表为中心。  
当前运营 IA 以 **Platforms → Config → Persona → Providers** 为中心：

- Bindings 降为 Platforms 内的 attachment 机制
- Bot profile 升为 Config 文件
- Persona 是 Config 的字段面，不是独立表

新 WebUI 开发以本文为准；`WEBUI.md` 保留视觉/实时协议方向，配置域以本文闭环为准。

---

## 12. 一句话总结

> 做一个能用的 ChronoSys WebUI，不是做五张 CRUD 表单，而是做出：  
> **模型目录可引用 → 配置文件可选模型并带人格 → 平台账号可选用配置文件 → Overview 能证明闭环成立。**  
> 数据结构上认清：`bot_profiles` 即配置文件，Persona 是其字段子集，`bindings` 是平台对配置的选择关系。
