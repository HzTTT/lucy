import { describe, expect, it } from "vitest";
import {
  buildLucyAuthQrJson,
  buildLucyAuthQrPayload,
  buildLucyAuthQrUri,
  parseLucyAuthQrChannelDeviceId,
} from "./auth-qrcode.js";

describe("lucy auth qrcode helpers", () => {
  it("builds a stable bind URI from channel_device_id", () => {
    expect(buildLucyAuthQrUri("2032822201826258944")).toBe(
      "lucy://bind?channel_device_id=2032822201826258944",
    );
  });

  it("builds a JSON payload from channel_device_id", () => {
    expect(buildLucyAuthQrJson("2032822201826258944")).toBe(
      JSON.stringify({
        channel: "lucy",
        channel_device_id: "2032822201826258944",
      }),
    );
    expect(buildLucyAuthQrPayload("2032822201826258944")).toEqual({
      channel: "lucy",
      channel_device_id: "2032822201826258944",
    });
  });

  it("rejects invalid channel_device_id values", () => {
    expect(() => parseLucyAuthQrChannelDeviceId("bad-device-id")).toThrow(/Invalid string/);
  });
});
