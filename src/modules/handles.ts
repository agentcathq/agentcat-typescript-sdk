import { createHash } from "crypto";
import KSUID from "../thirdparty/ksuid/index.js";
import {
  MINT_BACK_HEADER_SESSION,
  MINT_BACK_CLOSER,
  mintBackSessionLine,
  MCP_INSTRUCTIONS_KEY,
  mintBackConfirmed,
  AGENTCAT_TAG_AGENT_ID,
  AGENTCAT_TAG_SESSION_SOURCE,
  AGENTCAT_TAG_AGENT_SOURCE,
  AGENTCAT_TAG_PROTOCOL_VERSION,
} from "./constants.js";
import { AgentCatOptions, CompatibleRequestHandlerExtra } from "../types.js";
import { writeToLog } from "./logging.js";

export const SESSION_ID_PARAM = "session_id";
export const AGENT_ID_PARAM = "agent_id";

export function newSessionId(): string {
  return KSUID.withPrefix("ses").randomSync();
}

/**
 * Deterministically derives a Session ID from a customer-supplied identifier.
 * The same id + project always yields the same ses_ KSUID, across processes
 * and restarts.
 *
 * @param id - The customer-supplied identifier to derive from
 * @param projectId - Optional AgentCat project ID to include in the hash
 * @returns A KSUID with "ses" prefix derived deterministically from the inputs
 */
export function deriveSessionId(id: string, projectId?: string): string {
  const input = projectId ? `${id}:${projectId}` : id;
  const hash = createHash("sha256").update(input).digest();

  // Fixed epoch plus a hash-derived offset (max 1 year) keeps the timestamp
  // deterministic while staying inside a valid KSUID range.
  const EPOCH_2024 = new Date("2024-01-01T00:00:00Z").getTime();
  const timestampOffset = hash.readUInt32BE(0) % (365 * 24 * 60 * 60 * 1000);
  const payload = hash.subarray(4, 20);

  return KSUID.withPrefix("ses").fromParts(
    EPOCH_2024 + timestampOffset,
    payload,
  );
}

/**
 * Reads a supplied handle off tool-call arguments. Trimmed, non-empty strings
 * only; anything else counts as "omitted". Values are trusted verbatim — no
 * shape validation.
 *
 * @param args - The tool call arguments, of unknown shape
 * @param name - The argument name to read (SESSION_ID_PARAM or AGENT_ID_PARAM)
 * @returns The trimmed handle, or undefined when absent or not a usable string
 */
export function extractHandle(args: unknown, name: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>)[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * True only for a session ID this SDK issued. Both issuing paths —
 * newSessionId() and deriveSessionId() — satisfy this by construction, so a
 * value that fails was invented by the agent or belongs to someone else.
 */
export function isValidSessionId(value: string): boolean {
  return /^ses_[0-9A-Za-z]{27}$/.test(value);
}

export type SessionSource =
  "hook" | "supplied" | "minted" | "invalid" | "foreign";
export type AgentSource = "supplied";

export interface HandleResolution {
  sessionId: string;
  sessionSource: SessionSource;
  /** True when resolveSessionId is configured: no task prompting anywhere. */
  hookMode: boolean;
  agentId?: string;
  agentSource?: AgentSource;
}

/**
 * Builds the [MCP INSTRUCTIONS] block for a task minted on this call. Returns
 * null when nothing needs announcing. Task instructions never appear in hook
 * mode — even when a hook-null forced a silent mint. agent_id is self-chosen
 * by the agent and never announced here.
 *
 * @param res - The resolved handles for this call
 * @returns The instruction block, or null when no task was minted
 */
export function buildMintBackText(res: HandleResolution): string | null {
  if (res.hookMode || res.sessionSource !== "minted") return null;
  return [
    MINT_BACK_HEADER_SESSION,
    mintBackSessionLine(res.sessionId),
    MINT_BACK_CLOSER,
  ].join("\n");
}

/**
 * Appends the mint-back block to a CallToolResult. Applies to isError results
 * too (the retry after an error must carry the same task). Only requirement:
 * an array `content`. Never mutates the input.
 *
 * @param result - The tool result to append to
 * @param text - The mint-back block to append as a text content block
 * @returns A shallow copy carrying the extra block, or the input untouched
 */
export function appendMintBack(result: any, text: string): any {
  if (!result || typeof result !== "object" || !Array.isArray(result.content)) {
    return result;
  }
  return { ...result, content: [...result.content, { type: "text", text }] };
}

export interface StructuredMintBack {
  session_id?: string;
  agent_id?: string;
  instructions: string;
}

/**
 * Builds the structured mint-back mirrored into structuredContent. Unlike
 * buildMintBackText (task-mint announcements only), this is persistent handle
 * state, present on EVERY response — supplied handles are re-confirmed, so an
 * agent can re-read its own session_id/agent_id mid-conversation. Handles the
 * agent cannot echo are never named: no session_id in hook mode, no agent_id
 * when the agent didn't supply one. Returns null when nothing is echoable.
 *
 * @param res - The resolved handles for this call
 * @returns The structured mint-back payload, or null
 */
export function buildStructuredMintBack(
  res: HandleResolution,
): StructuredMintBack | null {
  const names: string[] = [];
  if (!res.hookMode) names.push(SESSION_ID_PARAM);
  if (res.agentId) names.push(AGENT_ID_PARAM);
  if (names.length === 0) return null;
  return {
    ...(res.hookMode ? {} : { [SESSION_ID_PARAM]: res.sessionId }),
    ...(res.agentId ? { [AGENT_ID_PARAM]: res.agentId } : {}),
    instructions: buildMintBackText(res) ?? mintBackConfirmed(names),
  };
}

/**
 * Mirrors the structured mint-back into result.structuredContent. Requires a
 * plain-object structuredContent to extend; an already-present key is customer
 * data and always wins. Never mutates the input.
 *
 * @param result - The tool result to mirror into
 * @param mint - The structured mint-back payload
 * @returns A shallow copy carrying the field, or the input untouched
 */
export function mirrorStructuredMintBack(
  result: any,
  mint: StructuredMintBack,
): any {
  const sc = result?.structuredContent;
  if (!sc || typeof sc !== "object" || Array.isArray(sc)) return result;
  if (MCP_INSTRUCTIONS_KEY in sc) return result;
  return {
    ...result,
    structuredContent: { ...sc, [MCP_INSTRUCTIONS_KEY]: mint },
  };
}

/**
 * Builds the SDK-owned tags for a call. Applied AFTER validateTags(customerTags)
 * — these are exempt from the 50-tag cap.
 *
 * @param res - The resolved handles for this call
 * @param protocolVersion - Optional negotiated MCP protocol version
 * @returns The tag map to merge over customer tags
 */
export function buildHandleTags(
  res: HandleResolution,
  protocolVersion?: string,
): Record<string, string> {
  const tags: Record<string, string> = {
    [AGENTCAT_TAG_SESSION_SOURCE]: res.sessionSource,
  };
  if (res.agentId && res.agentSource) {
    // Tag channel contract: SDK tags bypass validateTags/redaction/truncation,
    // so the tag copy is clamped (200 chars, newlines -> space). The handle
    // itself (resolution, Event.sessionId) stays verbatim.
    tags[AGENTCAT_TAG_AGENT_ID] = res.agentId
      .replace(/[\r\n]/g, " ")
      .slice(0, 200);
    tags[AGENTCAT_TAG_AGENT_SOURCE] = res.agentSource;
  }
  if (protocolVersion) tags[AGENTCAT_TAG_PROTOCOL_VERSION] = protocolVersion;
  return tags;
}

/**
 * Resolves both handles for one request. Stateless: nothing is stored on the
 * server, so concurrent requests cannot clobber each other.
 *
 * @param options - The AgentCat options; resolveSessionId selects hook mode
 * @param projectId - Optional AgentCat project ID, used when deriving in hook mode
 * @param request - The MCP request whose arguments may carry supplied handles
 * @param extra - Optional MCP request handler extra, forwarded to the hook
 * @returns The resolved handles for this call
 */
export async function resolveHandles(
  options: AgentCatOptions,
  projectId: string | undefined,
  request: any,
  extra?: CompatibleRequestHandlerExtra,
): Promise<HandleResolution> {
  const args = request?.params?.arguments;
  const hookMode = typeof options.resolveSessionId === "function";

  let sessionId: string;
  let sessionSource: SessionSource;

  if (hookMode) {
    let hookValue: string | null = null;
    try {
      hookValue = (await options.resolveSessionId!(request, extra)) ?? null;
    } catch (error) {
      writeToLog(`resolveSessionId hook error: ${error}`);
    }
    if (typeof hookValue === "string" && hookValue.trim().length > 0) {
      sessionId = deriveSessionId(hookValue.trim(), projectId);
      sessionSource = "hook";
    } else {
      // Hook contract violation: no parameter exists in hook mode, so the
      // agent can never learn this ID. One single-event task per null return.
      sessionId = newSessionId();
      sessionSource = "minted";
    }
  } else {
    const supplied = extractHandle(args, SESSION_ID_PARAM);
    if (supplied) {
      sessionId = supplied;
      sessionSource = "supplied";
    } else {
      sessionId = newSessionId();
      sessionSource = "minted";
    }
  }

  const resolution: HandleResolution = {
    sessionId,
    sessionSource,
    hookMode,
  };

  // agent_id is self-chosen by the agent (schema-required when tracking is
  // on). Soft enforcement: an omitted agent_id never rejects the call — the
  // event is simply published without agent identity.
  if (options.enableAgentTracking === true) {
    const suppliedAgent = extractHandle(args, AGENT_ID_PARAM);
    if (suppliedAgent) {
      resolution.agentId = suppliedAgent;
      resolution.agentSource = "supplied";
    }
  }

  return resolution;
}
