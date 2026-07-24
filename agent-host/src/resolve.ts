import {
  builtinModels,
} from "@earendil-works/pi-ai/providers/all";
import {
  type Api,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { type ChronoConfig } from "./config.ts";
import type { LlmModel } from "./config-types.ts";
export interface ResolvedModel {
  model: Model<Api>;
  overrides: LlmModel | null;
}

export interface ResolvedBot {
  modelRef: string;
  resolvedModel: ResolvedModel;
  systemPrompt: string;
  toolsAllowlist: string[];
  skillsAllowlist: string[];
}

/**
 * Build a pi-ai `Models` instance from the config DB.
 *
 * Uses `builtinModels()` which registers all pi-ai builtin providers
 * (anthropic, openai, google, …). Custom providers with base_url need
 * `createProvider` with proper `api` mappings — deferred.
 *
 * Returns null if no enabled builtin providers exist in the config DB.
 */
export function buildModels(config: ChronoConfig): MutableModels | null {
  const providers = config.listEnabledProviders();
  if (providers.length === 0) return null;

  // builtinModels() registers all builtin providers and returns a
  // MutableModels collection with them pre-loaded.
  return builtinModels();
}

/**
 * Resolve a model_ref string ("provider_id/model_id") against the config DB
 * and pi-ai catalog.
 *
 * Throws if the provider, model allowlist row, or pi catalog model is missing.
 */
export function resolveModelRef(
  config: ChronoConfig,
  models: MutableModels,
  modelRef: string,
): ResolvedModel {
  const slash = modelRef.indexOf("/");
  if (slash === -1) {
    throw new Error(
      `invalid model_ref "${modelRef}": expected "provider_id/model_id"`,
    );
  }
  const providerId = modelRef.slice(0, slash);
  const modelId = modelRef.slice(slash + 1);

  const dbModel = config.getModel(providerId, modelId);
  if (!dbModel || dbModel.enabled === 0) {
    throw new Error(
      `model "${modelRef}" is not in the allowlist. ` +
        `Add it: INSERT INTO llm_models (provider_id, model_id, enabled) VALUES ('${providerId}', '${modelId}', 1);`,
    );
  }

  const piModel = models.getModel(providerId, modelId);
  if (!piModel) {
    throw new Error(
      `model "${modelRef}" not found in pi-ai catalog for provider "${providerId}". ` +
        `Available: ${models.getModels(providerId).map((m) => m.id).join(", ") || "none"}`,
    );
  }

  return { model: piModel, overrides: dbModel };
}

/**
 * Resolve a bot profile by id.
 *
 * Returns null if not found or disabled. Throws if the model_ref cannot be resolved.
 */
export function resolveBot(
  config: ChronoConfig,
  models: MutableModels,
  botId: string,
): ResolvedBot | null {
  const bot = config.getBot(botId);
  if (!bot || bot.enabled === 0) return null;

  const resolved = resolveModelRef(config, models, bot.model_ref);

  return {
    modelRef: bot.model_ref,
    resolvedModel: resolved,
    systemPrompt: bot.system_prompt || "",
    toolsAllowlist: parseJsonArray(bot.tools_allowlist_json),
    skillsAllowlist: parseJsonArray(bot.skills_allowlist_json),
  };
}

function parseJsonArray(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}
