import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type PluginPolicy = {
  enabled: boolean;
  config: Record<string, string | boolean>;
  tools: Record<string, { persona_blacklist: string[] }>;
};

const emptyPolicy = (): PluginPolicy => ({ enabled: false, config: {}, tools: {} });

export async function readPluginPolicy(pluginRoot: string): Promise<PluginPolicy> {
  const path = join(pluginRoot, "chrono.policy.toml");
  if (!(await Bun.file(path).exists())) return emptyPolicy();
  const parsed = Bun.TOML.parse(await Bun.file(path).text()) as Record<string, unknown>;
  const pConfig = parsed.config && typeof parsed.config === "object" ? parsed.config as Record<string, unknown> : {};
  const config: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(pConfig)) {
    if (key !== "" && (typeof value === "string" || typeof value === "boolean")) config[key] = value;
  }
  const tools = parsed.tools && typeof parsed.tools === "object" ? parsed.tools as Record<string, unknown> : {};
  const normalized: Record<string, { persona_blacklist: string[] }> = {};
  for (const [name, value] of Object.entries(tools)) {
    const blacklist = value && typeof value === "object" ? (value as Record<string, unknown>).persona_blacklist : undefined;
    normalized[name] = { persona_blacklist: Array.isArray(blacklist) ? blacklist.filter((persona): persona is string => typeof persona === "string") : [] };
  }
  return { enabled: parsed.enabled === true, config, tools: normalized };
}

export async function writePluginPolicy(pluginRoot: string, policy: PluginPolicy): Promise<void> {
  const lines = [`enabled = ${policy.enabled}`];
  const sortedConfig = Object.keys(policy.config).sort();
  if (sortedConfig.length > 0) {
    lines.push("", "[config]");
    for (const key of sortedConfig) {
      const value = policy.config[key];
      lines.push(`${key} = ${typeof value === "string" ? JSON.stringify(value) : String(value)}`);
    }
  }
  for (const name of Object.keys(policy.tools).sort()) {
    const people = policy.tools[name]?.persona_blacklist ?? [];
    lines.push("", `[tools.${JSON.stringify(name)}]`, `persona_blacklist = [${people.map((person) => JSON.stringify(person)).join(", ")}]`);
  }
  const path = join(pluginRoot, "chrono.policy.toml");
  const temp = join(pluginRoot, `.chrono.policy.${process.pid}.${Date.now()}.tmp`);
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(temp, `${lines.join("\n")}\n`, { mode: 0o600 });
  await rename(temp, path);
}
