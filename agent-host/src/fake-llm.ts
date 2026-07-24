import type {
  Api,
  AssistantMessage,
  Model,
  Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const FAKE_MODEL: Model<Api> = {
  id: "fake",
  name: "Chrono Fake LLM",
  api: "faux",
  provider: "chrono-fake",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
};

function assistantMessage(
  model: Model<Api>,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

/**
 * Canned StreamFn for M1 demos.
 * Turn 1 (no tool result yet): text + message.send tool call.
 * Turn 2 (after tool result): plain text confirmation.
 */
export function createFakeStreamFn(messageSendText: string): StreamFn {
  return (model, context) => {
    const stream = createAssistantMessageEventStream();

    void (async () => {
      try {
        const last = context.messages[context.messages.length - 1];
        const afterTool = last?.role === "toolResult";

        if (afterTool) {
          const text = "Done! Message sent.";
          const message = assistantMessage(
            model,
            [{ type: "text", text }],
            "stop",
          );
          stream.push({ type: "start", partial: { ...message, content: [] } });
          stream.push({
            type: "text_start",
            contentIndex: 0,
            partial: { ...message, content: [{ type: "text", text: "" }] },
          });
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: text,
            partial: { ...message, content: [{ type: "text", text }] },
          });
          stream.push({
            type: "text_end",
            contentIndex: 0,
            content: text,
            partial: message,
          });
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
          return;
        }

        const text = "Sure, I'll send a message.";
        const toolCall = {
          type: "toolCall" as const,
          id: "fake_call_001",
          name: "message_send",
          arguments: { text: messageSendText },
        };
        const message = assistantMessage(
          model,
          [{ type: "text", text }, toolCall],
          "toolUse",
        );

        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({
          type: "text_start",
          contentIndex: 0,
          partial: {
            ...message,
            content: [{ type: "text", text: "" }],
          },
        });
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: text,
          partial: {
            ...message,
            content: [{ type: "text", text }],
          },
        });
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: text,
          partial: {
            ...message,
            content: [{ type: "text", text }],
          },
        });
        stream.push({
          type: "toolcall_start",
          contentIndex: 1,
          partial: {
            ...message,
            content: [
              { type: "text", text },
              {
                type: "toolCall",
                id: toolCall.id,
                name: toolCall.name,
                arguments: {},
              },
            ],
          },
        });
        stream.push({
          type: "toolcall_end",
          contentIndex: 1,
          toolCall,
          partial: message,
        });
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end(message);
      } catch (err) {
        const errorMessage = assistantMessage(model, [], "error");
        errorMessage.errorMessage =
          err instanceof Error ? err.message : String(err);
        stream.push({ type: "error", reason: "error", error: errorMessage });
        stream.end(errorMessage);
      }
    })();

    return stream;
  };
}
