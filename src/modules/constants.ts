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
// Single source of truth: docs/superpowers/specs/2026-07-29-explicit-handles-copy.md
// Do not reword without updating the copy spec.

export const CONVERSATION_ID_PARAM_DESCRIPTION =
  "REQUIRED on every call after your first. This MCP server associates all of your tool calls for a given task using conversation_id; a call that arrives without it cannot be associated with your earlier work and is treated as the start of an unrelated task, disconnected from the original goal. Omit it on your first call only — the server will issue one in the _mcp_instructions field of the result (or a trailing [MCP INSTRUCTIONS] text block) — then echo that exact value on every later call. Never invent a value, and do not issue parallel tool calls until the server has issued your conversation_id. One conversation_id covers the whole goal from start to finish: when you spawn subagents you MUST give them this same conversation_id, or their work is severed from yours. Without conversation_id, this server does not function as intended.";

export const AGENT_ID_PARAM_DESCRIPTION =
  "REQUIRED on every call, including your first. This MCP server distinguishes you from every other agent working this task using agent_id; a call that arrives without it cannot be attributed to you. Generate your own ID when you start work by joining three parts with '|': your model version, your harness name, and a short random suffix of 4-6 letters or digits chosen once. Example: opus-4.80-1m|claude-code|k3n9x. Send that same exact value on every call for your entire task; never change it mid-task. agent_id identifies you alone: a newly spawned subagent MUST generate its own instead of reusing its parent's. Without agent_id, this server does not function as intended.";

export const AGENT_ID_PARAM_DESCRIPTION_HOOK_MODE =
  "REQUIRED on every call, including your first. This MCP server distinguishes you from every other agent using agent_id; a call that arrives without it cannot be attributed to you. Generate your own ID when you start work by joining three parts with '|': your model version, your harness name, and a short random suffix of 4-6 letters or digits chosen once. Example: opus-4.80-1m|claude-code|k3n9x. Send that same exact value on every call for your entire task; never change it mid-task. agent_id identifies you alone: a newly spawned subagent MUST generate its own instead of reusing its parent's. Without agent_id, this server does not function as intended.";

export const MINT_BACK_HEADER_CONVERSATION =
  "[MCP INSTRUCTIONS]: conversation_id issued.";
export const MINT_BACK_CLOSER =
  "Without conversation_id, this server does not function as intended.";

export const mintBackConversationLine = (conversationId: string): string =>
  `  conversation_id=${conversationId} — required on every subsequent tool call`;

// ── Structured mint-back: mirrored into structuredContent ───────────────────
// Wire key for the SDK-authored field injected into declared outputSchemas
// and mirrored into structuredContent on every response.
export const MCP_INSTRUCTIONS_KEY = "_mcp_instructions";

export const mintBackConfirmed = (names: string[]): string =>
  `[MCP INSTRUCTIONS]: ${names.join(" and ")} confirmed. Keep sending ${
    names.length > 1 ? "these exact values" : "this exact value"
  } on every call.`;

export const MCP_INSTRUCTIONS_FIELD_DESCRIPTION =
  "Your handles for this task, confirmed by this MCP server on every response, and the instructions for echoing them on later calls. Read and follow.";
export const MCP_INSTRUCTIONS_CONVERSATION_ID_DESCRIPTION =
  "Echo this exact value as the conversation_id argument on every subsequent tool call.";
export const MCP_INSTRUCTIONS_AGENT_ID_DESCRIPTION =
  "Your agent_id as this server received it. Keep sending this exact value on every call; a subagent must generate its own.";

// ── Explicit handles: wire keys ─────────────────────────────────────────────
export const META_CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";
export const META_PROTOCOL_VERSION_KEY =
  "io.modelcontextprotocol/protocolVersion";

export const AGENTCAT_TAG_AGENT_ID = "agentcat_agent_id";
export const AGENTCAT_TAG_CONVERSATION_SOURCE =
  "agentcat_conversation_id_source";
export const AGENTCAT_TAG_AGENT_SOURCE = "agentcat_agent_id_source";
export const AGENTCAT_TAG_PROTOCOL_VERSION = "agentcat_protocol_version";
export const AGENTCAT_TAG_MRTR = "agentcat_mrtr";
