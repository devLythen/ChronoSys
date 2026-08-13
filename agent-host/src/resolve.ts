import {
  getSupportedThinkingLevels,
  clampThinkingLevel,
  createModels,
  createProvider,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel, ModelThinkingLevel } from "@earendil-works/pi-ai";

import {
  builtinModels,
  builtinProviders,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
  type Api,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { type ChronoConfig } from "./config.ts";
import type { LlmModel, LlmProvider } from "./config-types.ts";
import { ChronoCredentialStore } from "./credential-store.ts";
export interface ResolvedModel {
  model: Model<Api>;
  overrides: LlmModel | null;
}

export interface ResolvedBot {
  id: string;
  personaId: string | null;
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
 * Starts from `createModels` and registers every builtin pi-ai provider
 * (anthropic, openai, google, …), then registers custom providers (ids
 * absent from the builtin catalog, e.g. OpenAI-compatible proxies) with
 * connection params from the DB and model capabilities inherited by model
 * name.
 *
 * Returns null if no providers exist in the config DB.
 */
export function buildModels(config: ChronoConfig): MutableModels | null {
  const providers = config.listProviders();
  if (providers.length === 0) return null;

  const models = createModels({ credentials: new ChronoCredentialStore(config) });
  for (const p of builtinProviders()) {
    models.setProvider(p);
  }

  for (const prov of providers) {
    if (models.getProvider(prov.id)) continue;
    const custom = buildCustomProvider(prov, config);
    if (custom) {
      models.setProvider(custom);
      process.stderr.write(
        `\x1b[36m[agent] custom provider ${prov.id}: registered ${custom.getModels().length} model(s) by name from pi catalog\x1b[0m\n`,
      );
    } else {
      logUnregistered(prov.id);
    }
  }
  return models;
}

function logUnregistered(providerId: string): void {
  // Avoid import cycle with main.ts; stderr must stay frame-free.
  process.stderr.write(
    `\x1b[33m[agent] custom provider ${providerId}: no models inherited from pi catalog; not registered\x1b[0m\n`,
  );
}

/** Module-level builtin catalog for capability lookup (no auth needed). */
let builtinCache: MutableModels | null = null;
function builtin(): MutableModels {
  return (builtinCache ??= builtinModels());
}

/**
 * Find a model by name across every builtin provider catalog.
 * Capabilities belong to the model, not to the provider slot: a custom
 * provider id must not block recognition when the model name is known.
 */
function findBuiltinModelByName(modelId: string): Model<Api> | undefined {
  for (const pid of getBuiltinProviders()) {
    const m = builtin().getModel(pid, modelId);
    if (m) return m;
  }
  return undefined;
}

/**
 * Register an OpenAI-compatible custom provider: DB connection params
 * (base URL, api-key auth through the shared credential store) plus one
 * runtime model per allowlisted DB row.
 *
 * A model whose name matches a builtin catalog entry inherits that entry's
 * capabilities (context window, reasoning, cost, thinking levels). An
 * unknown name still registers with conservative defaults so the operator
 * can use it by configuring parameters manually (temperature, max_tokens,
 * etc.) — "not in the catalog" does not mean unusable.
 *
 * Only capability data is inherited; connection settings (baseUrl, key,
 * headers) always come from this provider's own DB rows.
 *
 * Returns null when the provider has no base_url, an unsupported kind, or
 * no allowlisted models.
 */
function buildCustomProvider(
  prov: LlmProvider,
  config: ChronoConfig,
): Provider | null {
  const baseUrl = prov.base_url;
  if (!baseUrl) {
    process.stderr.write(
      `\x1b[33m[agent] custom provider ${prov.id}: no base_url configured; not registered\x1b[0m\n`,
    );
    return null;
  }
  // Protocol from the provider kind. Only the two explicit OpenAI kinds are
  // supported — unknown/legacy kinds are rejected rather than silently
  // defaulting (pre-v1 breaking-change phase).
  const api: Api | null =
    prov.kind === "openai-responses" ? "openai-responses"
      : prov.kind === "openai-completions" ? "openai-completions"
        : null;
  if (api === null) {
    process.stderr.write(
      `\x1b[33m[agent] custom provider ${prov.id}: unsupported kind "${prov.kind}"; not registered\x1b[0m\n`,
    );
    return null;
  }
  const streams = api === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi();

  const dbModels = config.listModels(prov.id);
  const runtimeModels: Model<Api>[] = [];
  for (const db of dbModels) {
    const found = findBuiltinModelByName(db.model_id);
    if (found) {
      // Strip connection + protocol fields from the clone: capabilities are
      // shared by name, but baseUrl and api belong to this provider's config.
      const { baseUrl: _baseUrl, api: _api, ...capabilityProfile } = found;
      runtimeModels.push({ ...capabilityProfile, provider: prov.id, baseUrl, api });
    } else {
      runtimeModels.push(buildFallbackModel(db, prov.id, baseUrl, api));
    }
  }
  if (runtimeModels.length === 0) return null;

  return createProvider({
    id: prov.id,
    name: prov.id,
    baseUrl,
    auth: {
      apiKey: {
        name: `${prov.id} API key`,
        resolve: async ({ credential }) =>
          credential?.key
            ? {
                auth: { apiKey: credential.key, baseUrl },
                source: "chrono.db",
              }
            : undefined,
      },
    },
    models: runtimeModels,
    api: streams,
  });
}

/** Conservative defaults for a model absent from the pi catalog. The
 *  operator can still use it by configuring parameters (max_tokens,
 *  temperature, …) in the DB; these defaults cover the fields pi needs but
 *  the DB does not store (context window, cost, reasoning). */
const UNKNOWN_MODEL_CONTEXT_WINDOW = 128000;
const UNKNOWN_MODEL_MAX_TOKENS = 8192;

function buildFallbackModel(
  db: LlmModel,
  providerId: string,
  baseUrl: string,
  api: Api,
): Model<Api> {
  return {
    id: db.model_id,
    name: db.model_id,
    api,
    provider: providerId,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: UNKNOWN_MODEL_CONTEXT_WINDOW,
    maxTokens: db.max_tokens ?? UNKNOWN_MODEL_MAX_TOKENS,
  };
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
      `model "${modelRef}" not found in pi-ai catalog for provider "${providerId}".`,
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
    personaId: bot.persona_id,
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
 *
 * Lookup is exact by provider + model first, then falls back to a name-wide
 * search across every builtin provider: capabilities belong to the model,
 * not to the provider slot, so a custom provider id must not hide a known
 * model name.
 *
 * Returns null when the model name is unknown to the catalog.
 */
export function queryModelCaps(
  providerId: string,
  modelId: string,
): ModelCaps | null {
  const models = builtin();
  let model = models.getModel(providerId, modelId);
  if (!model) {
    for (const pid of getBuiltinProviders()) {
      const m = models.getModel(pid, modelId);
      if (m) {
        model = m;
        break;
      }
    }
  }
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
