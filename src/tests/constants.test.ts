import { describe, it, expect } from "vitest";
import {
  AGENTCAT_CUSTOM_EVENT_TYPE,
  AGENTCAT_SOURCE,
  DIAGNOSTICS_SCOPE_NAME,
  CONVERSATION_ID_PARAM_DESCRIPTION,
  AGENT_ID_PARAM_DESCRIPTION,
  AGENT_ID_PARAM_DESCRIPTION_HOOK_MODE,
  MCP_INSTRUCTIONS_KEY,
} from "../modules/constants.js";

describe("brand constants (wire literals)", () => {
  it("emits the agentcat custom event type on the wire", () => {
    expect(AGENTCAT_CUSTOM_EVENT_TYPE).toBe("agentcat:custom");
  });

  it("stamps exporter source as agentcat", () => {
    expect(AGENTCAT_SOURCE).toBe("agentcat");
  });

  it("uses the agentcat diagnostics scope name", () => {
    expect(DIAGNOSTICS_SCOPE_NAME).toBe("agentcat-diagnostics");
  });
});

describe("handle param descriptions name the delivery channel", () => {
  it("conversation_id describes server-issued delivery via _mcp_instructions", () => {
    expect(CONVERSATION_ID_PARAM_DESCRIPTION).toContain(MCP_INSTRUCTIONS_KEY);
    expect(CONVERSATION_ID_PARAM_DESCRIPTION).toContain("[MCP INSTRUCTIONS]");
  });

  it("agent_id describes self-chosen generation, not server delivery", () => {
    for (const description of [
      AGENT_ID_PARAM_DESCRIPTION,
      AGENT_ID_PARAM_DESCRIPTION_HOOK_MODE,
    ]) {
      expect(description).toContain("generate its own");
      expect(description).toContain("opus-4.80-1m|claude-code|k3n9x");
    }
  });
});
