import { LucyMessageIdSchema } from "./types.js";

export type LucyAuthQrPayload = {
  channel: "lucy";
  channel_device_id: string;
  otp?: string;
};

export function buildLucyAuthQrPayload(
  channelDeviceId: string,
  otp?: string,
): LucyAuthQrPayload {
  const normalized = parseLucyAuthQrChannelDeviceId(channelDeviceId);
  return {
    channel: "lucy",
    channel_device_id: normalized,
    ...(otp ? { otp } : {}),
  };
}

export function buildLucyAuthQrUri(
  channelDeviceId: string,
  otp?: string,
): string {
  const payload = buildLucyAuthQrPayload(channelDeviceId, otp);
  const params = new URLSearchParams({ channel_device_id: payload.channel_device_id });
  if (payload.otp) {
    params.set("otp", payload.otp);
  }
  return `lucy://bind?${params.toString()}`;
}

export function buildLucyAuthQrJson(
  channelDeviceId: string,
  otp?: string,
): string {
  return JSON.stringify(buildLucyAuthQrPayload(channelDeviceId, otp));
}

export function parseLucyAuthQrChannelDeviceId(channelDeviceId: string): string {
  return LucyMessageIdSchema.parse(channelDeviceId.trim());
}
