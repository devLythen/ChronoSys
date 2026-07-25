import { Database } from "bun:sqlite";
import type {
  LlmProvider,
  LlmCredential,
  LlmModel,
  PlatformAccount,
  BotProfile,
  Persona,
  Binding,
} from "./config-types.ts";

/**
 * Open the Chrono config DB.
 * All query methods return plain objects matching config-types.
 */
export function openConfig(path: string): ChronoConfig {
  const db = new Database(path);
  db.run("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  return new ChronoConfig(db);
}

export class ChronoConfig {
  constructor(private db: Database) {}

  close() {
    this.db.close();
  }

  // ── Providers ──────────────────────────────────────────────────

  getProvider(id: string): LlmProvider | null {
    const row = this.db
      .query(
        `SELECT id, kind, base_url, display_name, json_ext, created_at, updated_at
         FROM llm_providers WHERE id = ?`,
      )
      .get(id);
    return row as LlmProvider | null;
  }

  listProviders(): LlmProvider[] {
    return this.db
      .query(
        `SELECT id, kind, base_url, display_name, json_ext, created_at, updated_at
         FROM llm_providers ORDER BY id`,
      )
      .all() as LlmProvider[];
  }

  getCredential(providerId: string): LlmCredential | null {
    const row = this.db
      .query(
        `SELECT provider_id, auth_kind, secret_ref, json_ext, updated_at
         FROM llm_credentials WHERE provider_id = ?`,
      )
      .get(providerId);
    return row as LlmCredential | null;
  }

  // ── Models ─────────────────────────────────────────────────────

  getModel(providerId: string, modelId: string): LlmModel | null {
    const row = this.db
      .query(
        `SELECT provider_id, model_id, temperature, max_tokens, top_p,
                thinking_level, extra_body_json, json_ext,
                created_at, updated_at
         FROM llm_models WHERE provider_id = ? AND model_id = ?`,
      )
      .get(providerId, modelId);
    return row as LlmModel | null;
  }

  listModels(providerId: string): LlmModel[] {
    return this.db
      .query(
        `SELECT provider_id, model_id, temperature, max_tokens, top_p,
                thinking_level, extra_body_json, json_ext,
                created_at, updated_at
         FROM llm_models WHERE provider_id = ? ORDER BY model_id`,
      )
      .all(providerId) as LlmModel[];
  }

  // ── Accounts ───────────────────────────────────────────────────

  getAccount(id: string): PlatformAccount | null {
    const row = this.db
      .query(
        `SELECT id, platform, display_name, adapter_id, enabled, secret_ref,
                adapter_config_json, json_ext, created_at, updated_at
         FROM platform_accounts WHERE id = ?`,
      )
      .get(id);
    return row as PlatformAccount | null;
  }

  listEnabledAccounts(): PlatformAccount[] {
    return this.db
      .query(
        `SELECT id, platform, display_name, adapter_id, enabled, secret_ref,
                adapter_config_json, json_ext, created_at, updated_at
         FROM platform_accounts WHERE enabled = 1 ORDER BY id`,
      )
      .all() as PlatformAccount[];
  }

  // ── Bots ───────────────────────────────────────────────────────

  getBot(id: string): BotProfile | null {
    const row = this.db
      .query(
        `SELECT id, display_name, persona_id, model_ref,
                policy_json, json_ext, created_at, updated_at
         FROM bot_profiles WHERE id = ?`,
      )
      .get(id);
    return row as BotProfile | null;
  }

  listBots(): BotProfile[] {
    return this.db
      .query(
        `SELECT id, display_name, persona_id, model_ref,
                policy_json, json_ext, created_at, updated_at
         FROM bot_profiles ORDER BY id`,
      )
      .all() as BotProfile[];
  }

  // ── Personas ────────────────────────────────────────────────────

  getPersona(id: string): Persona | null {
    const row = this.db
      .query(
        `SELECT id, display_name, system_prompt, tools_allowlist_json,
                skills_allowlist_json, json_ext, created_at, updated_at
         FROM personas WHERE id = ?`,
      )
      .get(id);
    return row as Persona | null;
  }

  // ── Bindings ───────────────────────────────────────────────────

  getBinding(id: string): Binding | null {
    const row = this.db
      .query(
        `SELECT id, account_id, chat_pattern, bot_profile_id, session_mode, priority,
                enabled, json_ext, created_at, updated_at
         FROM bindings WHERE id = ?`,
      )
      .get(id);
    return row as Binding | null;
  }

  listBindingsForAccount(accountId: string): Binding[] {
    return this.db
      .query(
        `SELECT id, account_id, chat_pattern, bot_profile_id, session_mode, priority,
                enabled, json_ext, created_at, updated_at
         FROM bindings WHERE account_id = ? AND enabled = 1 ORDER BY priority DESC`,
      )
      .all(accountId) as Binding[];
  }
}
