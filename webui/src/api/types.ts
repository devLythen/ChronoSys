// ── LLM Providers ──────────────────────────────────────────────

export interface LlmProvider {
  id: string;
  kind: string;
  base_url: string | null;
  json_ext: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface LlmCredential {
  provider_id: string;
  auth_kind: string;
  secret_ref: string;
  json_ext: Record<string, unknown>;
  updated_at: string;
}

export interface CredentialView {
  provider_id: string;
  auth_kind: string;
  secret_ref: string;
  updated_at: string;
}

export interface LlmModel {
  provider_id: string;
  model_id: string;
  temperature: number | null;
  max_tokens: number | null;
  top_p: number | null;
  thinking_level: string | null;
  extra_body_json: Record<string, unknown> | null;
  json_ext: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ProviderView extends LlmProvider {
  secret_ref?: string | null;
  models: LlmModel[];
}


export interface ModelInfo {
  name: string;
  reasoning: boolean;
  thinkingLevels: string[];
  /** Full provider-level mapping of thinking levels. New in M3. */
  thinkingLevelMap?: Record<string, string | null>;
  maxTokens: number;
  contextWindow: number;
  input: string[];
  /** Provider ID. New in M3. */
  provider?: string;
  /** API identifier. New in M3. */
  api?: string;
  /** Per-token cost rates. New in M3. */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface RefreshedModel {
  id: string;
}
// ── Personas ────────────────────────────────────────────────────

export interface Persona {
  id: string;
  system_prompt: string;
  tools_allowlist_json: string[];
  skills_allowlist_json: string[];
  json_ext: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ── Bot Profiles (Configs) ─────────────────────────────────────

export interface BotProfile {
  id: string;
  model_ref: string;
  persona_id: string | null;
  policy_json: BotPolicy;
  json_ext: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BotPolicy {
  max_turns?: number;
  drop_turns?: number;
  compact_strategy?: "compact" | "drop";
  compact_model_ref?: string;
  compact_prompt?: string;
  context_window_fallback?: number;
  disabled_commands?: string[];
  mention_required?: boolean;
  show_timestamp?: boolean;
  sender_identity?: "none" | "prefix" | "block";
  timezone?: string;
  [key: string]: unknown;
}

// ── Platform Accounts ──────────────────────────────────────────

export interface PlatformAccount {
  id: string;
  platform: string;
  adapter_id: string;
  enabled: boolean;
  secret_ref: string;
  adapter_config_json: Record<string, unknown>;
  json_ext: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AccountView {
  id: string;
  platform: string;
  adapter_id: string;
  enabled: boolean;
  secret_ref: string;
  adapter_config_json: Record<string, unknown>;
  json_ext: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Binding {
  id: string;
  account_id: string;
  chat_pattern: string;
  bot_profile_id: string;
  session_mode: string;
  priority: number;
  enabled: boolean;
  json_ext: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ── Sessions ───────────────────────────────────────────────────

export interface SessionSummary {
  session_id: string;
  route_key: string;
  session_key: string;
  bot_profile_id: string;
  updated_at: string;
  created_at: string;
  message_count: number;
  active: boolean;
}

export interface SessionDetail {
  session_id: string;
  route_key: string;
  session_key: string;
  bot_profile_id: string;
  messages: unknown;
  created_at: string;
  updated_at: string;
  active: boolean;
}

// ── Health ─────────────────────────────────────────────────────

export interface HealthResponse {
  status: string;
  uptime_secs: number;
  agent_host: string;
  adapter_count: number;
  session_count: number;
  account_count: number;
  bot_count: number;
}

// ── Audit ──────────────────────────────────────────────────────

export interface AuditEntry {
  time?: string;
  event?: string;
  session_id?: string;
  account_id?: string;
  tool?: string;
  allowed?: boolean;
  latency_ms?: number;
  error?: string;
  [key: string]: unknown;
}

// ── Settings ───────────────────────────────────────────────────

export interface Setting {
  key: string;
  value_json: unknown;
  updated_at: string;
}

// ── API Error ──────────────────────────────────────────────────

export interface ApiError {
  error: string;
  detail?: string;
}

// ── Request Bodies ─────────────────────────────────────────────

export interface ProviderBody {
  id?: string;
  kind?: string;
  base_url?: string | null;
  json_ext?: Record<string, unknown>;
}

export interface CredentialBody {
  auth_kind: string;
  secret_ref?: string | null;
  json_ext?: Record<string, unknown>;
}

export interface ModelBody {
  model_id: string;
  temperature?: number | null;
  max_tokens?: number | null;
  top_p?: number | null;
  thinking_level?: string | null;
  extra_body_json?: Record<string, unknown> | null;
  json_ext?: Record<string, unknown>;
}

export interface BotBody {
  id?: string;
  model_ref?: string;
  persona_id?: string | null;
  policy_json?: BotPolicy;
  json_ext?: Record<string, unknown>;
}

export interface PersonaBody {
  id?: string;
  system_prompt?: string;
  tools_allowlist_json?: string[];
  skills_allowlist_json?: string[];
  json_ext?: Record<string, unknown>;
}

export interface AccountBody {
  id?: string;
  platform: string;
  adapter_id: string;
  enabled?: boolean;
  secret_ref?: string;
  adapter_config_json?: Record<string, unknown>;
  json_ext?: Record<string, unknown>;
}

export interface BindingBody {
  id: string;
  account_id: string;
  bot_profile_id: string;
  chat_pattern?: string;
  session_mode?: string;
  priority?: number;
  enabled?: boolean;
  json_ext?: Record<string, unknown>;
}

export interface SettingBody {
  key?: string;
  value_json: unknown;
}

export interface NativeToolView {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
}

export interface PluginPolicyView {
  enabled: boolean;
  config: Record<string, string | boolean>;
  tools: Record<string, { persona_blacklist: string[] }>;
}

export interface PluginConfigField {
  key: string;
  label: string;
  type: "string" | "boolean";
  default: string | boolean;
  description?: string;
}

export interface PluginView {
  id: string;
  name: string;
  version: string;
  description: string;
  configSchema: PluginConfigField[];
  tools: NativeToolView[];
  commands: NativeToolView[];
  status: string;
  policy: PluginPolicyView;
  error?: string;
}

export interface ToolInfo {
  name: string;
  label: string;
  description: string;
}
