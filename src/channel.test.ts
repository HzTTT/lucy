import { describe, expect, it } from "vitest";
import { lucyPlugin } from "./channel.js";

describe("lucyPlugin", () => {
  it("declares a DM-only channel", () => {
    expect(lucyPlugin.id).toBe("lucy");
    expect(lucyPlugin.capabilities.chatTypes).toEqual(["direct"]);
    expect(lucyPlugin.capabilities.blockStreaming).toBe(true);
  });

  it("exposes a direct outbound adapter", () => {
    expect(lucyPlugin.outbound?.deliveryMode).toBe("direct");
    expect(lucyPlugin.gateway?.startAccount).toBeTypeOf("function");
  });
});
