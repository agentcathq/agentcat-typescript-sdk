import { VersionAdapter } from "../engine/registry.js";

/**
 * v2 (@modelcontextprotocol/server): McpServer dispatch invokes
 * tool.executor(args, ctx) — a closure capturing the handler at
 * registration. Wrapping handler/callback is a silent no-op on v2;
 * executor is the property read live at dispatch time.
 */
export const v2Adapter: VersionAdapter = {
  major: 2,
  tapKeys: ["executor"],
};
