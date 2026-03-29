import os from "node:os";
import path from "node:path";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLucyRuntime } from "./runtime.js";
import {
  applyLucyProvisioningConfig,
  spawnLucyRestartHelper,
} from "./provider-provisioning.js";

describe("lucy provider provisioning", () => {
  const stateDir = path.join(os.tmpdir(), `openclaw-lucy-provisioning-${Date.now()}`);

  beforeEach(() => {
    setLucyRuntime({
      state: {
        resolveStateDir: () => stateDir,
      },
    } as unknown as PluginRuntime);
  });

  it("registers the cephalon provider and switches the default model to cephalon/kimi-k2.5", () => {
    const next = applyLucyProvisioningConfig({} as OpenClawConfig, {
      providerId: "cephalon",
      modelId: "kimi-k2.5",
      apiKey: "sk_test_cephalon",
      baseUrl: "https://prod.unicorn.org.cn/cephalon/user-center/v1/model",
      switchDefaultModel: true,
    });

    expect(next.models?.providers?.cephalon).toEqual(
      expect.objectContaining({
        api: "openai-completions",
        apiKey: "sk_test_cephalon",
        baseUrl: "https://prod.unicorn.org.cn/cephalon/user-center/v1/model",
        models: expect.arrayContaining([
          expect.objectContaining({
            id: "kimi-k2.5",
            name: "Kimi K2.5",
          }),
        ]),
      }),
    );
    expect(next.agents?.defaults?.model).toEqual(
      expect.objectContaining({
        primary: "cephalon/kimi-k2.5",
      }),
    );
    expect(next.agents?.defaults?.models?.["cephalon/kimi-k2.5"]).toEqual(
      expect.objectContaining({ alias: "Kimi" }),
    );
  });

  it("can update provider credentials without overriding the current default model when explicitly disabled", () => {
    const next = applyLucyProvisioningConfig(
      {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4",
            },
          },
        },
      } as OpenClawConfig,
      {
        providerId: "cephalon",
        modelId: "kimi-k2.5",
        apiKey: "sk_test_cephalon",
        baseUrl: "https://prod.unicorn.org.cn/cephalon/user-center/v1/model",
        switchDefaultModel: false,
      },
    );

    expect(next.models?.providers?.cephalon).toEqual(
      expect.objectContaining({
        apiKey: "sk_test_cephalon",
      }),
    );
    expect(next.agents?.defaults?.model).toEqual(
      expect.objectContaining({
        primary: "openai/gpt-5.4",
      }),
    );
  });

  it("uses the configured restart helper when scheduling an automatic restart", async () => {
    const unref = vi.fn();
    const child = {
      once(event: string, callback: (...args: unknown[]) => void) {
        if (event === "spawn") {
          callback();
        }
        return child as never;
      },
      unref,
    };

    await spawnLucyRestartHelper({
      cfg: {
        channels: {
          lucy: {
            restartHelperCommand: "cephalon-hostctl-test",
            restartHelperArgs: ["restart-openclaw", "--delay-ms", "500"],
          },
        },
      } as OpenClawConfig,
      spawnImpl: vi.fn(() => child) as any,
    });

    expect(unref).toHaveBeenCalledTimes(1);
  });
});
