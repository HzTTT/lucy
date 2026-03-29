import type {
  ProviderAuthMethod,
  ProviderCatalogContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-models";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-models";

export const LUCY_CEPHALON_PROVIDER_ID = "cephalon";
export const LUCY_CEPHALON_BASE_URL = "https://prod.unicorn.org.cn/cephalon/user-center/v1/model";
export const LUCY_CEPHALON_DEFAULT_MODEL_ID = "kimi-k2.5";
export const LUCY_CEPHALON_DEFAULT_MODEL_REF = `${LUCY_CEPHALON_PROVIDER_ID}/${LUCY_CEPHALON_DEFAULT_MODEL_ID}`;

const LUCY_CEPHALON_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const LUCY_CEPHALON_MODEL_CATALOG = [
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    reasoning: false,
    input: ["text", "image"],
    cost: LUCY_CEPHALON_DEFAULT_COST,
    contextWindow: 262144,
    maxTokens: 32768,
  },
] as const;

export function buildLucyCephalonCatalogProvider(): ModelProviderConfig {
  return {
    baseUrl: LUCY_CEPHALON_BASE_URL,
    api: "openai-completions",
    models: LUCY_CEPHALON_MODEL_CATALOG.map((model) => ({ ...model, input: [...model.input] })),
  };
}

export function buildLucyCephalonModelDefinition(modelId: string): Record<string, unknown> {
  if (modelId === LUCY_CEPHALON_DEFAULT_MODEL_ID) {
    return { ...LUCY_CEPHALON_MODEL_CATALOG[0] };
  }
  return {
    id: modelId,
    name: modelId,
    reasoning: false,
    input: ["text"],
    cost: LUCY_CEPHALON_DEFAULT_COST,
    contextWindow: 131072,
    maxTokens: 16384,
  };
}

export function buildLucyCephalonProvider(): ProviderPlugin {
  const auth: ProviderAuthMethod = {
    id: "api-key",
    label: "Cephalon API key",
    hint: "Hosted Kimi K2.5",
    kind: "api_key",
    wizard: {
      choiceId: "cephalon-api-key",
      choiceLabel: "Cephalon API key",
      groupId: LUCY_CEPHALON_PROVIDER_ID,
      groupLabel: "Cephalon",
      groupHint: "Hosted Kimi K2.5",
    },
    run: async () => {
      throw new Error(
        "Cephalon credentials are provisioned by Lucy. Use the Lucy app model configuration flow instead.",
      );
    },
    runNonInteractive: async () => null,
  };

  return {
    id: LUCY_CEPHALON_PROVIDER_ID,
    label: "Cephalon",
    docsPath: "/providers/models",
    envVars: ["CEPHALON_API_KEY"],
    auth: [auth],
    catalog: {
      order: "simple",
      run: async (ctx: ProviderCatalogContext) => {
        const explicitProvider = ctx.config.models?.providers?.[LUCY_CEPHALON_PROVIDER_ID];
        const resolved = buildLucyCephalonCatalogProvider();
        const apiKey = ctx.resolveProviderApiKey(LUCY_CEPHALON_PROVIDER_ID).apiKey;
        return {
          provider: {
            ...resolved,
            ...(typeof explicitProvider?.baseUrl === "string" && explicitProvider.baseUrl.trim()
              ? { baseUrl: explicitProvider.baseUrl.trim() }
              : {}),
            ...(apiKey
              ? { apiKey }
              : typeof explicitProvider?.apiKey === "string" && explicitProvider.apiKey.trim()
                ? { apiKey: explicitProvider.apiKey.trim() }
                : {}),
          },
        };
      },
    },
  };
}
