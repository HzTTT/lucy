import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { lucyPlugin } from "./src/channel.js";
import { defineLucyChannelPluginEntry } from "./src/channel-plugin-entry.js";
import { registerLucyCommand } from "./src/command.js";
import { setLucyRuntime } from "./src/runtime.js";

export { lucyPlugin } from "./src/channel.js";
export { setLucyRuntime } from "./src/runtime.js";

const plugin = defineLucyChannelPluginEntry({
  id: "lucy",
  name: "Lucy",
  description: "Lucy NATS DM channel plugin",
  plugin: lucyPlugin as ChannelPlugin,
  setRuntime: setLucyRuntime,
  registerFull(api) {
    registerLucyCommand(api);
  },
});

export default plugin satisfies {
  id: string;
  name: string;
  description: string;
  configSchema: unknown;
  register: (api: OpenClawPluginApi) => void;
};
