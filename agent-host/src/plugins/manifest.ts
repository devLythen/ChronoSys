import { realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { NativePluginManifest } from "./types.ts";

const ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const TOOL_RE = /^[a-z][a-z0-9_.-]{0,63}$/;

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}
function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new Error(`${field} must be a string array`);
  const result = value as string[];
  if (new Set(result).size !== result.length) throw new Error(`${field} must not contain duplicates`);
  return result;
}

export async function loadNativeManifest(pluginRoot: string): Promise<NativePluginManifest> {
  const rootPath = await realpath(pluginRoot);
  const manifestPath = resolve(rootPath, "chrono.plugin.toml");
  const parsed = Bun.TOML.parse(await Bun.file(manifestPath).text()) as Record<string, unknown>;
  const id = asString(parsed.id, "id");
  const name = asString(parsed.name, "name");
  const version = asString(parsed.version, "version");
  const chronoApi = parsed.chrono_api;
  const description = asString(parsed.description, "description");
  if (!ID_RE.test(id)) throw new Error("id has invalid format");
  if (!VERSION_RE.test(version)) throw new Error("version must be SemVer major.minor.patch");
  if (chronoApi !== "1") throw new Error("chrono_api must be \"1\"");
  const entry = parsed.entry;
  if (!entry || typeof entry !== "object") throw new Error("entry must be a table");
  const entryTable = entry as Record<string, unknown>;
  const entryTools = asStringArray(entryTable.tools, "entry.tools");
  const entryCommands = entryTable.commands === undefined ? [] : asStringArray(entryTable.commands, "entry.commands");
  if (entryTools.length === 0 && entryCommands.length === 0) throw new Error("entry.tools or entry.commands must not be empty");
  const entryPaths = async (entries: string[]) => {
    const paths: string[] = [];
    for (const entryPath of entries) {
      const resolvedEntry = await realpath(resolve(rootPath, entryPath));
      const rel = relative(rootPath, resolvedEntry);
      if (rel === ".." || rel.startsWith("../")) throw new Error(`entry path escapes plugin root: ${entryPath}`);
      paths.push(resolvedEntry);
    }
    return paths;
  };
  const configEntries = Array.isArray(parsed.config) ? parsed.config as Record<string, unknown>[] : [];
  const configSchema = configEntries.map((entry, index) => {
    const key = asString(entry.key, `config[${index}].key`);
    const label = asString(entry.label, `config[${index}].label`);
    const type = entry.type;
    if (type !== "string" && type !== "boolean") throw new Error(`config[${index}].type must be "string" or "boolean"`);
    if (entry.default !== undefined && typeof entry.default !== type) throw new Error(`config[${index}].default must be a ${type}`);
    const description = entry.description && typeof entry.description === "string" ? entry.description : undefined;
    return { key, label, type: type as "string" | "boolean", default: entry.default as string | boolean, ...(description ? { description } : {}) };
  });
  const toolEntries = Array.isArray(parsed.tools) ? parsed.tools as Record<string, unknown>[] : [];
  const toolMeta = toolEntries.map((entry, index) => ({
    name: asString(entry.name, `tools[${index}].name`),
    label: asString(entry.label, `tools[${index}].label`),
    description: asString(entry.description, `tools[${index}].description`),
  }));
  const commandEntries = Array.isArray(parsed.commands) ? parsed.commands as Record<string, unknown>[] : [];
  const commandMeta = commandEntries.map((entry, index) => ({
    name: asString(entry.name, `commands[${index}].name`),
    label: asString(entry.label, `commands[${index}].label`),
    description: asString(entry.description, `commands[${index}].description`),
  }));
  return { id, name, version, chronoApi, description, entryTools: await entryPaths(entryTools), entryCommands: await entryPaths(entryCommands), toolMeta, commandMeta, configSchema, rootPath, manifestPath };
}

export function pluginInstallRoot(chronoHome: string): string {
  return join(chronoHome, "plugins", "installed");
}
export { ID_RE, VERSION_RE, TOOL_RE };
