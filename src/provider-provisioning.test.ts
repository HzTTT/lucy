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

  it("propagates the Lucy API key into multimodal-rag cephalon-backed ollama and zhipu settings", () => {
    const next = applyLucyProvisioningConfig(
      {
        plugins: {
          entries: {
            "multimodal-rag": {
              enabled: true,
              config: {
                watchPaths: ["/home/lucy/data"],
                ollama: {
                  baseUrl: "https://prod.unicorn.org.cn/cephalon/user-center/v1/model",
                  visionModel: "qwen3-vl:2b",
                  embedModel: "qwen3-embedding:latest",
                },
                embedding: {
                  provider: "ollama",
                },
                whisper: {
                  provider: "zhipu",
                  zhipuApiBaseUrl: "https://prod.unicorn.org.cn/cephalon/user-center/v1/model",
                  zhipuModel: "glm-asr-2512",
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      {
        providerId: "cephalon",
        modelId: "kimi-k2.5",
        apiKey: "sk_test_cephalon",
        baseUrl: "https://prod.unicorn.org.cn/cephalon/user-center/v1/model",
        switchDefaultModel: true,
      },
    );

    const pluginConfig = (next.plugins?.entries?.["multimodal-rag"] as { config?: Record<string, any> })?.config;
    expect(pluginConfig?.ollama).toEqual(
      expect.objectContaining({
        baseUrl: "https://prod.unicorn.org.cn/cephalon/user-center/v1/model",
        apiKey: "sk_test_cephalon",
      }),
    );
    expect(pluginConfig?.whisper).toEqual(
      expect.objectContaining({
        provider: "zhipu",
        zhipuApiBaseUrl: "https://prod.unicorn.org.cn/cephalon/user-center/v1/model",
        zhipuApiKey: "sk_test_cephalon",
      }),
    );
  });

  it("does not overwrite multimodal-rag keys when the configured endpoints are not cephalon", () => {
    const next = applyLucyProvisioningConfig(
      {
        plugins: {
          entries: {
            "multimodal-rag": {
              enabled: true,
              config: {
                ollama: {
                  baseUrl: "http://127.0.0.1:11434",
                  apiKey: "keep_ollama_key",
                },
                whisper: {
                  provider: "zhipu",
                  zhipuApiBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
                  zhipuApiKey: "keep_zhipu_key",
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      {
        providerId: "cephalon",
        modelId: "kimi-k2.5",
        apiKey: "sk_test_cephalon",
        baseUrl: "https://prod.unicorn.org.cn/cephalon/user-center/v1/model",
        switchDefaultModel: true,
      },
    );

    const pluginConfig = (next.plugins?.entries?.["multimodal-rag"] as { config?: Record<string, any> })?.config;
    expect(pluginConfig?.ollama).toEqual(
      expect.objectContaining({
        baseUrl: "http://127.0.0.1:11434",
        apiKey: "keep_ollama_key",
      }),
    );
    expect(pluginConfig?.whisper).toEqual(
      expect.objectContaining({
        provider: "zhipu",
        zhipuApiBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
        zhipuApiKey: "keep_zhipu_key",
      }),
    );
  });

  it("skips multimodal-rag key propagation when the plugin entry is disabled", () => {
    const next = applyLucyProvisioningConfig(
      {
        plugins: {
          entries: {
            "multimodal-rag": {
              enabled: false,
              config: {
                ollama: {
                  baseUrl: "https://prod.unicorn.org.cn/cephalon/user-center/v1/model",
                },
                whisper: {
                  provider: "zhipu",
                  zhipuApiBaseUrl: "https://prod.unicorn.org.cn/cephalon/user-center/v1/model",
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      {
        providerId: "cephalon",
        modelId: "kimi-k2.5",
        apiKey: "sk_test_cephalon",
        baseUrl: "https://prod.unicorn.org.cn/cephalon/user-center/v1/model",
        switchDefaultModel: true,
      },
    );

    const pluginConfig = (next.plugins?.entries?.["multimodal-rag"] as { config?: Record<string, any> })?.config;
    expect(pluginConfig?.ollama).toEqual(
      expect.objectContaining({
        baseUrl: "https://prod.unicorn.org.cn/cephalon/user-center/v1/model",
      }),
    );
    expect(pluginConfig?.ollama?.apiKey).toBeUndefined();
    expect(pluginConfig?.whisper).toEqual(
      expect.objectContaining({
        provider: "zhipu",
        zhipuApiBaseUrl: "https://prod.unicorn.org.cn/cephalon/user-center/v1/model",
      }),
    );
    expect(pluginConfig?.whisper?.zhipuApiKey).toBeUndefined();
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
