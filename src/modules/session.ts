import {
  MCPServerLike,
  ServerClientInfoLike,
  SessionInfo,
  UserIdentity,
} from "../types.js";
import packageJson from "../../package.json" with { type: "json" };

import {
  META_CLIENT_INFO_KEY,
  META_PROTOCOL_VERSION_KEY,
} from "./constants.js";

function narrowClientInfo(value: unknown): ServerClientInfoLike | undefined {
  if (
    value &&
    typeof value === "object" &&
    (typeof (value as any).name === "string" ||
      typeof (value as any).version === "string")
  ) {
    const v = value as { name?: unknown; version?: unknown };
    // Narrow per field: a non-string name/version must not reach the payload.
    return {
      name: typeof v.name === "string" ? v.name : undefined,
      version: typeof v.version === "string" ? v.version : undefined,
    };
  }
  return undefined;
}

/**
 * Client identity, resolved per request and never cached by us:
 * 1. ctx.mcpReq.envelope["io.modelcontextprotocol/clientInfo"] — v2 lifts
 *    the reserved io.modelcontextprotocol/* keys out of _meta before
 *    dispatch, verbatim under their fully-qualified names; the envelope is
 *    the only place they exist on a v2 server.
 * 2. _meta clientInfo — v1 passes the keys through untouched.
 * 3. server.getClientVersion() — legacy initialize capture (backfilled from
 *    the envelope by v2's createMcpHandler; undefined on 2026-pinned stdio).
 */
export function getClientInfoForRequest(
  server: MCPServerLike,
  request: any,
  extra?: unknown,
): ServerClientInfoLike | undefined {
  const fromEnvelope = narrowClientInfo(
    (extra as any)?.mcpReq?.envelope?.[META_CLIENT_INFO_KEY],
  );
  if (fromEnvelope) return fromEnvelope;
  const fromMeta = narrowClientInfo(
    request?.params?._meta?.[META_CLIENT_INFO_KEY],
  );
  if (fromMeta) return fromMeta;
  return server.getClientVersion();
}

export function getProtocolVersion(
  request: any,
  extra?: unknown,
): string | undefined {
  const env = (extra as any)?.mcpReq?.envelope?.[META_PROTOCOL_VERSION_KEY];
  if (typeof env === "string" && env.length > 0) return env;
  const value = request?.params?._meta?.[META_PROTOCOL_VERSION_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Builds the session metadata stamped onto one event, from values resolved
 * for THIS request. Pure: reads the server, writes nothing.
 */
export function buildSessionInfo(
  server: MCPServerLike,
  identity: UserIdentity | null | undefined,
  clientInfo: ServerClientInfoLike | undefined,
): SessionInfo {
  return {
    ipAddress: undefined, // grab from django
    sdkLanguage: "TypeScript", // hardcoded for now
    agentcatVersion: packageJson.version,
    serverName: server._serverInfo?.name,
    serverVersion: server._serverInfo?.version,
    clientName: clientInfo?.name,
    clientVersion: clientInfo?.version,
    identifyActorGivenId: identity?.userId,
    identifyActorName: identity?.userName,
    identifyActorData: identity?.userData || {},
  };
}
