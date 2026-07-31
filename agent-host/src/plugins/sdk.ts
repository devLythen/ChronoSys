import { Type } from "@earendil-works/pi-ai";
import type { ChronoPluginApi, ChronoNativeToolDefinition, ChronoNativeCommandDefinition } from "./types.ts";

export function createPluginApi(
  registerTool: (definition: ChronoNativeToolDefinition) => void,
  registerCommand: (definition: ChronoNativeCommandDefinition) => void,
): ChronoPluginApi {
  return { Type, registerTool, registerCommand };
}
