import type { PluginRuntime } from "openclaw/plugin-sdk";
import { createPluginRuntimeStore } from "./plugin-sdk-compat.js";

const { getRuntime: getLucyRuntime, setRuntime: setLucyRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Lucy runtime not initialized");

export { getLucyRuntime, setLucyRuntime };
