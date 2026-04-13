import { describe, expect, it } from "vitest";
import {
  PAIRING_IPC_MAX_FRAME_BYTES,
  PairingIpcFrameError,
  decodePairingIpcLine,
  encodePairingIpcMessage,
  type PairingIpcMessage,
} from "./pairing-ipc-types.js";

const ROUNDTRIP_CASES: Array<[string, PairingIpcMessage]> = [
  [
    "bind.request",
    { type: "bind.request", request_id: "req-1", requested_at_ms: 1_700_000_000_000 },
  ],
  [
    "otp.issued",
    {
      type: "otp.issued",
      request_id: "req-1",
      otp: "123456",
      expires_at_ms: 1_700_000_300_000,
    },
  ],
  [
    "otp.error",
    { type: "otp.error", request_id: "req-1", error: "preBind failed: upstream 502" },
  ],
  [
    "bind.completed",
    { type: "bind.completed", cuk: "cuk_abcdef", user_id: "user_xyz" },
  ],
  ["bind.cleared", { type: "bind.cleared" }],
  ["ping", { type: "ping" }],
  ["pong", { type: "pong" }],
];

describe("pairing-ipc-types: encode/decode roundtrip", () => {
  for (const [label, msg] of ROUNDTRIP_CASES) {
    it(`roundtrips ${label}`, () => {
      const encoded = encodePairingIpcMessage(msg);
      expect(encoded.endsWith("\n")).toBe(true);
      expect(encoded).not.toContain("\r");
      const decoded = decodePairingIpcLine(encoded.trimEnd());
      expect(decoded).toEqual(msg);
    });
  }
});

describe("pairing-ipc-types: decode rejects invalid frames", () => {
  const expectFrameError = (fn: () => unknown, code: PairingIpcFrameError["code"]) => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(PairingIpcFrameError);
      expect((err as PairingIpcFrameError).code).toBe(code);
      return;
    }
    throw new Error(`expected PairingIpcFrameError(${code}) to be thrown`);
  };

  it("rejects non-JSON lines", () => {
    expectFrameError(() => decodePairingIpcLine("not json at all"), "invalid_json");
  });

  it("rejects unknown type", () => {
    expectFrameError(
      () => decodePairingIpcLine('{"type":"nope","request_id":"r"}'),
      "invalid_schema",
    );
  });

  it("rejects bind.request with missing fields", () => {
    expectFrameError(
      () => decodePairingIpcLine('{"type":"bind.request"}'),
      "invalid_schema",
    );
  });

  it("rejects otp.issued with non-positive expires_at_ms", () => {
    expectFrameError(
      () =>
        decodePairingIpcLine(
          '{"type":"otp.issued","request_id":"r","otp":"123456","expires_at_ms":0}',
        ),
      "invalid_schema",
    );
  });

  it("rejects bind.request with empty request_id", () => {
    expectFrameError(
      () =>
        decodePairingIpcLine(
          '{"type":"bind.request","request_id":"","requested_at_ms":1}',
        ),
      "invalid_schema",
    );
  });

  it("rejects oversized incoming frame", () => {
    const oversized = `${"x".repeat(PAIRING_IPC_MAX_FRAME_BYTES + 10)}`;
    expectFrameError(() => decodePairingIpcLine(oversized), "frame_too_large");
  });
});

describe("pairing-ipc-types: encode rejects oversized frames", () => {
  it("rejects bind.completed with huge cuk", () => {
    const msg: PairingIpcMessage = {
      type: "bind.completed",
      // cuk schema allows up to 256 chars; bypass schema validation by casting,
      // so the frame-size guard is what actually trips.
      cuk: "c".repeat(PAIRING_IPC_MAX_FRAME_BYTES),
      user_id: "u",
    } as PairingIpcMessage;
    try {
      encodePairingIpcMessage(msg);
      throw new Error("expected encode to throw PairingIpcFrameError");
    } catch (err) {
      expect(err).toBeInstanceOf(PairingIpcFrameError);
      expect((err as PairingIpcFrameError).code).toBe("frame_too_large");
    }
  });
});
