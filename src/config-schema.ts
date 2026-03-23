import { LucyConfigSchema } from "./types.js";
import { buildChannelConfigSchema } from "./plugin-sdk-compat.js";

export const lucyChannelConfigSchema = buildChannelConfigSchema(LucyConfigSchema);
