// ── LLM Providers ──────────────────────────────────────────────

export interface LlmProvider {
  id: string;
  kind: string;
  base_url: string | null;
  display_name: string;
  enabled: boolean;
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
  has_secret: boolean;
  updated_at: string;
}

export interface LlmModel {
  provider_id: string;
  model_id: string;
  display_name: string | null;
  enabled: boolean;
  temperature: number | null;
  max_tokens: number | null;
  top_p: number | null;
  extra_headers_json: Record<string, unknown> | null;
  extra_body_json: Record<string, unknown> | null;
  thinking_level: string | null;
  json_ext: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ProviderView extends LlmProvider {
  has_credential: boolean;
  models: LlmModel[];
}

// ── Bot Profiles (Configs) ─────────────────────────────────────

export interface BotProfile {
  id: string;
  display_name: string;
  system_prompt: string;
  model_ref: string;
  tools_allowlist_json: string[];
  skills_allowlist_json: string[];
  policy_json: BotPolicy;
  enabled: boolean;
  json_ext: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BotPolicy {
  commands?: { new_session?: boolean };
  context_scope?: "session" | "bot" | "account";
  max_context_messages?: number;
  mention_required?: boolean;
  [key: string]: unknown;
}

// ── Platform Accounts ──────────────────────────────────────────

export interface PlatformAccount {
  id: string;
  platform: string;
  display_name: string;
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
  display_name: string;
  adapter_id: string;
  enabled: boolean;
  has_secret: boolean;
  adapter_config_json: Record<string, unknown>;
  json_ext: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ── Bindings (Attachments) ─────────────────────────────────────

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
  bot_profile_id: string;
  account_id: string;
  chat_id: string;
  route_key: string;
  status: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface SessionDetail {
  session_id: string;
  bot_profile_id: string;
  account_id: string;
  chat_id: string;
  route_key: string;
  status: string;
  messages_json: string;
  created_at: string;
  updated_at: string;
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
  kind: string;
  base_url?: string | null;
  display_name: string;
  enabled?: boolean;
  json_ext?: Record<string, unknown>;
}

export interface CredentialBody {
  auth_kind: string;
  secret_ref: string;
  json_ext?: Record<string, unknown>;
}

export interface ModelBody {
  model_id: string;
  display_name?: string | null;
  enabled?: boolean;
  temperature?: number | null;
  max_tokens?: number | null;
  top_p?: number | null;
  thinking_level?: string | null;
  extra_headers_json?: Record<string, unknown> | null;
  extra_body_json?: Record<string, unknown> | null;
  json_ext?: Record<string, unknown>;
}

export interface BotBody {
  id?: string;
  display_name?: string;
  system_prompt?: string;
  model_ref?: string;
  tools_allowlist_json?: string[];
  skills_allowlist_json?: string[];
  policy_json?: BotPolicy;
  enabled?: boolean;
  json_ext?: Record<string, unknown>;
}

export interface AccountBody {
  id?: string;
  platform: string;
  display_name: string;
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

// ── Tools ─────────────────────────────────────────────────────

export interface ToolInfo {
  name: string;
  label: string;
  description: string;
}
