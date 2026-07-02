import { describe, it, expect } from "vitest";
import {
  AGENTCAT_CUSTOM_EVENT_TYPE,
  AGENTCAT_SOURCE,
  DIAGNOSTICS_SCOPE_NAME,
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
