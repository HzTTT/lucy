import { LucyMessageIdSchema } from "./types.js";

export type LucyAuthQrPayload = {
  channel: "lucy";
  channel_device_id: string;
};

export function buildLucyAuthQrPayload(channelDeviceId: string): LucyAuthQrPayload {
  const normalized = parseLucyAuthQrChannelDeviceId(channelDeviceId);
  return {
    channel: "lucy",
    channel_device_id: normalized,
  };
}

export function buildLucyAuthQrUri(channelDeviceId: string): string {
  const payload = buildLucyAuthQrPayload(channelDeviceId);
  const params = new URLSearchParams({ channel_device_id: payload.channel_device_id });
  return `lucy://bind?${params.toString()}`;
}

export function buildLucyAuthQrJson(channelDeviceId: string): string {
  return JSON.stringify(buildLucyAuthQrPayload(channelDeviceId));
}

export function parseLucyAuthQrChannelDeviceId(channelDeviceId: string): string {
  return LucyMessageIdSchema.parse(channelDeviceId.trim());
}
