/**
 * Row types matching the chrono-config Rust models (#serde aliases).
 *
 * These are used with `bun:sqlite`'s `.as(Type)` deserialization. The
 * database stores JSON strings for `json_ext`/`extra_*_json` etc.; we
 * declare them as `unknown` so callers apply their own narrowing or
 * JSON.parse as needed.
 */
export interface LlmProvider {
  id: string;
  kind: string;
  base_url: string | null;
  json_ext: string;
  created_at: string;
  updated_at: string;
}

export interface LlmCredential {
  provider_id: string;
  auth_kind: string;
  secret_ref: string;
  json_ext: string;
  updated_at: string;
}

export interface LlmModel {
  provider_id: string;
  model_id: string;
  temperature: number | null;
  max_tokens: number | null;
  top_p: number | null;
  thinking_level: string | null;
  extra_body_json: string | null;
  json_ext: string;
  created_at: string;
  updated_at: string;
}

export interface PlatformAccount {
  id: string;
  platform: string;
  adapter_id: string;
  enabled: number;
  secret_ref: string;
  adapter_config_json: string;
  json_ext: string;
  created_at: string;
  updated_at: string;
}

export interface Persona {
  id: string;
  system_prompt: string;
  tools_allowlist_json: string;
  skills_allowlist_json: string;
  json_ext: string;
  created_at: string;
  updated_at: string;
}

export interface BotProfile {
  id: string;
  persona_id: string | null;
  model_ref: string;
  policy_json: string;
  json_ext: string;
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
  enabled: number;
  json_ext: string;
  created_at: string;
  updated_at: string;
}
