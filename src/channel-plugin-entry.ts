import type {
  ChannelPlugin,
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
} from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "./plugin-sdk-compat.js";

type LucyChannelPluginEntryOptions<TPlugin> = {
  id: string;
  name: string;
  description: string;
  plugin: TPlugin;
  configSchema?: OpenClawPluginConfigSchema | (() => OpenClawPluginConfigSchema);
  setRuntime?: (runtime: OpenClawPluginApi["runtime"]) => void;
  registerFull?: (api: OpenClawPluginApi) => void;
};

type LucyRegistrationModeApi = OpenClawPluginApi & {
  registrationMode?: string;
};

function resolveConfigSchema(
  configSchema: LucyChannelPluginEntryOptions<unknown>["configSchema"] = emptyPluginConfigSchema,
) {
  return typeof configSchema === "function" ? configSchema() : configSchema;
}

export function defineLucyChannelPluginEntry<TPlugin>({
  id,
  name,
  description,
  plugin,
  configSchema = emptyPluginConfigSchema,
  setRuntime,
  registerFull,
}: LucyChannelPluginEntryOptions<TPlugin>) {
  return {
    id,
    name,
    description,
    configSchema: resolveConfigSchema(configSchema),
    register(api: OpenClawPluginApi) {
      setRuntime?.(api.runtime);
      api.registerChannel({ plugin: plugin as ChannelPlugin });
      const registrationMode = (api as LucyRegistrationModeApi).registrationMode ?? "full";
      if (registrationMode !== "full") {
        return;
      }
      registerFull?.(api);
    },
  };
}
