import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

export type NativeExecutionMode = "parallel" | "sequential";

export type ChronoPlatform = {
  send(input: { text: string; chatId?: string }, signal?: AbortSignal): Promise<AgentToolResult<unknown>>;
};

export type ChronoPluginContext = {
  pluginId: string;
  sessionKey: string;
  platform: ChronoPlatform;
  config: Record<string, unknown>;
};

export type ChronoNativeCommandDefinition = {
  name: string;
  label: string;
  description: string;
  execute(commandId: string, args: string, context: ChronoPluginContext): Promise<void>;
};

export type ChronoNativeToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  executionMode?: NativeExecutionMode;
  execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback, context: ChronoPluginContext): Promise<AgentToolResult<unknown>>;
};

export type ChronoPluginApi = {
  Type: typeof import("@earendil-works/pi-ai").Type;
  registerTool(definition: ChronoNativeToolDefinition): void;
  registerCommand(definition: ChronoNativeCommandDefinition): void;
};

export type NativePluginRegistration = (api: ChronoPluginApi) => void | Promise<void>;

export type NativePluginConfigField = {
  key: string;
  label: string;
  type: "string" | "boolean";
  default: string | boolean;
  description?: string;
};

export type NativePluginEntryMeta = { name: string; label: string; description: string };

export type NativePluginManifest = {
  id: string;
  name: string;
  version: string;
  chronoApi: "1";
  description: string;
  entryTools: string[];
  entryCommands: string[];
  toolMeta: NativePluginEntryMeta[];
  commandMeta: NativePluginEntryMeta[];
  configSchema: NativePluginConfigField[];
  rootPath: string;
  manifestPath: string;
};

export type PluginStatus = "ready" | "disabled" | "duplicate_id" | "invalid_manifest" | "load_error";

export type NativePluginToolView = {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
};

export type NativePluginCommandView = {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
};

export type NativePluginPolicyView = {
  enabled: boolean;
  config: Record<string, string | boolean>;
  tools: Record<string, { persona_blacklist: string[] }>;
};

export type NativePluginView = {
  id: string;
  name: string;
  version: string;
  description: string;
  configSchema: NativePluginConfigField[];
  tools: NativePluginToolView[];
  commands: NativePluginCommandView[];
  policy: NativePluginPolicyView;
  status: PluginStatus;
  error?: string;
};

export type NativePluginRecord = NativePluginView & {
  manifest?: NativePluginManifest;
  toolDefinitions: ChronoNativeToolDefinition[];
  commandDefinitions: ChronoNativeCommandDefinition[];
};
