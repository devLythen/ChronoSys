import { Readable } from "node:stream";
import { decodeFrame, encodeFrame, FrameError } from "./ipc/framing.ts";

/**
 * Read length-prefixed frames from a web ReadableStream (e.g. stdin).
 * Yields payloads; incomplete frames wait for more data.
 */
export async function* readFrames(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);

  try {
    while (true) {
      // Drain complete frames from the buffer first.
      while (true) {
        try {
          const { payload, bytesConsumed } = decodeFrame(buffer);
          buffer = buffer.slice(bytesConsumed);
          yield payload;
        } catch (err) {
          if (err instanceof FrameError && err.code === "incomplete") {
            break;
          }
          throw err;
        }
      }

      const { done, value } = await reader.read();
      if (done) {
        if (buffer.byteLength > 0) {
          throw new FrameError("incomplete", {
            need: buffer.byteLength + 1,
            message: `stream ended with ${buffer.byteLength} leftover bytes`,
          });
        }
        return;
      }
      if (!value || value.byteLength === 0) continue;

      const next = new Uint8Array(buffer.byteLength + value.byteLength);
      next.set(buffer, 0);
      next.set(value, buffer.byteLength);
      buffer = next;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Encode payload and write one framed message to a web WritableStream. */
export async function writeFrame(
  writable: WritableStream<Uint8Array>,
  payload: Uint8Array,
): Promise<void> {
  const frame = encodeFrame(payload);
  const writer = writable.getWriter();
  try {
    await writer.write(frame);
  } finally {
    writer.releaseLock();
  }
}

/** Encode payload and write one framed message to process.stdout. */
export function writeFrameStdout(payload: Uint8Array): void {
  const frame = encodeFrame(payload);
  process.stdout.write(frame);
}

/** Convert Node Readable (stdin) to a web ReadableStream. */
export function stdinAsWebStream(): ReadableStream<Uint8Array> {
  return Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
}
