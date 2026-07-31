import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { createMessageSendTool, type PendingCall } from "../tools.ts";
import { readPluginPolicy, writePluginPolicy } from "./policy.ts";
import { loadNativeManifest, pluginInstallRoot, TOOL_RE } from "./manifest.ts";
import { createPluginApi } from "./sdk.ts";
import type { ChronoNativeCommandDefinition, ChronoNativeToolDefinition, NativePluginManifest, NativePluginRecord, NativePluginView } from "./types.ts";

const BUILTIN_TOOLS = ["message_send"] as const;

type Candidate = { root: string; manifest?: NativePluginManifest; error?: string };

function details(pluginId: string, toolName: string, outcome: string, error?: string) {
  return { plugin_id: pluginId, tool_name: toolName, outcome, ...(error ? { error } : {}) };
}

export class ToolRegistry {
  private snapshot = new Map<string, NativePluginRecord>();
  private readonly chronoHome: string;

  constructor(chronoHome: string, private readonly warn: (message: string) => void = (message) => process.stderr.write(`\x1b[33m[agent]\x1b[0m ${message}\n`)) {
    this.chronoHome = chronoHome;
  }

  async reload(): Promise<void> { this.snapshot = await this.discover(); }

  list(): NativePluginView[] {
    return [...this.snapshot.values()].map(({ manifest: _manifest, toolDefinitions: _toolDefinitions, commandDefinitions: _commandDefinitions, ...view }) => view);
  }

  async reconcilePersonas(personaIds: ReadonlySet<string>): Promise<void> {
    for (const record of this.snapshot.values()) {
      if (!record.manifest) continue;
      const tools = Object.fromEntries(Object.entries(record.policy.tools).map(([name, value]) => [name, { persona_blacklist: value.persona_blacklist.filter((id) => personaIds.has(id)) }]));
      if (JSON.stringify(tools) !== JSON.stringify(record.policy.tools)) {
        record.policy = { ...record.policy, tools };
        await writePluginPolicy(record.manifest.rootPath, record.policy);
      }
    }
  }

  get(id: string): NativePluginRecord | undefined { return this.snapshot.get(id); }

  async updatePolicy(id: string, raw: { enabled: boolean; config: Record<string, unknown>; tools: Record<string, { persona_blacklist: string[] }> }): Promise<NativePluginView> {
    const record = this.snapshot.get(id);
    if (!record?.manifest) throw new Error("plugin not found");
    const known = new Set([...record.tools.map((t) => t.name), ...record.commands.map((c) => c.name)]);
    if (!raw.tools || typeof raw.tools !== "object") throw new Error("policy tools is required");
    // Lax: tools may reference defunct entries that get pruned on next reload; only gate unknown names at discovery time.
    const configSrc = raw.config && typeof raw.config === "object" ? raw.config : {};
    const config: Record<string, string | boolean> = {};
    for (const [key, value] of Object.entries(configSrc)) { if (typeof value === "string" || typeof value === "boolean") config[key] = value; }
    await writePluginPolicy(record.manifest.rootPath, { enabled: raw.enabled, config, tools: raw.tools as Record<string, { persona_blacklist: string[] }> });
    await this.reload();
    const updated = this.snapshot.get(id);
    if (!updated) throw new Error("plugin disappeared after reload");
    const { manifest: _manifest, toolDefinitions: _toolDefinitions, commandDefinitions: _commandDefinitions, ...view } = updated;
    return view;
  }

  createToolsForAllowlist(allowlist: string[], sessionKey: string, pendingCalls: Map<string, PendingCall>, signal?: AbortSignal, personaId?: string): AgentTool[] {
    const eligible = new Map<string, AgentTool>();
    eligible.set("message_send", createMessageSendTool(sessionKey, pendingCalls, signal));
    for (const record of this.snapshot.values()) {
      for (const def of record.toolDefinitions) {
        const blacklist = record.policy.tools[def.name]?.persona_blacklist ?? [];
        if (record.policy.enabled && !blacklist.includes(personaId ?? "") && record.tools.some((t) => t.name === def.name && t.enabled)) {
          eligible.set(def.name, this.wrap(def, record, sessionKey, pendingCalls, signal));
        }
      }
    }
    const names = allowlist.length === 0 ? [...eligible.keys()] : allowlist;
    const unknown = names.filter((name) => !eligible.has(name));
    if (unknown.length > 0) this.warn(`unknown tool names: ${unknown.join(", ")}`);
    return names.flatMap((name) => { const tool = eligible.get(name); return tool ? [tool] : []; });
  }

  async executeCommand(text: string, sessionKey: string, pendingCalls: Map<string, PendingCall>, signal?: AbortSignal): Promise<boolean> {
    const match = text.trim().match(/^\/([a-z][a-z0-9_.-]{0,63})(?:\s+(.*))?$/i);
    if (!match) return false;
    const name = match[1]!.toLowerCase();
    const cmd = [...this.snapshot.values()]
      .flatMap((r) => r.commandDefinitions.map((d) => ({ record: r, definition: d })))
      .find(({ record, definition }) => definition.name.toLowerCase() === name && record.commands.some((c) => c.name === definition.name && c.enabled));
    if (!cmd) return false;
    const pt = createMessageSendTool(sessionKey, pendingCalls, signal);
    await cmd.definition.execute(`command_${Date.now()}`, match[2]?.trim() ?? "", {
      pluginId: cmd.record.id, sessionKey, config: cmd.record.policy.config,
      platform: { send: (input, sendSignal) => pt.execute(`cs_${Date.now()}`, { text: input.text, ...(input.chatId ? { chat_id: input.chatId } : {}) }, sendSignal ?? signal) },
    });
    return true;
  }

  private wrap(def: ChronoNativeToolDefinition, record: NativePluginRecord, sessionKey: string, pendingCalls: Map<string, PendingCall>, signal?: AbortSignal): AgentTool {
    const registry = this;
    return {
      name: def.name, label: def.label, description: def.description,
      parameters: def.parameters, executionMode: def.executionMode,
      async execute(toolCallId: string, params: unknown, callSignal?: AbortSignal, onUpdate?: AgentToolUpdateCallback) {
        const current = registry.snapshot.get(record.id);
        const ct = current?.tools.find((t) => t.name === def.name);
        if (!current || current.status === "disabled" || !ct?.enabled) throw new Error(`plugin tool ${def.name} is disabled`);
        const pt = createMessageSendTool(sessionKey, pendingCalls, callSignal ?? signal);
        const ctx = { pluginId: record.id, sessionKey, config: record.policy.config, platform: { send: async (input: { text: string; chatId?: string }, sendSignal?: AbortSignal) => pt.execute(toolCallId, { text: input.text, ...(input.chatId ? { chat_id: input.chatId } : {}) }, sendSignal ?? callSignal ?? signal) } };
        try {
          const result = await def.execute(toolCallId, params, callSignal ?? signal, onUpdate ?? (() => undefined), ctx);
          return { ...result, details: details(record.id, def.name, "success", undefined) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text", text: message }], details: details(record.id, def.name, "error", message) };
        }
      },
    };
  }

  private async discover(): Promise<Map<string, NativePluginRecord>> {
    const next = new Map<string, NativePluginRecord>();
    const root = pluginInstallRoot(this.chronoHome);
    let rootStat;
    try { rootStat = await stat(root); } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return next;
      throw error;
    }
    if (!rootStat.isDirectory()) throw new Error(`plugin install root is not a directory: ${root}`);
    const candidates: Candidate[] = [];
    const dirs = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    for (const dir of dirs) {
      const c: Candidate = { root: join(root, dir) };
      try { c.manifest = await loadNativeManifest(c.root); } catch (error) { c.error = error instanceof Error ? error.message : String(error); }
      candidates.push(c);
    }
    const byId = new Map<string, Candidate[]>();
    for (const c of candidates) {
      const id = c.manifest?.id ?? c.root.split("/").at(-1) ?? "unknown";
      const list = byId.get(id) ?? []; list.push(c); byId.set(id, list);
    }
    for (const [id, entries] of byId) {
      if (entries.length > 1) { next.set(id, this.invalidRecord(id, "duplicate_id", "multiple directories for the same id")); continue; }
      const c = entries[0]!;
      if (!c.manifest) { next.set(id, this.invalidRecord(id, "invalid_manifest", c.error ?? "invalid manifest")); continue; }
      const m = c.manifest;
      const policy = await readPluginPolicy(m.rootPath);
      if (!policy.enabled) {
        next.set(id, this.makeRecord(m, [], [], "disabled", undefined, policy));
        continue;
      }
      const defs: ChronoNativeToolDefinition[] = [];
      const cmds: ChronoNativeCommandDefinition[] = [];
      let loadError: string | undefined;
      try {
        const seen = new Set<string>();
        for (const entryPath of new Set([...m.entryTools, ...m.entryCommands])) {
          const url = `${new URL(`file://${entryPath}`).href}?mtime=${(await Bun.file(entryPath).stat()).mtimeMs}`;
          const mod = await import(url) as { default?: unknown };
          if (typeof mod.default !== "function") throw new Error("module default export must be a registration function");
          await (mod.default as (api: unknown) => void | Promise<void>)(createPluginApi((d) => {
            if (!d || typeof d !== "object") throw new Error("tool definition must be an object");
            if (!TOOL_RE.test(d.name)) throw new Error(`invalid tool name: ${d.name}`);
            if (seen.has(d.name)) throw new Error(`duplicate tool name: ${d.name}`);
            if (typeof d.execute !== "function") throw new Error(`tool ${d.name} has no execute function`);
            seen.add(d.name); defs.push(d);
          }, (d) => {
            if (!d || typeof d !== "object") throw new Error("command definition must be an object");
            if (!TOOL_RE.test(d.name)) throw new Error(`invalid command name: ${d.name}`);
            if (seen.has(d.name)) throw new Error(`duplicate command name: ${d.name}`);
            if (typeof d.execute !== "function") throw new Error(`command ${d.name} has no execute function`);
            seen.add(d.name); cmds.push(d);
          }));
        }
      } catch (error) { loadError = error instanceof Error ? error.message : String(error); }
      const metaToolNames = new Set(m.toolMeta.map((meta) => meta.name));
      const metaCommandNames = new Set(m.commandMeta.map((meta) => meta.name));
      const extraTools = defs.map((d) => d.name).filter((name) => !metaToolNames.has(name));
      const missingTools = m.toolMeta.map((meta) => meta.name).filter((name) => !defs.some((d) => d.name === name));
      const extraCommands = cmds.map((d) => d.name).filter((name) => !metaCommandNames.has(name));
      const missingCommands = m.commandMeta.map((meta) => meta.name).filter((name) => !cmds.some((d) => d.name === name));
      if (extraTools.length > 0) { next.set(id, this.makeRecord(m, [], [], "load_error", `JS registers tools not declared in manifest: ${extraTools.join(", ")}`, policy)); continue; }
      if (missingTools.length > 0) { next.set(id, this.makeRecord(m, [], [], "load_error", `manifest declares tools not registered by JS: ${missingTools.join(", ")}`, policy)); continue; }
      if (extraCommands.length > 0) { next.set(id, this.makeRecord(m, [], [], "load_error", `JS registers commands not declared in manifest: ${extraCommands.join(", ")}`, policy)); continue; }
      if (missingCommands.length > 0) { next.set(id, this.makeRecord(m, [], [], "load_error", `manifest declares commands not registered by JS: ${missingCommands.join(", ")}`, policy)); continue; }
      if (loadError) { next.set(id, this.makeRecord(m, [], [], "load_error", loadError, policy)); continue; }
      if (defs.length === 0 && cmds.length === 0) { next.set(id, this.makeRecord(m, [], [], "load_error", "registration function registered no tools or commands", policy)); continue; }
      next.set(id, this.makeRecord(m, defs, cmds, "ready", undefined, policy));
    }
    const seen = new Set<string>(BUILTIN_TOOLS);
    for (const record of next.values()) {
      for (const tool of record.tools) {
        if (seen.has(tool.name)) { record.status = "load_error"; record.error = `duplicate tool name: ${tool.name}`; record.toolDefinitions = []; record.tools = []; }
        else seen.add(tool.name);
    }
      }
    return next;
  }

  private makeRecord(m: NativePluginManifest, defs: ChronoNativeToolDefinition[], cmds: ChronoNativeCommandDefinition[], status: NativePluginRecord["status"], error?: string, policy = { enabled: true, config: {} as Record<string, string | boolean>, tools: {} as Record<string, { persona_blacklist: string[] }> }): NativePluginRecord {
    return {
      id: m.id, name: m.name, version: m.version, description: m.description,
      configSchema: m.configSchema,
      tools: m.toolMeta.map((meta) => ({ name: meta.name, label: meta.label, description: meta.description, enabled: status === "ready" && defs.some((d) => d.name === meta.name) })),
      commands: m.commandMeta.map((meta) => ({ name: meta.name, label: meta.label, description: meta.description, enabled: status === "ready" && cmds.some((d) => d.name === meta.name) })),
      policy, status, ...(error ? { error } : {}), manifest: m, toolDefinitions: defs, commandDefinitions: cmds,
    };
  }

  private invalidRecord(id: string, status: NativePluginRecord["status"], error: string): NativePluginRecord {
    return { id, name: id, version: "0.0.0", description: "", configSchema: [], tools: [], commands: [], policy: { enabled: false, config: {}, tools: {} }, status, error, toolDefinitions: [], commandDefinitions: [] };
  }
}
