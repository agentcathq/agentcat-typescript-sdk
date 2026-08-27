import { describe, it, expect } from "vitest";
import {
  AGENTCAT_CUSTOM_EVENT_TYPE,
  AGENTCAT_SOURCE,
  DIAGNOSTICS_SCOPE_NAME,
  SESSION_ID_PARAM_DESCRIPTION,
  SESSION_ID_PARAM_PATTERN,
  SESSION_START_SENTINEL,
  AGENT_ID_PARAM_DESCRIPTION,
  MCP_SESSION_KEY,
  MCP_SESSION_STATUS_DESCRIPTION,
  MINT_BACK_HEADER_ISSUED,
  MINT_BACK_ISSUED_BODY,
  MINT_BACK_HEADER_UNRECOGNIZED,
  MINT_BACK_UNRECOGNIZED_BODY,
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

  it("mirrors under the mcp_session key", () => {
    expect(MCP_SESSION_KEY).toBe("mcp_session");
  });
});

describe("handle param descriptions name the delivery channel", () => {
  it("session_id pre-announces both delivery channels and both text headers", () => {
    expect(SESSION_ID_PARAM_DESCRIPTION).toContain(MCP_SESSION_KEY);
    expect(SESSION_ID_PARAM_DESCRIPTION).toContain(
      "a text block at the start of the result beginning [session_id issued",
    );
    expect(SESSION_ID_PARAM_DESCRIPTION).toContain(
      "a text block beginning [session_id unrecognized",
    );
    expect(MINT_BACK_HEADER_ISSUED).toMatch(/^\[session_id issued/);
    expect(MINT_BACK_HEADER_UNRECOGNIZED).toMatch(/^\[session_id unrecognized/);
  });

  it("agent_id describes self-chosen generation, not server delivery", () => {
    expect(AGENT_ID_PARAM_DESCRIPTION).toContain(
      "opus-4.80-1m|claude-code|k3n9x",
    );
    expect(AGENT_ID_PARAM_DESCRIPTION).toContain("never inherited");
    expect(AGENT_ID_PARAM_DESCRIPTION).toContain("generates a new one");
    expect(AGENT_ID_PARAM_DESCRIPTION).not.toContain("the server will issue");
  });
});
// Byte-exact pins for the v4 copy: the session_id value contract (start | ses_)
// and every string that teaches it. A drifted character here is a wire change.
describe("v4 copy pins (byte-exact)", () => {
  it("pins SESSION_ID_PARAM_DESCRIPTION", () => {
    expect(SESSION_ID_PARAM_DESCRIPTION).toBe(
      "Session continuity handle, one of two values: the ses_ ID issued for the task underway, or start. This server cannot link your calls between requests on its own, so session continuity travels in this parameter instead. If you were handed a session_id for this task — for example by the agent that spawned you — send that exact value from your first call. Otherwise send start on your first call; the server will issue an opaque correlation ID in the mcp_session field of the result, or in a text block at the start of the result beginning [session_id issued. Then send that exact ses_ value on every later call and hand it to any subagents working the same task. start always begins a new, unrelated task — never send it mid-task. If you send a value this server does not recognize, the result reports it: mcp_session.status of unrecognized, or a text block beginning [session_id unrecognized; re-send the ID issued for this task, or start if none was issued yet. Never invent a ses_ value.",
    );
  });

  it("pins MCP_SESSION_STATUS_DESCRIPTION", () => {
    expect(MCP_SESSION_STATUS_DESCRIPTION).toBe(
      "issued: first call of a task; the session_id above was just created. active: the session_id you sent was accepted; keep sending it. unrecognized: the value sent was not issued by this server — re-send the one issued earlier for this task; if none was issued yet, send start to be issued a new one.",
    );
  });

  it("pins MINT_BACK_ISSUED_BODY", () => {
    expect(MINT_BACK_ISSUED_BODY).toBe(
      "This is the first-call issuance described in this tool's session_id parameter description.",
    );
  });

  it("pins MINT_BACK_UNRECOGNIZED_BODY", () => {
    expect(MINT_BACK_UNRECOGNIZED_BODY).toBe(
      "The value sent was not issued by this server. Re-send the session_id issued earlier for this task; if none was issued yet, send start and one will be issued.",
    );
  });

  it("pins the session_id value-contract constants", () => {
    expect(SESSION_ID_PARAM_PATTERN).toBe("^(start|ses_[0-9A-Za-z]{27})$");
    expect(SESSION_START_SENTINEL).toBe("start");
    // The pattern is exactly the isValidSessionId shape plus the sentinel.
    const re = new RegExp(SESSION_ID_PARAM_PATTERN);
    expect(re.test(SESSION_START_SENTINEL)).toBe(true);
    expect(re.test("ses_" + "a".repeat(27))).toBe(true);
    expect(re.test("ses_" + "a".repeat(25))).toBe(false);
    expect(re.test("restart")).toBe(false);
    expect(re.test("START")).toBe(false); // case handling lives in resolution
  });
});
