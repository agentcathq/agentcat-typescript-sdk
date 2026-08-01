// Scenario contract for the e2e-http matrix. This file holds the Scenario
// TYPE and the shared CONFIG table (name + options + lane applicability only).
// The scenario SCRIPTS (drive + assert) live in the per-version matrix files
// (v1-matrix.test.ts / v2-matrix.test.ts) — they look configs up by name via
// scenarioConfig() and branch per lane where the plan calls for it.
import type { AgentCatOptions } from "../../types.js";
import { AGENTCAT_TAG_TASK_SOURCE } from "../../modules/constants.js";
import type { EventCapture } from "../test-utils.js";
import type { Lane, LaneId, LaneInstance, ScenarioClient } from "./lanes.js";
import type { ToolSink } from "./toolkit.js";

export interface ScenarioContext {
  client: ScenarioClient;
  capture: EventCapture;
  sink: ToolSink;
  lane: Lane;
  instance: LaneInstance;
}

export interface Scenario {
  name: string;
  options: AgentCatOptions;
  /** Lane ids the scenario applies to; omitted = every lane. */
  lanes?: LaneId[];
  script(ctx: ScenarioContext): Promise<void>;
}

/** Config table entry: a Scenario minus its per-version script. */
export type ScenarioConfig = Omit<Scenario, "script">;

// Shared fixture values scripts assert against (single source of truth).
export const TASK_HOOK_VALUE = "corr-7";
export const AGENT_TASK_HOOK_VALUE = "corr-agent-7";
export const CUSTOM_CONTEXT_DESCRIPTION = "why?";
export const REDACTION_SECRET = "SECRET_TOKEN";
export const REDACTION_REPLACEMENT = "[REDACTED]";
export const IDENTITY_USER_ID = "e2e-user-1";
export const IDENTITY_USER_NAME = "E2E User";
export const IDENTITY_USER_DATA = { plan: "enterprise" } as const;
export const CUSTOMER_TAG_KEY = "e2e_customer_tag";
export const CUSTOMER_TAG_VALUE = "customer-tag-present";
/** Customer value for the colliding SDK tag — the SDK's own value must win. */
export const COLLIDING_TAG_VALUE = "customer-collision-loses";
export const CUSTOMER_PROP_KEY = "e2e_customer_prop";
export const CUSTOMER_PROP_VALUE = "prop-value";

const PER_REQUEST_LANES: LaneId[] = [
  "v1-stateless",
  "v2-handler-legacy",
  "v2-handler-auto",
];
const STATEFUL_LANES: LaneId[] = ["v1-stateful", "v2-longlived"];

/**
 * The curated ~22 scenario configs from the plan, in plan order. Plan names
 * containing "×" are normalized to "-x-".
 */
export const SCENARIO_CONFIGS: readonly ScenarioConfig[] = [
  { name: "baseline-defaults", options: {} },
  { name: "tracing-off", options: { enableTracing: false } },
  {
    name: "tracing-off-x-report-missing-on",
    options: { enableTracing: false },
  },
  { name: "report-missing-off", options: { enableReportMissing: false } },
  { name: "report-missing-call", options: {} },
  { name: "context-off", options: { enableToolCallContext: false } },
  {
    name: "context-custom-description",
    options: { customContextDescription: CUSTOM_CONTEXT_DESCRIPTION },
  },
  { name: "agent-tracking-mint", options: { enableAgentTracking: true } },
  { name: "agent-tracking-supplied", options: { enableAgentTracking: true } },
  {
    name: "agent-tracking-x-hook",
    options: {
      enableAgentTracking: true,
      resolveTaskId: () => AGENT_TASK_HOOK_VALUE,
    },
  },
  {
    name: "task-hook-deterministic",
    options: { resolveTaskId: () => TASK_HOOK_VALUE },
  },
  { name: "task-hook-null", options: { resolveTaskId: () => null } },
  { name: "task-supplied-continuity", options: {} },
  { name: "mint-back-structured-mirror", options: {} },
  { name: "strict-schema-injection", options: {} },
  { name: "strip-proof-loose", options: {} },
  { name: "error-path", options: {} },
  {
    name: "hooks-identity-tags-props",
    options: {
      identify: async () => ({
        userId: IDENTITY_USER_ID,
        userName: IDENTITY_USER_NAME,
        userData: { ...IDENTITY_USER_DATA },
      }),
      eventTags: () => ({
        // Collision on an SDK-owned tag: the SDK's value must win.
        [AGENTCAT_TAG_TASK_SOURCE]: COLLIDING_TAG_VALUE,
        [CUSTOMER_TAG_KEY]: CUSTOMER_TAG_VALUE,
      }),
      eventProperties: () => ({ [CUSTOMER_PROP_KEY]: CUSTOMER_PROP_VALUE }),
    },
  },
  {
    name: "redaction",
    options: {
      redactSensitiveInformation: async (text: string) =>
        text.split(REDACTION_SECRET).join(REDACTION_REPLACEMENT),
    },
  },
  { name: "client-identity-ladder", options: {} },
  { name: "rebuild-on-demand", options: {}, lanes: PER_REQUEST_LANES },
  {
    name: "session-continuity-stateful",
    options: {},
    lanes: STATEFUL_LANES,
  },
];

/** Looks a scenario config up by name; throws on typos. */
export function scenarioConfig(name: string): ScenarioConfig {
  const config = SCENARIO_CONFIGS.find((s) => s.name === name);
  if (!config) throw new Error(`unknown scenario config: ${name}`);
  return config;
}
