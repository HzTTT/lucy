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

  it("defaults allowFrom to empty array", () => {
    const account = resolveLucyAccount(
      {
        channels: {
          lucy: {
            userCenterDomain: "user-center.lucy.run",
            lucyServerDomain: "chat.lucy.run",
          },
        },
      } as OpenClawConfig,
      "default",
    );
    expect(account.allowFrom).toEqual([]);
    expect(account.configured).toBe(true);
    expect(account.mediaMaxBytes).toBe(20 * 1024 * 1024);
    expect(account.maxAttachments).toBe(10);
  });

  it("keeps configured mediaLocalRoots for outbound local media sends", () => {
    const account = resolveLucyAccount(
      {
        channels: {
          lucy: {
            userCenterDomain: "user-center.lucy.run",
            lucyServerDomain: "chat.lucy.run",
            mediaLocalRoots: [" /srv/lucy-media ", "/mnt/attachments"],
          },
        },
      } as OpenClawConfig,
      "default",
    );

    expect(account.mediaLocalRoots).toEqual(["/srv/lucy-media", "/mnt/attachments"]);
  });

  it("resolves local notify defaults when enabled", () => {
    const account = resolveLucyAccount(
      {
        channels: {
          lucy: {
            userCenterDomain: "user-center.lucy.run",
            lucyServerDomain: "chat.lucy.run",
            localNotify: {
              enabled: true,
            },
          },
        },
      } as OpenClawConfig,
      "default",
    );

    expect(account.localNotify).toEqual({
      enabled: true,
      bind: "127.0.0.1",
      port: 8788,
      path: "/usb-events",
    });
    expect(account.configured).toBe(true);
  });

  it("treats invalid local notify ports as unconfigured", () => {
    const account = resolveLucyAccount(
      {
        channels: {
          lucy: {
            userCenterDomain: "user-center.lucy.run",
            lucyServerDomain: "chat.lucy.run",
            localNotify: {
              enabled: true,
              port: 70000,
            },
          },
        },
      } as OpenClawConfig,
      "default",
    );

    expect(account.configured).toBe(false);
    expect(unconfiguredLucyReason(account)).toContain("localNotify.port");
  });

  it("treats missing userCenterDomain as unconfigured", () => {
    const account = resolveLucyAccount(
      {
        channels: {
          lucy: {
            lucyServerDomain: "chat.lucy.run",
          },
        },
      } as OpenClawConfig,
      "default",
    );
    expect(account.configured).toBe(false);
    expect(unconfiguredLucyReason(account)).toContain("userCenterDomain");
  });

  it("validates subject tokens", () => {
    expect(isValidSubjectToken("cuk_demo_user")).toBe(true);
    expect(isValidSubjectToken("bad.token")).toBe(false);
    expect(isValidSubjectToken("")).toBe(false);
    expect(isValidSubjectToken(undefined)).toBe(false);
  });
});
