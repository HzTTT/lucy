import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  listLucyAccountIds,
  resolveLucyAccount,
  unconfiguredLucyReason,
  isValidSubjectToken,
} from "./config.js";

describe("lucy config", () => {
  it("always exposes a default account id", () => {
    expect(listLucyAccountIds({} as OpenClawConfig)).toEqual(["default"]);
  });

  it("defaults allowFrom to apiKey", () => {
    const account = resolveLucyAccount(
      {
        channels: {
          lucy: {
            apiKey: "demo_user",
          },
        },
      } as OpenClawConfig,
      "default",
    );
    expect(account.allowFrom).toEqual(["demo_user"]);
    expect(account.configured).toBe(true);
  });

  it("treats invalid apiKey tokens as unconfigured", () => {
    const account = resolveLucyAccount(
      {
        channels: {
          lucy: {
            apiKey: "bad.token",
          },
        },
      } as OpenClawConfig,
      "default",
    );
    expect(account.configured).toBe(false);
    expect(unconfiguredLucyReason(account)).toContain("apiKey");
    expect(isValidSubjectToken("bad.token")).toBe(false);
  });
});
