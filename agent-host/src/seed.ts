/**
 * Seed script: create tables and optional demo data.
 *
 * Usage:  bun run src/seed.ts [db-path]
 * Default: $CHRONO_HOME/state/chrono.db  (or .chrono/state/chrono.db)
 *
 * The script is idempotent — CREATE TABLE IF NOT EXISTS.
 */

import { Database } from "bun:sqlite";

const chronoHome = process.env.CHRONO_HOME ?? ".chrono";
const dbPath = process.argv[2] || `${chronoHome}/state/chrono.db`;

console.log(`Seeding ${dbPath} …`);

const db = new Database(dbPath);
db.run("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");

db.run(`
  CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  );
  CREATE TABLE IF NOT EXISTS llm_providers (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, base_url TEXT,
    json_ext TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS llm_credentials (
    provider_id TEXT PRIMARY KEY REFERENCES llm_providers(id) ON DELETE CASCADE,
    auth_kind TEXT NOT NULL, secret_ref TEXT NOT NULL,
    json_ext TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS llm_models (
    provider_id TEXT NOT NULL REFERENCES llm_providers(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    temperature REAL,
    max_tokens INTEGER,
    top_p REAL,
    thinking_level TEXT,
    extra_body_json TEXT,
    json_ext TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (provider_id, model_id)
  );
  CREATE TABLE IF NOT EXISTS platform_accounts (
    id TEXT PRIMARY KEY, platform TEXT NOT NULL,
    adapter_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    secret_ref TEXT NOT NULL, adapter_config_json TEXT NOT NULL DEFAULT '{}',
    json_ext TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS personas (
    id TEXT PRIMARY KEY,
    system_prompt TEXT NOT NULL DEFAULT '',
    tools_allowlist_json TEXT NOT NULL DEFAULT '[]',
    skills_allowlist_json TEXT NOT NULL DEFAULT '[]',
    json_ext TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS bot_profiles (
    id TEXT PRIMARY KEY,
    persona_id TEXT REFERENCES personas(id) ON DELETE SET NULL,
    model_ref TEXT NOT NULL,
    policy_json TEXT NOT NULL DEFAULT '{}',
    json_ext TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS bindings (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
    chat_pattern TEXT NOT NULL, bot_profile_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
    session_mode TEXT NOT NULL DEFAULT 'shared', priority INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    json_ext TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(account_id, chat_pattern, bot_profile_id)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── Example seed data (replace with your own providers/models) ──

const providerId = process.env.CHRONO_SEED_PROVIDER ?? "my-llm";
const modelId = process.env.CHRONO_SEED_MODEL ?? "main-model";
const credentialEnv = process.env.CHRONO_SEED_CREDENTIAL_ENV ?? "MY_LLM_API_KEY";

db.run(
  `INSERT OR IGNORE INTO llm_providers (id, kind)
   VALUES (?, 'builtin')`,
  [providerId],
);

db.run(
  `INSERT OR REPLACE INTO llm_credentials (provider_id, auth_kind, secret_ref)
   VALUES (?, 'env_ref', ?)`,
  [providerId, credentialEnv],
);
db.run(
  `INSERT OR REPLACE INTO personas (id, system_prompt,
          tools_allowlist_json)
   VALUES ('greeter',
           'You are a helpful assistant. When asked to send a message, use message_send.',
           '["message_send"]')`,
);

db.run(
  `INSERT OR REPLACE INTO bot_profiles (id, persona_id, model_ref)
   VALUES ('greeter', 'greeter', ?)`,
  [`${providerId}/${modelId}`],
);

console.log(`Seeded ${dbPath}`);
console.log(`  llm_providers: ${providerId} (builtin)`);
console.log(`  llm_models:    ${providerId}/${modelId} (temp=0.7)`);
console.log(`  bot_profiles:  greeter → ${providerId}/${modelId}`);
console.log(`\nCustomize: CHRONO_SEED_PROVIDER CHRONO_SEED_MODEL CHRONO_SEED_CREDENTIAL_ENV`);
