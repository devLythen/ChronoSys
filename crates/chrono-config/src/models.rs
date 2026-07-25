use serde::{Deserialize, Serialize};

// ── LlmProviders ────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LlmProvider {
    pub id: String,
    pub kind: String,
    pub base_url: Option<String>,
    pub json_ext: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LlmCredential {
    pub provider_id: String,
    pub auth_kind: String,
    pub secret_ref: String,
    pub json_ext: serde_json::Value,
    pub updated_at: String,
}

// ── LlmModels ───────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LlmModel {
    pub provider_id: String,
    pub model_id: String,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i64>,
    pub top_p: Option<f64>,
    pub thinking_level: Option<String>,
    pub extra_body_json: Option<serde_json::Value>,
    pub json_ext: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

// ── PlatformAccounts ────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlatformAccount {
    pub id: String,
    pub platform: String,
    pub adapter_id: String,
    pub enabled: bool,
    pub secret_ref: String,
    pub adapter_config_json: serde_json::Value,
    pub json_ext: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

// ── Personas ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Persona {
    pub id: String,
    pub system_prompt: String,
    pub tools_allowlist_json: serde_json::Value,
    pub skills_allowlist_json: serde_json::Value,
    pub json_ext: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

// ── BotProfiles ─────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BotProfile {
    pub id: String,
    pub model_ref: String,
    pub persona_id: Option<String>,
    pub policy_json: serde_json::Value,
    pub json_ext: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

// ── Bindings ────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Binding {
    pub id: String,
    pub account_id: String,
    pub chat_pattern: String,
    pub bot_profile_id: String,
    pub session_mode: String,
    pub priority: i64,
    pub enabled: bool,
    pub json_ext: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

// ── Settings ────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Setting {
    pub key: String,
    pub value_json: serde_json::Value,
    pub updated_at: String,
}
