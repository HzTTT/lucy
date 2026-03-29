import { describe, expect, it } from "vitest";
import {
  buildLucyCephalonProvider,
  LUCY_CEPHALON_DEFAULT_MODEL_REF,
} from "./cephalon-provider.js";

describe("lucy embedded cephalon provider", () => {
  it("exposes the cephalon provider with kimi-k2.5 as the default embedded model", async () => {
    const provider = buildLucyCephalonProvider();

    expect(provider.id).toBe("cephalon");
    expect(provider.label).toBe("Cephalon");
    expect(provider.catalog?.run).toBeTypeOf("function");
    expect(provider.envVars).toEqual(["CEPHALON_API_KEY"]);
    expect(provider.auth[0]).toEqual(
      expect.objectContaining({
        id: "api-key",
        kind: "api_key",
      }),
    );
    const result = await provider.catalog?.run?.({
      config: {},
      resolveProviderApiKey: () => ({ apiKey: undefined, discoveryApiKey: undefined }),
    } as never);
    if (!result || !("provider" in result)) {
      throw new Error("expected single provider catalog result");
    }
    expect(result.provider).toEqual(
      expect.objectContaining({
        baseUrl: "https://prod.unicorn.org.cn/cephalon/user-center/v1/model",
        api: "openai-completions",
        models: expect.arrayContaining([
          expect.objectContaining({ id: "kimi-k2.5", name: "Kimi K2.5" }),
        ]),
      }),
    );
  });
});
