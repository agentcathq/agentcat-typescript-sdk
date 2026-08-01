import { VersionAdapter } from "../engine/registry.js";

/**
 * v1 (@modelcontextprotocol/sdk): McpServer dispatch reads tool.handler
 * (SDK 1.24+) or tool.callback (≤1.23) live from the registry entry.
 */
export const v1Adapter: VersionAdapter = {
  major: 1,
  tapKeys: ["handler", "callback"],
};
