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
  return messages
    .filter((message) => message.role !== "system")
    .map(withoutInlineImages);
}

/** Native image blocks are rehydrated through sandbox tools, not persisted. */
function withoutInlineImages(message: AgentMessage): AgentMessage {
  if (message.role !== "user" && message.role !== "toolResult") return message;
  if (!Array.isArray(message.content)) return message;
  const content = message.content.filter((block) => block.type !== "image");
  if (content.length === message.content.length) return message;
  return {
    ...message,
    content:
      content.length > 0
        ? content
        : [{ type: "text", text: "[image omitted; use sandbox_view_image]" }],
  };
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
