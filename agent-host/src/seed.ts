#!/usr/bin/env bun
/**
 * Seed the Chrono config database with example data.
 *
 * Usage: bun run src/seed.ts [chrono_home]
 *   Default chrono_home: .chrono
 *
 * Creates state/chrono.db with one builtin provider, one model, one bot.
 * Real API key must be in env (the provider's env var) or CHRONO_FAKE_LLM=1.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

const home = process.argv[2] ?? ".chrono";
const dbPath = `${home}/state/chrono.db`;

mkdirSync(`${home}/state`, { recursive: true });

const db = new Database(dbPath);
db.run("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");

// Schema (same as migration 001)
db.run(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS llm_providers (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, base_url TEXT,
    display_name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
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
    model_id TEXT NOT NULL, display_name TEXT, enabled INTEGER NOT NULL DEFAULT 1,
    temperature REAL, max_tokens INTEGER, top_p REAL,
    extra_headers_json TEXT, extra_body_json TEXT, thinking_level TEXT,
    json_ext TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (provider_id, model_id)
  );
  CREATE TABLE IF NOT EXISTS platform_accounts (
    id TEXT PRIMARY KEY, platform TEXT NOT NULL, display_name TEXT NOT NULL,
    adapter_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    secret_ref TEXT NOT NULL, adapter_config_json TEXT NOT NULL DEFAULT '{}',
    json_ext TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS bot_profiles (
    id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
    system_prompt TEXT NOT NULL DEFAULT '',
    model_ref TEXT NOT NULL,
    tools_allowlist_json TEXT NOT NULL DEFAULT '[]',
    skills_allowlist_json TEXT NOT NULL DEFAULT '[]',
    policy_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
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
  `INSERT OR IGNORE INTO llm_providers (id, kind, display_name, enabled)
   VALUES (?, 'builtin', ?, 1)`,
  [providerId, providerId],
);

db.run(
  `INSERT OR REPLACE INTO llm_credentials (provider_id, auth_kind, secret_ref)
   VALUES (?, 'env_ref', ?)`,
  [providerId, credentialEnv],
);

db.run(
  `INSERT OR REPLACE INTO llm_models (provider_id, model_id, display_name, enabled, temperature)
   VALUES (?, ?, ?, 1, 0.7)`,
  [providerId, modelId, modelId],
);

db.run(
  `INSERT OR REPLACE INTO bot_profiles (id, display_name, system_prompt, model_ref,
          tools_allowlist_json, enabled)
   VALUES ('greeter', 'Greeter',
           'You are a helpful assistant. When asked to send a message, use message.send.',
           ?, '["message.send"]', 1)`,
  [`${providerId}/${modelId}`],
);

console.log(`Seeded ${dbPath}`);
console.log(`  llm_providers: ${providerId} (builtin)`);
console.log(`  llm_models:    ${providerId}/${modelId} (temp=0.7)`);
console.log(`  bot_profiles:  greeter → ${providerId}/${modelId}`);
console.log(`\nCustomize: CHRONO_SEED_PROVIDER CHRONO_SEED_MODEL CHRONO_SEED_CREDENTIAL_ENV`);

db.close();
