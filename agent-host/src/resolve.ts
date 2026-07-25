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
import { ChronoCredentialStore } from "./credential-store.ts";
export interface ResolvedModel {
  model: Model<Api>;
  overrides: LlmModel | null;
}

export interface ResolvedBot {
  id: string;
  modelRef: string;
  resolvedModel: ResolvedModel;
  systemPrompt: string;
  toolsAllowlist: string[];
  skillsAllowlist: string[];
  /** Parsed bot_profiles.policy_json */
  policy: Record<string, unknown>;
}

/**
 * Build a pi-ai `Models` instance from the config DB.
 *
 * Uses `builtinModels()` which registers all pi-ai builtin providers
 * (anthropic, openai, google, …). Custom providers with base_url need
 * `createProvider` with proper `api` mappings — deferred.
 *
 * Returns null if no providers exist in the config DB.
 */
export function buildModels(config: ChronoConfig): MutableModels | null {
  const providers = config.listProviders();
  if (providers.length === 0) return null;

  // builtinModels() registers all builtin providers and returns a
  // MutableModels collection with them pre-loaded, using credentials
  // from the config DB for auth resolution.
  return builtinModels({ credentials: new ChronoCredentialStore(config) });
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
  if (!dbModel) {
    throw new Error(
      `model "${modelRef}" is not in the allowlist. ` +
        `Add it via the Providers page in the web UI.`,
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
 * Returns null if not found. Throws if the model_ref cannot be resolved.
 */
export function resolveBot(
  config: ChronoConfig,
  models: MutableModels,
  botId: string,
): ResolvedBot | null {
  const bot = config.getBot(botId);
  if (!bot) return null;

  const resolved = resolveModelRef(config, models, bot.model_ref);

  const persona = bot.persona_id ? config.getPersona(bot.persona_id) : null;

  return {
    id: bot.id,
    modelRef: bot.model_ref,
    resolvedModel: resolved,
    systemPrompt: persona?.system_prompt || "",
    toolsAllowlist: persona ? parseJsonArray(persona.tools_allowlist_json) : ["message_send"],
    skillsAllowlist: persona ? parseJsonArray(persona.skills_allowlist_json) : [],
    policy: parseJsonObject(bot.policy_json),
  };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
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
