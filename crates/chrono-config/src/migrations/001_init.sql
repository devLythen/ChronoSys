-- Migration 001: Core config schema

CREATE TABLE IF NOT EXISTS schema_migrations (
    version  INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
    name      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_providers (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    base_url     TEXT,
    display_name TEXT NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1,
    json_ext     TEXT NOT NULL DEFAULT '{}',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS llm_credentials (
    provider_id TEXT PRIMARY KEY REFERENCES llm_providers(id) ON DELETE CASCADE,
    auth_kind   TEXT NOT NULL,
    secret_ref  TEXT NOT NULL,
    json_ext    TEXT NOT NULL DEFAULT '{}',
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS llm_models (
    provider_id         TEXT NOT NULL REFERENCES llm_providers(id) ON DELETE CASCADE,
    model_id            TEXT NOT NULL,
    display_name        TEXT,
    enabled             INTEGER NOT NULL DEFAULT 1,
    temperature         REAL,
    max_tokens          INTEGER,
    top_p               REAL,
    extra_headers_json  TEXT,
    extra_body_json     TEXT,
    thinking_level      TEXT,
    json_ext            TEXT NOT NULL DEFAULT '{}',
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (provider_id, model_id)
);

CREATE TABLE IF NOT EXISTS platform_accounts (
    id                   TEXT PRIMARY KEY,
    platform             TEXT NOT NULL,
    display_name         TEXT NOT NULL,
    adapter_id           TEXT NOT NULL,
    enabled              INTEGER NOT NULL DEFAULT 1,
    secret_ref           TEXT NOT NULL,
    adapter_config_json  TEXT NOT NULL DEFAULT '{}',
    json_ext             TEXT NOT NULL DEFAULT '{}',
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bot_profiles (
    id                    TEXT PRIMARY KEY,
    display_name          TEXT NOT NULL,
    system_prompt         TEXT NOT NULL DEFAULT '',
    model_ref             TEXT NOT NULL,
    tools_allowlist_json  TEXT NOT NULL DEFAULT '[]',
    skills_allowlist_json TEXT NOT NULL DEFAULT '[]',
    policy_json           TEXT NOT NULL DEFAULT '{}',
    enabled               INTEGER NOT NULL DEFAULT 1,
    json_ext              TEXT NOT NULL DEFAULT '{}',
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bindings (
    id             TEXT PRIMARY KEY,
    account_id     TEXT NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
    chat_pattern   TEXT NOT NULL,
    bot_profile_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
    session_mode   TEXT NOT NULL DEFAULT 'shared',
    priority       INTEGER NOT NULL DEFAULT 0,
    enabled        INTEGER NOT NULL DEFAULT 1,
    json_ext       TEXT NOT NULL DEFAULT '{}',
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(account_id, chat_pattern, bot_profile_id)
);

CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
