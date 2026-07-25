-- Migration 002: Separate personas from bot_profiles

CREATE TABLE IF NOT EXISTS personas (
    id                    TEXT PRIMARY KEY,
    display_name          TEXT NOT NULL,
    system_prompt         TEXT NOT NULL DEFAULT '',
    tools_allowlist_json  TEXT NOT NULL DEFAULT '["message_send"]',
    skills_allowlist_json TEXT NOT NULL DEFAULT '[]',
    json_ext              TEXT NOT NULL DEFAULT '{}',
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Move existing persona data from bot_profiles to personas
INSERT OR IGNORE INTO personas (id, display_name, system_prompt, tools_allowlist_json, skills_allowlist_json, json_ext, created_at, updated_at)
SELECT id, display_name, system_prompt, tools_allowlist_json, skills_allowlist_json, json_ext, created_at, updated_at
FROM bot_profiles;

-- Recreate bot_profiles without persona columns, adding persona_id FK
CREATE TABLE bot_profiles_new (
    id                    TEXT PRIMARY KEY,
    display_name          TEXT NOT NULL,
    model_ref             TEXT NOT NULL DEFAULT '',
    persona_id            TEXT REFERENCES personas(id) ON DELETE SET NULL,
    policy_json           TEXT NOT NULL DEFAULT '{}',
    enabled               INTEGER NOT NULL DEFAULT 1,
    json_ext              TEXT NOT NULL DEFAULT '{}',
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO bot_profiles_new (id, display_name, model_ref, persona_id, policy_json, enabled, json_ext, created_at, updated_at)
SELECT id, display_name, model_ref, id, policy_json, enabled, json_ext, created_at, updated_at
FROM bot_profiles;

DROP TABLE bot_profiles;
ALTER TABLE bot_profiles_new RENAME TO bot_profiles;
