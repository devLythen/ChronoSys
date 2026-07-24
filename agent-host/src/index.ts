import type { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import type { ChronoEvent, ToolIpcMessage } from "./ipc/types.ts";
import { MAX_FRAME_BYTES } from "./ipc/framing.ts";

export type { Agent, ChronoEvent, ToolIpcMessage };
export { createModels, MAX_FRAME_BYTES };

export const AGENT_HOST_VERSION = "0.0.1";
