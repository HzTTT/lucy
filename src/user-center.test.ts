import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLucyBindingCheckUrl,
  fetchLucyDeviceBinding,
  mergeLucyBindingIntoState,
  registerLucyDevice,
} from "./user-center.js";

describe("lucy user-center client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts device registrations with channel_device_id and bootstrap_token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          channel: "lucy",
          channel_device_id: "2080563661542787073",
          binding_status: "pending",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await registerLucyDevice({
      channelDeviceId: "2080563661542787073",
      bootstrapToken: "cbt_test",
    });

    expect(result).toEqual({
      channel: "lucy",
      channel_device_id: "2080563661542787073",
      binding_status: "pending",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://test.unicorn.org.cn/cephalon/user-center/v1/channels/lucy/devices/registrations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          channel_device_id: "2080563661542787073",
          bootstrap_token: "cbt_test",
        }),
      }),
    );
  });

  it("sends X-Bootstrap-Token when polling device bindings", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          channel: "lucy",
          channel_device_id: "2080563661542787073",
          binding_status: "bound",
          channel_user_key: "cuk_demo_user",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchLucyDeviceBinding({
      channelDeviceId: "2080563661542787073",
      bootstrapToken: "cbt_test",
    });

    expect(result.channel_user_key).toBe("cuk_demo_user");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://test.unicorn.org.cn/cephalon/user-center/v1/channels/lucy/device-bindings/2080563661542787073",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Bootstrap-Token": "cbt_test",
        }),
      }),
    );
  });

  it("merges a bound binding response into the local device state", () => {
    expect(
      mergeLucyBindingIntoState(
        {
          version: 2,
          channelDeviceId: "2080563661542787073",
          bootstrapToken: "cbt_test",
          bindingStatus: "pending",
          createdAtMs: 1773160840000,
        },
        {
          binding_status: "bound",
          channel_user_key: "cuk_demo_user",
        },
      ),
    ).toEqual(
      expect.objectContaining({
        channelUserKey: "cuk_demo_user",
        bindingStatus: "bound",
      }),
    );
  });

  it("builds the binding check URL from the hardcoded user-center base URL", () => {
    expect(buildLucyBindingCheckUrl("2080563661542787073")).toBe(
      "https://test.unicorn.org.cn/cephalon/user-center/v1/channels/lucy/device-bindings/2080563661542787073",
    );
  });
});
