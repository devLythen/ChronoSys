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
  display_name: string;
  enabled: number; // SQLite boolean as 0/1
  json_ext: string; // JSON string from DB
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
  display_name: string | null;
  enabled: number;
  temperature: number | null;
  max_tokens: number | null;
  top_p: number | null;
  extra_headers_json: string | null;
  extra_body_json: string | null;
  thinking_level: string | null;
  json_ext: string;
  created_at: string;
  updated_at: string;
}

export interface PlatformAccount {
  id: string;
  platform: string;
  display_name: string;
  adapter_id: string;
  enabled: number;
  secret_ref: string;
  adapter_config_json: string;
  json_ext: string;
  created_at: string;
  updated_at: string;
}

export interface BotProfile {
  id: string;
  display_name: string;
  system_prompt: string;
  model_ref: string;
  tools_allowlist_json: string;
  skills_allowlist_json: string;
  policy_json: string;
  enabled: number;
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
