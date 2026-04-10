import { describe, expect, it, vi } from "vitest";

vi.mock("lucy-im-sdk", async () => {
  const deviceIdentityMock = vi.fn().mockResolvedValue({ cdi: "2031655882831360000", user_id: "user_demo" });
  const resetBindingMock = vi.fn().mockResolvedValue(undefined);
  class LucyImClient {
    deviceIdentity = deviceIdentityMock;
    resetBinding = resetBindingMock;
  }
  class LucyImConfig {}
  return { LucyImClient, LucyImConfig };
});

import { getLucyDeviceIdentity, resetLucyState } from "./state.js";

describe("lucy state (sdk proxy)", () => {
  it("getLucyDeviceIdentity delegates to LucyImClient.deviceIdentity", async () => {
    const fakeConfig = {} as Parameters<typeof getLucyDeviceIdentity>[0];
    const identity = await getLucyDeviceIdentity(fakeConfig);
    expect(identity.cdi).toBe("2031655882831360000");
  });

  it("resetLucyState delegates to LucyImClient.resetBinding", async () => {
    const fakeConfig = {} as Parameters<typeof resetLucyState>[0];
    await expect(resetLucyState(fakeConfig)).resolves.toBeUndefined();
  });
});
