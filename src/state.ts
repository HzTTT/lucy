import { LucyImClient, type LucyImConfig } from "lucy-im-sdk";

export async function getLucyDeviceIdentity(cfg: LucyImConfig): Promise<{ cdi: string; userId?: string }> {
  const client = new LucyImClient(cfg);
  return await client.deviceIdentity();
}

export async function resetLucyState(cfg: LucyImConfig): Promise<void> {
  const client = new LucyImClient(cfg);
  await client.resetBinding();
}
