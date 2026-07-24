export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class FrameError extends Error {
  readonly code: "incomplete" | "too_large";
  readonly need?: number;
  readonly len?: number;

  constructor(
    code: "incomplete" | "too_large",
    opts: { need?: number; len?: number; message: string },
  ) {
    super(opts.message);
    this.name = "FrameError";
    this.code = code;
    this.need = opts.need;
    this.len = opts.len;
  }
}

/** Encode payload as u32 big-endian length + payload. */
export function encodeFrame(payload: Uint8Array): Uint8Array {
  if (payload.byteLength > MAX_FRAME_BYTES) {
    throw new FrameError("too_large", {
      len: payload.byteLength,
      message: `frame too large: ${payload.byteLength} bytes (max ${MAX_FRAME_BYTES})`,
    });
  }
  const out = new Uint8Array(4 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.byteLength, false);
  out.set(payload, 4);
  return out;
}

/** Decode one frame from `buf`. Returns `{ payload, bytesConsumed }`. */
export function decodeFrame(
  buf: Uint8Array,
): { payload: Uint8Array; bytesConsumed: number } {
  if (buf.byteLength < 4) {
    throw new FrameError("incomplete", {
      need: 4,
      message: "incomplete frame: need at least 4 bytes",
    });
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const len = view.getUint32(0, false);
  if (len > MAX_FRAME_BYTES) {
    throw new FrameError("too_large", {
      len,
      message: `frame too large: ${len} bytes (max ${MAX_FRAME_BYTES})`,
    });
  }
  const total = 4 + len;
  if (buf.byteLength < total) {
    throw new FrameError("incomplete", {
      need: total,
      message: `incomplete frame: need at least ${total} bytes`,
    });
  }
  return {
    payload: buf.slice(4, total),
    bytesConsumed: total,
  };
}
