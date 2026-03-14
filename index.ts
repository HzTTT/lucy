import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { lucyPlugin } from "./src/channel.js";
import { registerLucyCommand } from "./src/command.js";
import { setLucyRuntime } from "./src/runtime.js";

const plugin = {
  id: "lucy",
  name: "Lucy",
  description: "Lucy NATS DM channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setLucyRuntime(api.runtime);
    api.registerChannel({ plugin: lucyPlugin as ChannelPlugin });
    registerLucyCommand(api);
  },
};

export default plugin;
