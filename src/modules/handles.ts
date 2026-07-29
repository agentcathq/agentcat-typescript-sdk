import { createHash } from "crypto";
import KSUID from "../thirdparty/ksuid/index.js";
import { AgentCatData, CompatibleRequestHandlerExtra } from "../types.js";
import { MCP_INSTRUCTIONS_PREFIX } from "./constants.js";
import { writeToLog } from "./logging.js";

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

export type HandleSource = "hook" | "supplied" | "minted";

/** An agent ID is never resolved from a hook — only supplied or minted. */
export type AgentIdSource = "supplied" | "minted";

/** Tag naming the parameter a customer tool declares as its own. */
export const HANDLE_COLLISION_TAG = "agentcat_handle_collision";

/**
 * Whether the called tool declares `task_id`/`agent_id` itself (see
 * `toolDeclaresHandle`). Pass the colliding parameter name when the caller
 * knows it — the high-level path reads the tool's own schema — or `true` when
 * it only knows that the tool collides, which is all the low-level path can
 * learn from `AgentCatData.handleCollisionTools`.
 */
export type HandleOwnership = boolean | string;

/**
 * The handles for one request.
 *
 * `agentId` and `agentIdSource` are one inseparable unit: either agent tracking
 * resolved both, or neither is present. Splitting them would let a caller claim
 * an agent ID was minted without saying which one, which is exactly the state
 * `buildMintBackText` silently degrades on.
 */
export type ResolvedHandles = {
  taskId: string;
  taskIdSource: HandleSource;
  /** Present only for the collision case; merged into the event's tags. */
  tags?: Record<string, string>;
} & (
  | { agentId: string; agentIdSource: AgentIdSource }
  | { agentId?: undefined; agentIdSource?: undefined }
);

/**
 * Resolves both handles for a single request. Entirely stateless — nothing is
 * read from or written to the server between requests, which is what makes
 * concurrent tool calls safe.
 *
 * Task ID precedence: the `resolveTaskId` hook (derived deterministically), then
 * the agent-supplied `task_id` taken verbatim, then a freshly minted one. A hook
 * that throws or returns nothing falls through to the rest of the chain rather
 * than failing the call, matching how `eventTags` degrades.
 */
export async function resolveHandles(
  data: AgentCatData,
  request: any,
  extra?: CompatibleRequestHandlerExtra,
  ownsHandle: HandleOwnership = false,
): Promise<ResolvedHandles> {
  // A tool that declares its own task_id/agent_id owns those arguments: reading
  // them would poison correlation with a value that means something else.
  const args = ownsHandle ? undefined : request?.params?.arguments;

  let taskId: string | undefined;
  let taskIdSource: HandleSource = "minted";

  if (data.options.resolveTaskId) {
    try {
      const supplied = await data.options.resolveTaskId(request, extra);
      if (typeof supplied === "string" && supplied.trim().length > 0) {
        taskId = deriveTaskId(supplied.trim(), data.projectId || undefined);
        taskIdSource = "hook";
      }
    } catch (error) {
      writeToLog(`resolveTaskId callback error: ${error}`);
    }
  }

  if (!taskId) {
    const supplied = extractHandle(args, TASK_ID_PARAM);
    if (supplied) {
      taskId = supplied;
      taskIdSource = "supplied";
    } else {
      taskId = newTaskId();
      taskIdSource = "minted";
    }
  }

  const tags = ownsHandle
    ? {
        [HANDLE_COLLISION_TAG]:
          typeof ownsHandle === "string"
            ? ownsHandle
            : `${TASK_ID_PARAM}|${AGENT_ID_PARAM}`,
      }
    : undefined;

  if (!(data.options.enableAgentTracking ?? true)) {
    return { taskId, taskIdSource, ...(tags ? { tags } : {}) };
  }

  const suppliedAgentId = extractHandle(args, AGENT_ID_PARAM);
  return {
    taskId,
    taskIdSource,
    ...(tags ? { tags } : {}),
    agentId: suppliedAgentId ?? newAgentId(),
    agentIdSource: suppliedAgentId ? "supplied" : "minted",
  };
}

export interface MintBackInput {
  taskId: string;
  taskIdMinted: boolean;
  agentId?: string;
  agentIdMinted: boolean;
}

const TASK_LINE = (taskId: string) =>
  `  task_id=${taskId} — identifies the whole goal. You MUST pass this to any subagent you spawn, or its work is severed from yours.`;

const AGENT_LINE = (agentId: string) =>
  `  agent_id=${agentId} — identifies you alone. Never pass this to a subagent; a new subagent MUST omit agent_id so the server can issue it its own.`;

const TASK_CLOSER =
  "Without task_id, this server does not function as intended.";

/**
 * Builds the block appended to a tool result when a handle was minted. Returns
 * undefined when nothing was minted — the common case once an agent complies.
 */
export function buildMintBackText(input: MintBackInput): string | undefined {
  const { taskId, taskIdMinted, agentId, agentIdMinted } = input;

  if (taskIdMinted && agentIdMinted && agentId) {
    return [
      `${MCP_INSTRUCTIONS_PREFIX}: Handles issued. This server requires both on every subsequent tool call — a call that omits them cannot be associated with this task.`,
      TASK_LINE(taskId),
      AGENT_LINE(agentId),
      TASK_CLOSER,
    ].join("\n");
  }

  if (agentIdMinted && agentId) {
    // Subagent case: it is already complying on task_id, so confirm receipt
    // rather than telling it the server is malfunctioning.
    return [
      `${MCP_INSTRUCTIONS_PREFIX}: Handle issued. This server requires it on every subsequent tool call — a call that omits it cannot be attributed to you.`,
      AGENT_LINE(agentId),
      `Your task_id=${taskId} was accepted. Keep sending it unchanged.`,
    ].join("\n");
  }

  if (taskIdMinted) {
    return [
      `${MCP_INSTRUCTIONS_PREFIX}: Handle issued. This server requires it on every subsequent tool call — a call that omits it cannot be associated with this task.`,
      TASK_LINE(taskId),
      TASK_CLOSER,
    ].join("\n");
  }

  return undefined;
}
