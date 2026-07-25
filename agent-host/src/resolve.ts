import {
  getSupportedThinkingLevels,
  clampThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel, ModelThinkingLevel } from "@earendil-works/pi-ai";

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

// ── Model capabilities query ──────────────────────────────────────

/** Full model capabilities returned to the Rust gateway / WebUI. */
export interface ModelCaps {
  name: string;
  provider: string;
  api: string;
  reasoning: boolean;
  thinkingLevels: string[];
  thinkingLevelMap: Record<string, string | null>;
  maxTokens: number;
  contextWindow: number;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/**
 * Query pi-ai builtin model catalog for a specific model's capabilities.
 * Returns null when the provider or model is not in the builtin catalog.
 */
export function queryModelCaps(
  providerId: string,
  modelId: string,
): ModelCaps | null {
  const models = builtinModels();
  const model = models.getModel(providerId, modelId);
  if (!model) return null;
  return {
    name: model.name,
    provider: model.provider,
    api: model.api,
    reasoning: model.reasoning,
    thinkingLevels: getSupportedThinkingLevels(model),
    thinkingLevelMap: model.thinkingLevelMap ?? {},
    maxTokens: model.maxTokens,
    contextWindow: model.contextWindow,
    input: [...model.input],
    cost: { ...model.cost },
  };
}

// ── Override application ──────────────────────────────────────────

/**
 * Validate and clamp a thinking_level string against what the model supports.
 * Returns the clamped thinking level, or null if overrides is null.
 */
export function resolveThinkingLevel(
  model: Model<Api>,
  overrides: LlmModel | null,
): ModelThinkingLevel {
  if (!overrides?.thinking_level) return "off";
  const clamped = clampThinkingLevel(
    model,
    overrides.thinking_level as ModelThinkingLevel,
  );
  return clamped;
}

/**
 * Build stream-option overrides from DB model config.
 * Returns fields that should be merged into stream options.
 */
export function buildStreamOverrides(
  overrides: LlmModel | null,
): Partial<{ temperature: number; maxTokens: number; topP: number }> {
  if (!overrides) return {};
  const result: Record<string, number> = {};
  if (overrides.temperature != null) result.temperature = overrides.temperature;
  if (overrides.max_tokens != null) result.maxTokens = overrides.max_tokens;
  if (overrides.top_p != null) result.topP = overrides.top_p;
  return result;
}
