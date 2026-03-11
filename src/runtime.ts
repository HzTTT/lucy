import type { PluginRuntime } from "openclaw/plugin-sdk";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";

const { getRuntime: getLucyRuntime, setRuntime: setLucyRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Lucy runtime not initialized");

export { getLucyRuntime, setLucyRuntime };
