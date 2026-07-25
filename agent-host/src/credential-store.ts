import type {
  CredentialStore,
  Credential,
  CredentialInfo,
} from "@earendil-works/pi-ai";
import type { ChronoConfig } from "./config.ts";

/**
 * Resolve a secret_ref string to a concrete API key.
 *
 * Only plaintext tokens are supported.
 */
function resolveSecretRef(ref: string): string | undefined {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

/**
 * Parse the json_ext field of an LlmCredential row into provider env.
 * Returns undefined when empty or unparseable.
 */
function parseCredentialEnv(jsonExt: string): Record<string, string> | undefined {
  if (!jsonExt) return undefined;
  try {
    const parsed = JSON.parse(jsonExt);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") env[k] = v;
      }
      return Object.keys(env).length > 0 ? env : undefined;
    }
  } catch {
    // ignore parse failures
  }
  return undefined;
}

/**
 * Credential store backed by the ChronoSys config DB.
 *
 * Reads credentials from `llm_credentials` rows and resolves `secret_ref`
 * references (literal, `env:VAR`, `file:PATH`). Writes (`modify`, `delete`)
 * are no-ops because the config DB is managed externally — this store is
 * read-only for api-key providers.
 */
export class ChronoCredentialStore implements CredentialStore {
  constructor(private config: ChronoConfig) {}

  async read(providerId: string): Promise<Credential | undefined> {
    const row = this.config.getCredential(providerId);
    if (!row) return undefined;
    const key = resolveSecretRef(row.secret_ref);
    const env = parseCredentialEnv(row.json_ext);
    return { type: "api_key", key, env };
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const providers = this.config.listProviders();
    const result: CredentialInfo[] = [];
    for (const p of providers) {
      const row = this.config.getCredential(p.id);
      if (row) {
        result.push({ providerId: p.id, type: "api_key" });
      }
    }
    return result;
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    // Read-modify-return without persistence — our config DB is externally managed.
    // This is sufficient for api-key providers; OAuth providers that need
    // token refresh persistence would require a writable backing store.
    const current = await this.read(providerId);
    return fn(current);
  }

  async delete(_providerId: string): Promise<void> {
    // No-op: the config DB is managed externally.
  }
}
