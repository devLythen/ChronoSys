import { test, expect } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { conversationMessages, withSystemPrompt } from "./transcript.ts";

test("withSystemPrompt replaces the leading prompt and keeps history", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "old prompt", timestamp: 0 },
    { role: "user", content: "hello", timestamp: 1 },
  ];

  const transcript = withSystemPrompt(messages, "new prompt", []);

  expect(transcript[0]).toMatchObject({
    role: "system",
    content: "new prompt",
  });
  expect(transcript.slice(1)).toEqual([messages[1]!]);
});

test("conversationMessages removes every system message", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "a", timestamp: 0 },
    { role: "user", content: "hello", timestamp: 1 },
    { role: "system", content: "b", timestamp: 2 },
  ];

  expect(conversationMessages(messages)).toEqual([messages[1]!]);
});
