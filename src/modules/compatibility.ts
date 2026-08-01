import { HighLevelMCPServerLike, MCPServerLike } from "../types.js";
import { detectServer, fingerprintServerShape } from "../detect.js";
import { writeToLog } from "./logging.js";

/**
 * AgentCat Compatibility Module
 *
 * Ensures compatibility with the Model Context Protocol TypeScript SDK.
 * AgentCat supports SDK v1.11+ (@modelcontextprotocol/sdk) and v2
 * (@modelcontextprotocol/server). Flavor/major discrimination is owned by
 * detectServer(); this module validates the detected low-level server's
 * internals and produces every compatibility-facing error message.
 */

export const SUPPORT_MATRIX_SUFFIX =
  "AgentCat supports MCP TypeScript SDK v1.11+ (@modelcontextprotocol/sdk) and v2 (@modelcontextprotocol/server).";

// Function to log compatibility information
export function logCompatibilityWarning(): void {
  writeToLog(`AgentCat SDK Compatibility: ${SUPPORT_MATRIX_SUFFIX}`);
}

// Check if server has high-level structure (wrapper with .server property)
export function isHighLevelServer(server: any): boolean {
  return (
    server &&
    typeof server === "object" &&
    server.server &&
    typeof server.server === "object"
  );
}

// Check if server has low-level structure (no .server property)
export function isLowLevelServer(server: any): boolean {
  return server && typeof server === "object" && !server.server;
}

// Type guard function that validates server compatibility and returns typed server
export function isCompatibleServerType(
  server: any,
): MCPServerLike | HighLevelMCPServerLike {
  const detection = detectServer(server);
  if (!detection) {
    // Shape-fingerprint beacon: the signals detection computed, preserved in
    // the diagnostics sink so fleet change-detection can spot a new SDK shape.
    writeToLog(
      `AgentCat SDK Compatibility: unrecognized server shape | signals ${fingerprintServerShape(server) || "(none)"}. ${SUPPORT_MATRIX_SUFFIX}`,
    );
    throw new Error(
      `AgentCat SDK compatibility error: server object does not match any supported MCP SDK shape. ${SUPPORT_MATRIX_SUFFIX}`,
    );
  }
  validateLowLevelServer(detection.lowLevel);
  return detection.highLevel ?? detection.lowLevel;
}

// Helper function to validate low-level server requirements
function validateLowLevelServer(server: any): void {
  if (typeof server.setRequestHandler !== "function") {
    logCompatibilityWarning();
    throw new Error(
      "AgentCat SDK compatibility error: Server must have a setRequestHandler method. " +
        SUPPORT_MATRIX_SUFFIX,
    );
  }

  if (!server._requestHandlers || !(server._requestHandlers instanceof Map)) {
    logCompatibilityWarning();
    throw new Error(
      "AgentCat SDK compatibility error: Server._requestHandlers is not accessible. " +
        SUPPORT_MATRIX_SUFFIX,
    );
  }

  // Validate that _requestHandlers contains functions with compatible signatures
  if (typeof server._requestHandlers.get !== "function") {
    logCompatibilityWarning();
    throw new Error(
      "AgentCat SDK compatibility error: Server._requestHandlers must be a Map with a get method. " +
        SUPPORT_MATRIX_SUFFIX,
    );
  }

  if (typeof server.getClientVersion !== "function") {
    logCompatibilityWarning();
    throw new Error(
      "AgentCat SDK compatibility error: Server.getClientVersion must be a function. " +
        SUPPORT_MATRIX_SUFFIX,
    );
  }

  if (
    !server._serverInfo ||
    typeof server._serverInfo !== "object" ||
    !server._serverInfo.name
  ) {
    logCompatibilityWarning();
    throw new Error(
      "AgentCat SDK compatibility error: Server._serverInfo is not accessible or missing name. " +
        SUPPORT_MATRIX_SUFFIX,
    );
  }
}

export function getMCPCompatibleErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    try {
      return JSON.stringify(error, Object.getOwnPropertyNames(error));
    } catch {
      return "Unknown error";
    }
  } else if (typeof error === "string") {
    return error;
  } else if (typeof error === "object" && error !== null) {
    return JSON.stringify(error);
  }
  return "Unknown error";
}
