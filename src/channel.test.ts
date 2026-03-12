import { describe, expect, it } from "vitest";
import { normalizeLucyOutboundTarget } from "./channel.js";

describe("normalizeLucyOutboundTarget", () => {
  it("strips the lucy: prefix used by message tool targets", () => {
    expect(normalizeLucyOutboundTarget("lucy:demo_user")).toBe("demo_user");
  });

  it("keeps already-normalized apiKeys unchanged", () => {
    expect(normalizeLucyOutboundTarget("demo_user")).toBe("demo_user");
  });

  it("returns undefined for empty targets", () => {
    expect(normalizeLucyOutboundTarget("   ")).toBeUndefined();
  });
});
