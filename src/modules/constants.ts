// AgentCat Settings
export const INACTIVITY_TIMEOUT_IN_MINUTES = 30;
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
