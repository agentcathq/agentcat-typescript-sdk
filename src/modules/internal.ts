import {
  AgentCatData,
  MCPServerLike,
  UserIdentity,
  CompatibleRequestHandlerExtra,
} from "../types.js";
import { writeToLog } from "./logging.js";
import { validateTags } from "./validation.js";

// Internal tracking storage
const _serverTracking = new WeakMap<MCPServerLike, AgentCatData>();

export function getServerTrackingData(
  server: MCPServerLike,
): AgentCatData | undefined {
  return _serverTracking.get(server);
}

export function setServerTrackingData(
  server: MCPServerLike,
  data: AgentCatData,
): void {
  _serverTracking.set(server, data);
}

/**
 * Resolves the eventTags callback, validates the result, and returns validated tags.
 * Returns null if no callback configured, callback returns nullish, or callback throws.
 */
export async function resolveEventTags(
  data: AgentCatData,
  request: any,
  extra?: CompatibleRequestHandlerExtra,
): Promise<Record<string, string> | null> {
  if (!data.options.eventTags) return null;
  try {
    const raw = (await data.options.eventTags(request, extra)) ?? null;
    if (!raw) return null;
    return validateTags(raw);
  } catch (e) {
    writeToLog(`eventTags callback error: ${e}`);
    return null;
  }
}

/**
 * Resolves the eventProperties callback and returns the result.
 * Returns null if no callback configured, callback returns nullish, or callback throws.
 */
export async function resolveEventProperties(
  data: AgentCatData,
  request: any,
  extra?: CompatibleRequestHandlerExtra,
): Promise<Record<string, any> | null> {
  if (!data.options.eventProperties) return null;
  try {
    return (await data.options.eventProperties(request, extra)) ?? null;
  } catch (e) {
    writeToLog(`eventProperties callback error: ${e}`);
    return null;
  }
}

/**
 * Runs the customer's identify callback for this request and returns the
 * result. No cache, no identify event, no server mutation — the caller stamps
 * the identity onto the event it is building. Never throws.
 */
export async function resolveIdentity(
  data: AgentCatData,
  request: any,
  extra?: CompatibleRequestHandlerExtra,
): Promise<UserIdentity | null> {
  if (!data.options.identify) return null;
  try {
    return (await data.options.identify(request, extra)) ?? null;
  } catch (error) {
    writeToLog(`Error: identify callback threw - ${error}`);
    return null;
  }
}
