import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openConfig, type ChronoConfig } from "./config.ts";
import { buildModels, queryModelCaps } from "./resolve.ts";

// ── model caps: name-wide fallback ────────────────────────────────

test("caps are found by model name even when the provider id is unknown", () => {
  // "opkg-lite" is a custom (proxy) provider id; "deepseek-v4-flash" is a
  // known builtin model. Capability lookup must not be blocked by the slot.
  const caps = queryModelCaps("opkg-lite", "deepseek-v4-flash");
  expect(caps).not.toBeNull();
  expect(caps!.name).toBeTruthy();
  expect(caps!.contextWindow).toBeGreaterThan(0);
  expect(caps!.maxTokens).toBeGreaterThan(0);
});

test("exact provider+model lookup still wins", () => {
  const exact = queryModelCaps("deepseek", "deepseek-v4-flash");
  expect(exact).not.toBeNull();
  expect(exact!.provider).toBe("deepseek");
});

test("unknown model names return null", () => {
  expect(queryModelCaps("opkg-lite", "definitely-not-a-real-model-xyz")).toBeNull();
  expect(queryModelCaps("nope", "nope")).toBeNull();
});

// ── buildModels: custom provider registration ─────────────────────

function makeConfig(): { config: ChronoConfig; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "chrono-resolve-"));
  const dbPath = join(dir, "test.db");
  const db = new Database(dbPath);
  db.run(`
    CREATE TABLE llm_providers (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, base_url TEXT,
      json_ext TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
    )
  `);
  db.run(`
    CREATE TABLE llm_credentials (
      provider_id TEXT PRIMARY KEY, auth_kind TEXT NOT NULL, secret_ref TEXT NOT NULL,
      json_ext TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT ''
    )
  `);
  db.run(`
    CREATE TABLE llm_models (
      provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
      temperature REAL, max_tokens INTEGER, top_p REAL, thinking_level TEXT,
      extra_body_json TEXT, json_ext TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (provider_id, model_id)
    )
  `);
  db.close();
  const config = openConfig(dbPath);
  return {
    config,
    cleanup: () => {
      config.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("custom provider is registered with capabilities inherited by name", () => {
  const { config, cleanup } = makeConfig();
  try {
    configDbInsert(config, "opkg-lite", "https://proxy.example/v1", "sk-test", [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
    const models = buildModels(config);
    expect(models).not.toBeNull();
    for (const modelId of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
      const m = models!.getModel("opkg-lite", modelId);
      expect(m, `model ${modelId} should be registered`).toBeDefined();
      expect(m!.provider).toBe("opkg-lite");
      expect(m!.contextWindow).toBeGreaterThan(0);
      // Connection fields are this provider's own — never cloned from the
      // builtin twin (which would point at the original vendor endpoint).
      expect(m!.baseUrl).toBe("https://proxy.example/v1");
      expect(m!.baseUrl).not.toContain("deepseek.com");
    }
  } finally {
    cleanup();
  }
});

test("custom provider with no known model names is not registered", () => {
  const { config, cleanup } = makeConfig();
  try {
    configDbInsert(config, "mystery", null, "sk-test", ["no-such-model-xyz"]);
    const models = buildModels(config);
    expect(models).not.toBeNull();
    expect(models!.getProvider("mystery")).toBeUndefined();
    expect(models!.getModel("mystery", "no-such-model-xyz")).toBeUndefined();
  } finally {
    cleanup();
  }
});

test("custom provider with an unsupported kind is not registered", () => {
  const { config, cleanup } = makeConfig();
  try {
    configDbInsert(config, "legacy", "https://proxy.example/v1", "sk-test", ["deepseek-v4-flash"]);
    // Simulate a pre-split kind value: it must be rejected, not defaulted.
    const db = (config as unknown as { db: Database }).db;
    db.run("UPDATE llm_providers SET kind='openai' WHERE id='legacy'");
    const models = buildModels(config);
    expect(models).not.toBeNull();
    expect(models!.getProvider("legacy")).toBeUndefined();
  } finally {
    cleanup();
  }
});

// Insert rows via the public config API (queries match production schema).
function configDbInsert(
  config: ChronoConfig,
  providerId: string,
  baseUrl: string | null,
  key: string,
  modelIds: string[],
): void {
  // ConfigStore is read-only by design; write through bun:sqlite directly.
  const db = (config as unknown as { db: Database }).db;
  db.run(
    "INSERT INTO llm_providers (id, kind, base_url) VALUES (?, 'openai-completions', ?)",
    [providerId, baseUrl],
  );
  db.run(
    "INSERT INTO llm_credentials (provider_id, auth_kind, secret_ref) VALUES (?, 'api_key', ?)",
    [providerId, key],
  );
  for (const modelId of modelIds) {
    db.run("INSERT INTO llm_models (provider_id, model_id) VALUES (?, ?)", [
      providerId,
      modelId,
    ]);
  }
}
