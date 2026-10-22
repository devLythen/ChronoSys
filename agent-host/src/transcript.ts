import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createInitialSystemMessage,
  toToolDeclaration,
} from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

/** Conversation transcript without Pi's replayed system message. */
export function conversationMessages(
  messages: readonly AgentMessage[],
): AgentMessage[] {
  return messages.filter((message) => message.role !== "system");
}

/** Build the transcript for a turn: current prompt/tools lead, history follows. */
export function withSystemPrompt(
  messages: readonly AgentMessage[],
  prompt: string,
  tools: readonly AgentTool[],
): AgentMessage[] {
  const system = createInitialSystemMessage(
    prompt,
    tools.map((tool) => toToolDeclaration(tool)),
  );
  const history = conversationMessages(messages);
  return system ? [system, ...history] : history;
}
