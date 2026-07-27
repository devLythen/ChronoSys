import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFrame, encodeFrame, FrameError } from "./framing.ts";
import type { ChronoEvent, ToolIpcMessage } from "./types.ts";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
);

function loadJson<T>(name: string): T {
  const raw = readFileSync(join(fixturesDir, name), "utf8");
  return JSON.parse(raw) as T;
}

describe("fixtures discriminators", () => {
  test("inbound_message", () => {
    const ev = loadJson<ChronoEvent>("inbound_message.json");
    expect(ev.type).toBe("inbound.message");
    expect(ev.session_key).toBe("acct1:chat1:shared");
    expect(ev.chat.kind).toBe("group");
    expect(ev.message.attachments).toEqual([]);
  });

  test("tool_request", () => {
    const msg = loadJson<ToolIpcMessage>("tool_request.json");
    expect(msg.type).toBe("tool.request");
    if (msg.type === "tool.request") {
      expect(msg.timeout_ms).toBe(15000);
      expect(msg.name).toBe("message_send");
    }
  });

  test("tool_response_ok", () => {
    const msg = loadJson<ToolIpcMessage>("tool_response_ok.json");
    expect(msg.type).toBe("tool.response");
    if (msg.type === "tool.response") {
      expect(msg.ok).toBe(true);
      expect(msg.result).toEqual({ message_id: "msg_out_1" });
    }
  });

  test("tool_response_err", () => {
    const msg = loadJson<ToolIpcMessage>("tool_response_err.json");
    expect(msg.type).toBe("tool.response");
    if (msg.type === "tool.response") {
      expect(msg.ok).toBe(false);
      expect(msg.error?.code).toBe("unsupported");
    }
  });
});

describe("frame roundtrip of fixture bytes", () => {
  for (const name of [
    "inbound_message.json",
    "tool_request.json",
    "tool_response_ok.json",
    "tool_response_err.json",
  ]) {
    test(name, () => {
      const bytes = new TextEncoder().encode(
        readFileSync(join(fixturesDir, name), "utf8"),
      );
      const framed = encodeFrame(bytes);
      const { payload, bytesConsumed } = decodeFrame(framed);
      expect(bytesConsumed).toBe(framed.byteLength);
      expect(payload).toEqual(bytes);
      expect(JSON.parse(new TextDecoder().decode(payload))).toEqual(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
    });
  }

  test("truncated buffer is incomplete", () => {
    expect(() => decodeFrame(new Uint8Array([0, 0]))).toThrow(FrameError);
  });
});
