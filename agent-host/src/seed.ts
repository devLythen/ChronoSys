/**
 * Seed script: apply the canonical SQL migrations and insert demo data.
 *
 * Usage:  bun run src/seed.ts [db-path]
 * Default: $CHRONO_HOME/state/chrono.db  (or .chrono/state/chrono.db)
 *
 * Migrations are read from crates/chrono-config/src/migrations/ and tracked in
 * `schema_migrations`, matching the Rust ConfigStore. The script is idempotent
 * and safe to run against an already-migrated DB.
 *
 * Demo rows use the current provider contract: an OpenAI-compatible custom
 * provider with a plaintext API key and an allowlisted model. Override with
 * CHRONO_SEED_PROVIDER / CHRONO_SEED_MODEL / CHRONO_SEED_BASE_URL /
 * CHRONO_SEED_API_KEY.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const chronoHome = process.env.CHRONO_HOME ?? ".chrono";
const dbPath = process.argv[2] || `${chronoHome}/state/chrono.db`;
const migrationsDir = resolve(
  import.meta.dir,
  "../../crates/chrono-config/src/migrations",
);

console.log(`Seeding ${dbPath} …`);
mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.run("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");

// ── Apply canonical migrations ─────────────────────────────────
db.run(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
    name       TEXT NOT NULL
  );
`);

const files = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

for (const file of files) {
  const version = Number.parseInt(file.slice(0, 3), 10);
  if (!Number.isInteger(version)) {
    throw new Error(`invalid migration filename: ${file}`);
  }
  const applied = db
    .query("SELECT 1 FROM schema_migrations WHERE version = ?")
    .get(version);
  if (applied) continue;

  const sql = readFileSync(resolve(migrationsDir, file), "utf8");
  db.exec(sql);
  db.run(
    "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
    [version, file.replace(/\.sql$/, "")],
  );
  console.log(`  applied ${file}`);
}

// ── Demo data (current provider contract) ──────────────────────
const providerId = process.env.CHRONO_SEED_PROVIDER ?? "my-llm";
const modelId = process.env.CHRONO_SEED_MODEL ?? "gpt-4o-mini";
const baseUrl = process.env.CHRONO_SEED_BASE_URL ?? "https://api.openai.com/v1";
const apiKey = process.env.CHRONO_SEED_API_KEY ?? "REPLACE_WITH_API_KEY";

db.run(
  `INSERT INTO llm_providers (id, kind, base_url)
   VALUES (?, 'openai-completions', ?)
   ON CONFLICT(id) DO UPDATE SET
     kind = excluded.kind,
     base_url = excluded.base_url,
     updated_at = datetime('now')`,
  [providerId, baseUrl],
);

db.run(
  `INSERT INTO llm_credentials (provider_id, auth_kind, secret_ref)
   VALUES (?, 'api_key', ?)
   ON CONFLICT(provider_id) DO UPDATE SET
     auth_kind = excluded.auth_kind,
     secret_ref = excluded.secret_ref,
     updated_at = datetime('now')`,
  [providerId, apiKey],
);

db.run(
  `INSERT INTO llm_models (provider_id, model_id, temperature)
   VALUES (?, ?, 0.7)
   ON CONFLICT(provider_id, model_id) DO UPDATE SET
     temperature = excluded.temperature,
     updated_at = datetime('now')`,
  [providerId, modelId],
);

db.run(
  `INSERT INTO personas (id, system_prompt, tools_allowlist_json)
   VALUES ('greeter',
           'You are a helpful assistant. When asked to send a message, use message_send.',
           '["message_send","get_time"]')
   ON CONFLICT(id) DO UPDATE SET
     system_prompt = excluded.system_prompt,
     tools_allowlist_json = excluded.tools_allowlist_json,
     updated_at = datetime('now')`,
);

db.run(
  `INSERT INTO bot_profiles (id, persona_id, model_ref)
   VALUES ('greeter', 'greeter', ?)
   ON CONFLICT(id) DO UPDATE SET
     persona_id = excluded.persona_id,
     model_ref = excluded.model_ref,
     updated_at = datetime('now')`,
  [`${providerId}/${modelId}`],
);

console.log(`Seeded ${dbPath}`);
console.log(`  llm_providers: ${providerId} (openai-completions, ${baseUrl})`);
console.log(`  llm_models:    ${providerId}/${modelId} (temperature 0.7)`);
console.log(`  bot_profiles:  greeter → ${providerId}/${modelId}`);
if (apiKey === "REPLACE_WITH_API_KEY") {
  console.warn("  warning: placeholder API key stored — set CHRONO_SEED_API_KEY before chatting");
}
console.log(
  "\nCustomize: CHRONO_SEED_PROVIDER CHRONO_SEED_MODEL CHRONO_SEED_BASE_URL CHRONO_SEED_API_KEY",
);
