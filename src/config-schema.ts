import { buildChannelConfigSchema } from "openclaw/plugin-sdk";
import { LucyConfigSchema } from "./types.js";

export const lucyChannelConfigSchema = buildChannelConfigSchema(LucyConfigSchema);
