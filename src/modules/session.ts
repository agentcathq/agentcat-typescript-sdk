import {
  AgentCatData,
  MCPServerLike,
  ServerClientInfoLike,
  SessionInfo,
  CompatibleRequestHandlerExtra,
} from "../types.js";
import { getServerTrackingData, setServerTrackingData } from "./internal.js";
import KSUID from "../thirdparty/ksuid/index.js";
import packageJson from "../../package.json" with { type: "json" };
import { createHash } from "crypto";

import { INACTIVITY_TIMEOUT_IN_MINUTES } from "./constants.js";

export function newSessionId(): string {
  return KSUID.withPrefix("ses").randomSync();
}

/**
 * Creates a deterministic KSUID session ID from an MCP sessionId and optional projectId.
 * The same inputs will always produce the same session ID, enabling correlation across server restarts.
 *
 * @param mcpSessionId - The session ID from the MCP protocol
 * @param projectId - Optional AgentCat project ID to include in the hash
 * @returns A KSUID with "ses" prefix derived deterministically from the inputs
 */
export function deriveSessionIdFromMCPSession(
  mcpSessionId: string,
  projectId?: string,
): string {
  // Create input string for hashing
  const input = projectId ? `${mcpSessionId}:${projectId}` : mcpSessionId;

  // Hash the input with SHA-256
  const hash = createHash("sha256").update(input).digest();

  // Extract timestamp from first 4 bytes of hash (for deterministic but reasonable timestamp)
  // We'll use a fixed epoch (2024-01-01) plus the hash value to get a deterministic but valid timestamp
  const EPOCH_2024 = new Date("2024-01-01T00:00:00Z").getTime();
  const timestampOffset = hash.readUInt32BE(0) % (365 * 24 * 60 * 60 * 1000); // Max 1 year offset
  const timestamp = EPOCH_2024 + timestampOffset;

  // Use the remaining 16 bytes of hash as the KSUID payload
  const payload = hash.subarray(4, 20);

  // Create deterministic KSUID with prefix
  return KSUID.withPrefix("ses").fromParts(timestamp, payload);
}

/**
 * Gets or generates a session ID for the server.
 * Prioritizes MCP protocol sessionId over AgentCat-generated sessionId.
 *
 * @param server - The MCP server instance
 * @param extra - Optional extra data containing MCP sessionId
 * @returns The session ID to use for events
 */
export function getServerSessionId(
  server: MCPServerLike,
  extra?: CompatibleRequestHandlerExtra,
): string {
  const data = getServerTrackingData(server);

  if (!data) {
    throw new Error("Server tracking data not found");
  }

  const mcpSessionId = extra?.sessionId;

  // If MCP sessionId is provided
  if (mcpSessionId) {
    // Derive deterministic KSUID from MCP sessionId
    data.sessionId = deriveSessionIdFromMCPSession(
      mcpSessionId,
      data.projectId || undefined,
    );
    data.lastMcpSessionId = mcpSessionId;
    data.sessionSource = "mcp";
    setServerTrackingData(server, data);
    // If MCP sessionId hasn't changed, continue using the existing derived KSUID
    setLastActivity(server);
    return data.sessionId;
  }

  // No MCP sessionId provided - handle AgentCat-generated sessions
  // If we had an MCP sessionId before but it disappeared, keep using the last derived ID
  if (data.sessionSource === "mcp" && data.lastMcpSessionId) {
    setLastActivity(server);
    return data.sessionId;
  }

  // For AgentCat-generated sessions, apply timeout logic
  const now = Date.now();
  const timeoutMs = INACTIVITY_TIMEOUT_IN_MINUTES * 60 * 1000;
  // If last activity timed out
  if (now - data.lastActivity.getTime() > timeoutMs) {
    data.sessionId = newSessionId();
    data.sessionSource = "agentcat";
    setServerTrackingData(server, data);
  }
  setLastActivity(server);

  return data.sessionId;
}

export function setLastActivity(server: MCPServerLike): void {
  const data = getServerTrackingData(server);

  if (!data) {
    throw new Error("Server tracking data not found");
  }

  data.lastActivity = new Date();
  setServerTrackingData(server, data);
}

export function getSessionInfo(
  server: MCPServerLike,
  data: AgentCatData | undefined,
): SessionInfo {
  let clientInfo: ServerClientInfoLike | undefined = {
    name: undefined,
    version: undefined,
  };
  if (!data?.sessionInfo.clientName) {
    clientInfo = server.getClientVersion();
  }
  const sessionInfo: SessionInfo = {
    ipAddress: undefined, // grab from django
    sdkLanguage: "TypeScript", // hardcoded for now
    agentcatVersion: packageJson.version,
    serverName: server._serverInfo?.name,
    serverVersion: server._serverInfo?.version,
    clientName: clientInfo?.name,
    clientVersion: clientInfo?.version,
  };

  if (!data) {
    return sessionInfo;
  }

  data.sessionInfo = sessionInfo;
  setServerTrackingData(server, data);
  return data.sessionInfo;
}
