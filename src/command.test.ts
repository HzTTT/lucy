import { describe, expect, it } from "vitest";
import { buildLucyBindQrUrl, formatLucyAuthQrReply } from "./command.js";

describe("lucy command helpers", () => {
  it("builds a lucy bind url with the channel_device_id query param", () => {
    expect(buildLucyBindQrUrl("2032822201826258944")).toBe(
      "lucy://bind?channel_device_id=2032822201826258944",
    );
  });

  it("formats the auth qrcode reply with instructions and qr payload", () => {
    const reply = formatLucyAuthQrReply({
      channelDeviceId: "2032822201826258944",
      qrUrl: "lucy://bind?channel_device_id=2032822201826258944",
      qrAscii: "██\n██\n",
    });

    expect(reply).toContain("Lucy auth QR code generated.");
    expect(reply).toContain("channel_device_id: 2032822201826258944");
    expect(reply).toContain("lucy://bind?channel_device_id=2032822201826258944");
    expect(reply).toContain("Scan this QR code");
  });
});
