import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createInitialSystemMessage,
  toToolDeclaration,
} from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const PROTOCOL_MARKERS = [
  "<｜DSML｜",
  "<|DSML|",
  "</think>",
  "<tool_call>",
  "</tool_call>",
  "<function_call>",
  "</function_call>",
];

/** Detect provider control markers that leaked into ordinary text. */
export function findProtocolMarker(text: string): string | null {
  for (const marker of PROTOCOL_MARKERS) {
    if (text.includes(marker)) return marker;
  }
  return null;
}

/** Scan assistant/tool text blocks for leaked protocol markers. */
export function findProtocolMarkerInMessages(
  messages: readonly AgentMessage[],
): string | null {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "text") {
        const marker = findProtocolMarker(block.text);
        if (marker) return marker;
      } else if (block.type === "thinking") {
        const marker = findProtocolMarker(block.thinking);
        if (marker) return marker;
      }
    }
  }
  return null;
}

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
