import type { ZodTypeAny } from "zod";

type Issue = { path: Array<string | number>; message: string };

type SafeParseResult =
  | { success: true; data?: unknown }
  | { success: false; error: { issues: Issue[] } };

type ZodSchemaWithToJsonSchema = ZodTypeAny & {
  toJSONSchema?: (params?: Record<string, unknown>) => unknown;
};

function schemaError(message: string): SafeParseResult {
  return { success: false, error: { issues: [{ path: [], message }] } };
}

export function emptyPluginConfigSchema() {
  return {
    safeParse(value: unknown): SafeParseResult {
      if (value === undefined) {
        return { success: true, data: undefined };
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return schemaError("expected config object");
      }
      if (Object.keys(value as Record<string, unknown>).length > 0) {
        return schemaError("config must be empty");
      }
      return { success: true, data: value };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  };
}

export function buildChannelConfigSchema(schema: ZodTypeAny) {
  const schemaWithJson = schema as ZodSchemaWithToJsonSchema;
  if (typeof schemaWithJson.toJSONSchema === "function") {
    return {
      schema: schemaWithJson.toJSONSchema({
        target: "draft-07",
        unrepresentable: "any",
      }) as Record<string, unknown>,
    };
  }

  return {
    schema: {
      type: "object",
      additionalProperties: true,
    },
  };
}

export function createPluginRuntimeStore<T>(errorMessage: string): {
  setRuntime: (next: T) => void;
  clearRuntime: () => void;
  tryGetRuntime: () => T | null;
  getRuntime: () => T;
} {
  let runtime: T | null = null;

  return {
    setRuntime(next: T) {
      runtime = next;
    },
    clearRuntime() {
      runtime = null;
    },
    tryGetRuntime() {
      return runtime;
    },
    getRuntime() {
      if (!runtime) {
        throw new Error(errorMessage);
      }
      return runtime;
    },
  };
}

export function createDefaultChannelRuntimeState<T extends Record<string, unknown>>(
  accountId: string,
  extra?: T,
): {
  accountId: string;
  running: false;
  lastStartAt: null;
  lastStopAt: null;
  lastError: null;
} & T {
  return {
    accountId,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
    ...(extra ?? ({} as T)),
  };
}

export function collectStatusIssuesFromLastError(
  channel: string,
  accounts: Array<{ accountId: string; lastError?: unknown }>,
) {
  return accounts.flatMap((account) => {
    const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
    if (!lastError) {
      return [];
    }
    return [
      {
        channel,
        accountId: account.accountId,
        kind: "runtime" as const,
        message: `Channel error: ${lastError}`,
      },
    ];
  });
}
