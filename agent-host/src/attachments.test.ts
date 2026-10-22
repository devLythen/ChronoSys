import { test, expect } from "bun:test";
import type { ChronoEvent } from "./ipc/types.ts";
import { ATTACHMENT_ONLY_PROMPT, buildAttachmentNote } from "./attachments.ts";

function event(localPath: string | undefined, text = ""): ChronoEvent {
  return {
    type: "inbound.message",
    session_key: "acc:chat:dm",
    event_id: "e1",
    platform: "telegram",
    chat: { id: "chat", kind: "dm" },
    sender: { id: "u", name: "User" },
    message: {
      id: "m1",
      text,
      attachments: [
        {
          id: "f1",
          mime: "text/csv",
          name: "sales.csv",
          local_path: localPath,
        },
      ],
    },
    received_at: "2026-01-01T00:00:00Z",
  };
}

test("attachment notes expose the upload path", () => {
  const note = buildAttachmentNote(event("/workspace/upload/m1/sales.csv"));
  expect(note).toContain("/workspace/upload/m1/sales.csv");
  expect(note).toContain("sales.csv");
});

test("failed uploads are marked unavailable", () => {
  expect(buildAttachmentNote(event(undefined))).toContain("unavailable");
});

test("attachment-only messages get a text prompt", () => {
  expect(ATTACHMENT_ONLY_PROMPT.length).toBeGreaterThan(0);
});
