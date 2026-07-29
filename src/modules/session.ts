import {
  AgentCatData,
  MCPServerLike,
  ServerClientInfoLike,
  SessionInfo,
} from "../types.js";
import { setServerTrackingData } from "./internal.js";
import packageJson from "../../package.json" with { type: "json" };

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
