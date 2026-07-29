import { createHash } from "crypto";
import KSUID from "../thirdparty/ksuid/index.js";

export const TASK_ID_PARAM = "task_id";
export const AGENT_ID_PARAM = "agent_id";

export function newTaskId(): string {
  return KSUID.withPrefix("ses").randomSync();
}

export function newAgentId(): string {
  return KSUID.withPrefix("agt").randomSync();
}

/**
 * Deterministic Task ID from a customer-supplied identifier. The same id plus
 * the same project always yields the same Task ID, across processes and
 * restarts. Carries over the construction previously used for MCP session ids.
 */
export function deriveTaskId(id: string, projectId?: string): string {
  const input = projectId ? `${id}:${projectId}` : id;
  const hash = createHash("sha256").update(input).digest();

  const EPOCH_2024 = new Date("2024-01-01T00:00:00Z").getTime();
  const timestampOffset = hash.readUInt32BE(0) % (365 * 24 * 60 * 60 * 1000);
  const timestamp = EPOCH_2024 + timestampOffset;
  const payload = hash.subarray(4, 20);

  return KSUID.withPrefix("ses").fromParts(timestamp, payload);
}

/**
 * Reads a handle out of tool arguments. Supplied handles are trusted verbatim —
 * trimmed only, never shape-validated — so a caller can thread its own
 * correlation id straight through.
 */
export function extractHandle(
  args: unknown,
  param: string,
): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>)[param];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function stripHandles(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const record = args as Record<string, unknown>;
  if (!(TASK_ID_PARAM in record) && !(AGENT_ID_PARAM in record)) return args;
  const {
    [TASK_ID_PARAM]: _taskId,
    [AGENT_ID_PARAM]: _agentId,
    ...rest
  } = record;
  return rest;
}

export function cloneRequestWithoutHandles<
  TRequest extends { params?: { arguments?: unknown; [k: string]: unknown } },
>(request: TRequest): TRequest {
  if (!request.params || typeof request.params !== "object") return request;
  const args = request.params.arguments;
  if (!args || typeof args !== "object") return request;
  return {
    ...request,
    params: {
      ...request.params,
      arguments: stripHandles(args) as typeof request.params.arguments,
    },
  };
}
