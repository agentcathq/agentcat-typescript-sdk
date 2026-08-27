// AgentCat Settings
export const DEFAULT_CONTEXT_PARAMETER_DESCRIPTION = `Explain why you are calling this tool and how it fits into the user's overall goal. This parameter is used for analytics and user intent tracking. YOU MUST provide 15-25 words (count carefully). NEVER use first person ('I', 'we', 'you') - maintain third-person perspective. NEVER include sensitive information such as credentials, passwords, or personal data. Example (20 words): "Searching across the organization's repositories to find all open issues related to performance complaints and latency issues for team prioritization."`;
export const AGENTCAT_CUSTOM_EVENT_TYPE = "agentcat:custom";
export const AGENTCAT_SOURCE = "agentcat";

export const DIAGNOSTICS_SCOPE_NAME = "agentcat-diagnostics";
export const DEFAULT_DIAGNOSTICS_ENDPOINT = "https://otel.agentcat.com";

// Public shared ingestion key for SDK diagnostics. NOT a secret — it ships in the
// published package. It exists to deter drive-by traffic to the collector, paired with
// a server-side rate limit. Override with DIAGNOSTICS_TOKEN to point at a
// self-hosted collector. Must match the collector's bearertokenauth token.
export const DEFAULT_DIAGNOSTICS_TOKEN =
  "dgk_sdk_diag_3f9a2c7e1b8d4065af2e9c1d7b6a4f80";

// ── Explicit handles: agent-facing copy ─────────────────────────────────────
// This copy is read by agents, not humans — its exact wording drives whether
// agents echo handles back correctly. Do not reword casually.

export const SESSION_ID_PARAM_DESCRIPTION =
  "Session continuity handle, one of two values: the ses_ ID issued for the task underway, or start. This server cannot link your calls between requests on its own, so session continuity travels in this parameter instead. If you were handed a session_id for this task — for example by the agent that spawned you — send that exact value from your first call. Otherwise send start on your first call; the server will issue an opaque correlation ID in the mcp_session field of the result, or in a text block at the start of the result beginning [session_id issued. Then send that exact ses_ value on every later call and hand it to any subagents working the same task. start always begins a new, unrelated task — never send it mid-task. If you send a value this server does not recognize, the result reports it: mcp_session.status of unrecognized, or a text block beginning [session_id unrecognized; re-send the ID issued for this task, or start if none was issued yet. Never invent a ses_ value.";

// Machine-enforceable value contract for the injected session_id parameter,
// advertised as the JSON Schema "pattern" of the injected property: the start
// sentinel or a ses_ KSUID. Intentionally equal to the isValidSessionId shape
// with the start alternative added — do not loosen or widen it.
export const SESSION_ID_PARAM_PATTERN = "^(start|ses_[0-9A-Za-z]{27})$";

// Sentinel an agent sends as session_id to explicitly begin a new, unrelated
// task. Compared case-insensitively after trimming, and resolved exactly like
// an omitted session_id: minted path, status issued, minted text block.
export const SESSION_START_SENTINEL = "start";

export const AGENT_ID_PARAM_DESCRIPTION =
  "Agent identity handle, required on every call including your first. This server cannot tell concurrent agents apart on its own; agent_id is how your calls are attributed to you. It is a self-chosen identifier in the spirit of a User-Agent string — join your model version, your harness name, and a short suffix of 4-6 letters or digits, with '|'. Example: opus-4.80-1m|claude-code|k3n9x. Choose the suffix once at the start of your task and send that same exact value on every call for the entire task; never change it mid-task, and a new task gets a fresh suffix. agent_id identifies exactly one agent and is never inherited: a subagent you spawn generates a new one rather than carrying yours, and if you were spawned by another agent, generate your own rather than reusing your parent's. A call without agent_id cannot be attributed to you.";

// Issuance and unrecognized-value text blocks, prepended as the first content
// element so the id survives client-side truncation of long results.
export const MINT_BACK_HEADER_ISSUED =
  "[session_id issued — see this tool's session_id parameter description]";

export const MINT_BACK_ISSUED_BODY =
  "This is the first-call issuance described in this tool's session_id parameter description.";

export const MINT_BACK_HEADER_UNRECOGNIZED =
  "[session_id unrecognized — see this tool's session_id parameter description]";

export const MINT_BACK_UNRECOGNIZED_BODY =
  "The value sent was not issued by this server. Re-send the session_id issued earlier for this task; if none was issued yet, send start and one will be issued.";

export const mintBackSessionLine = (sessionId: string): string =>
  `session_id: ${sessionId}`;

// ── Structured mint-back: mirrored into structuredContent ───────────────────
// Wire key for the SDK-authored field injected into declared outputSchemas
// and mirrored as the first key of structuredContent whenever there is handle
// state to report.
export const MCP_SESSION_KEY = "mcp_session";

export const MCP_SESSION_FIELD_DESCRIPTION =
  "Session continuity and agent attribution state for this task, returned on completed responses that carry structured output. This server cannot link your calls between requests on its own, so session continuity travels here instead.";

export const MCP_SESSION_FIELD_DESCRIPTION_HOOK_MODE =
  "Agent attribution state for this task, returned on completed responses that carry structured output.";

export const MCP_SESSION_SESSION_ID_DESCRIPTION =
  "Opaque correlation ID for this task, issued by this server. Use this as the session_id argument of every later call, and hand it to any subagents working the same task. Absent when status is unrecognized; no replacement is issued in that response — recovery is described under status.";

export const MCP_SESSION_AGENT_ID_DESCRIPTION =
  "Present only when you sent agent_id on this call. Your agent_id, echoed as received. Continue sending this exact value on every call; it is never inherited — a subagent you spawn generates its own.";

export const MCP_SESSION_STATUS_DESCRIPTION =
  "issued: first call of a task; the session_id above was just created. active: the session_id you sent was accepted; keep sending it. unrecognized: the value sent was not issued by this server — re-send the one issued earlier for this task; if none was issued yet, send start to be issued a new one.";

// ── Explicit handles: wire keys ─────────────────────────────────────────────
export const META_CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";
export const META_PROTOCOL_VERSION_KEY =
  "io.modelcontextprotocol/protocolVersion";

export const AGENTCAT_TAG_AGENT_ID = "agentcat_agent_id";
export const AGENTCAT_TAG_SESSION_SOURCE = "agentcat_session_id_source";
export const AGENTCAT_TAG_AGENT_SOURCE = "agentcat_agent_id_source";
export const AGENTCAT_TAG_PROTOCOL_VERSION = "agentcat_protocol_version";
export const AGENTCAT_TAG_MRTR = "agentcat_mrtr";
