import { describe, it, expect } from "vitest";
import {
  TASK_ID_PARAM,
  AGENT_ID_PARAM,
  newTaskId,
  newAgentId,
  deriveTaskId,
  extractHandle,
  stripHandles,
  cloneRequestWithoutHandles,
  buildMintBackText,
} from "../modules/handles.js";
import {
  TASK_ID_PARAMETER_DESCRIPTION,
  AGENT_ID_PARAMETER_DESCRIPTION,
} from "../modules/constants.js";

// The example handles used by the fenced blocks in
// docs/superpowers/specs/2026-07-29-explicit-handles-copy.md, so the expected
// values below can be diffed against the spec line for line.
const SPEC_TASK_ID = "ses_2xF9kQm3rTvB8nL";
const SPEC_AGENT_ID = "agt_9kQm3rTvB8nL2xF";

describe("handle primitives", () => {
  it("mints task IDs with the ses_ prefix", () => {
    const id = newTaskId();
    expect(id.startsWith("ses_")).toBe(true);
    expect(id).not.toBe(newTaskId());
  });

  it("mints agent IDs with the agt_ prefix", () => {
    const id = newAgentId();
    expect(id.startsWith("agt_")).toBe(true);
    expect(id).not.toBe(newAgentId());
  });

  it("derives the same task ID from the same inputs", () => {
    expect(deriveTaskId("cust-1", "proj_a")).toBe(
      deriveTaskId("cust-1", "proj_a"),
    );
  });

  it("derives different task IDs across projects", () => {
    expect(deriveTaskId("cust-1", "proj_a")).not.toBe(
      deriveTaskId("cust-1", "proj_b"),
    );
  });

  it("derives task IDs with the ses_ prefix", () => {
    expect(deriveTaskId("cust-1", "proj_a").startsWith("ses_")).toBe(true);
  });

  it("extracts and trims a supplied handle", () => {
    expect(
      extractHandle({ [TASK_ID_PARAM]: "  ses_abc  " }, TASK_ID_PARAM),
    ).toBe("ses_abc");
  });

  it("treats blank, missing, and non-string handles as absent", () => {
    expect(
      extractHandle({ [TASK_ID_PARAM]: "   " }, TASK_ID_PARAM),
    ).toBeUndefined();
    expect(extractHandle({}, TASK_ID_PARAM)).toBeUndefined();
    expect(
      extractHandle({ [TASK_ID_PARAM]: 42 }, TASK_ID_PARAM),
    ).toBeUndefined();
    expect(extractHandle(undefined, TASK_ID_PARAM)).toBeUndefined();
  });

  it("trusts a supplied handle verbatim without validating its shape", () => {
    expect(extractHandle({ [TASK_ID_PARAM]: "my-own-id" }, TASK_ID_PARAM)).toBe(
      "my-own-id",
    );
  });

  it("strips both handles and leaves other arguments untouched", () => {
    const stripped = stripHandles({
      [TASK_ID_PARAM]: "ses_a",
      [AGENT_ID_PARAM]: "agt_b",
      text: "hello",
      context: "why",
    });
    expect(stripped).toEqual({ text: "hello", context: "why" });
  });

  it("returns the same reference when there is nothing to strip", () => {
    const args = { text: "hello" };
    expect(stripHandles(args)).toBe(args);
  });

  it("clones a request without handles, leaving the original intact", () => {
    const request = {
      method: "tools/call",
      params: {
        name: "add_todo",
        arguments: { text: "x", [TASK_ID_PARAM]: "ses_a" },
      },
    };
    const cloned = cloneRequestWithoutHandles(request);
    expect(cloned.params.arguments).toEqual({ text: "x" });
    expect(request.params.arguments).toHaveProperty(TASK_ID_PARAM);
  });
});

describe("mint-back text", () => {
  it("returns undefined when nothing was minted", () => {
    expect(
      buildMintBackText({
        taskId: "ses_a",
        taskIdMinted: false,
        agentId: "agt_b",
        agentIdMinted: false,
      }),
    ).toBeUndefined();
  });

  it("builds the both-minted variant", () => {
    const text = buildMintBackText({
      taskId: "ses_a",
      taskIdMinted: true,
      agentId: "agt_b",
      agentIdMinted: true,
    })!;
    expect(text.startsWith("[MCP INSTRUCTIONS]: Handles issued.")).toBe(true);
    expect(text).toContain("task_id=ses_a");
    expect(text).toContain("agent_id=agt_b");
    expect(text).toContain(
      "Without task_id, this server does not function as intended.",
    );
  });

  it("builds the agent-only variant and confirms the inherited task ID", () => {
    const text = buildMintBackText({
      taskId: "ses_a",
      taskIdMinted: false,
      agentId: "agt_b",
      agentIdMinted: true,
    })!;
    expect(text.startsWith("[MCP INSTRUCTIONS]: Handle issued.")).toBe(true);
    expect(text).toContain("agent_id=agt_b");
    expect(text).toContain(
      "Your task_id=ses_a was accepted. Keep sending it unchanged.",
    );
    // The subagent is complying on task_id — never tell it the server is broken.
    expect(text).not.toContain("does not function as intended");
  });

  it("builds the task-only variant", () => {
    const text = buildMintBackText({
      taskId: "ses_a",
      taskIdMinted: true,
      agentIdMinted: false,
    })!;
    expect(text).toContain("task_id=ses_a");
    expect(text).not.toContain("agent_id=");
    expect(text).toContain(
      "Without task_id, this server does not function as intended.",
    );
  });
});

// These are the copy-fidelity tests. Every string an agent reads is pinned here
// by full equality against the approved wording in
// docs/superpowers/specs/2026-07-29-explicit-handles-copy.md. A failure here
// means the shipped copy drifted from the spec, not that the expectation is
// stale — fix the constant, not the test, unless the spec itself changed.
describe("agent-facing copy", () => {
  it("pins the both-minted mint-back verbatim", () => {
    expect(
      buildMintBackText({
        taskId: SPEC_TASK_ID,
        taskIdMinted: true,
        agentId: SPEC_AGENT_ID,
        agentIdMinted: true,
      }),
    ).toBe(
      [
        "[MCP INSTRUCTIONS]: Handles issued. This server requires both on every subsequent tool call — a call that omits them cannot be associated with this task.",
        "  task_id=ses_2xF9kQm3rTvB8nL — identifies the whole goal. You MUST pass this to any subagent you spawn, or its work is severed from yours.",
        "  agent_id=agt_9kQm3rTvB8nL2xF — identifies you alone. Never pass this to a subagent; a new subagent MUST omit agent_id so the server can issue it its own.",
        "Without task_id, this server does not function as intended.",
      ].join("\n"),
    );
  });

  it("pins the agent-only mint-back verbatim", () => {
    expect(
      buildMintBackText({
        taskId: SPEC_TASK_ID,
        taskIdMinted: false,
        agentId: SPEC_AGENT_ID,
        agentIdMinted: true,
      }),
    ).toBe(
      [
        "[MCP INSTRUCTIONS]: Handle issued. This server requires it on every subsequent tool call — a call that omits it cannot be attributed to you.",
        "  agent_id=agt_9kQm3rTvB8nL2xF — identifies you alone. Never pass this to a subagent; a new subagent MUST omit agent_id so the server can issue it its own.",
        "Your task_id=ses_2xF9kQm3rTvB8nL was accepted. Keep sending it unchanged.",
      ].join("\n"),
    );
  });

  it("pins the task-only mint-back verbatim", () => {
    expect(
      buildMintBackText({
        taskId: SPEC_TASK_ID,
        taskIdMinted: true,
        agentIdMinted: false,
      }),
    ).toBe(
      [
        "[MCP INSTRUCTIONS]: Handle issued. This server requires it on every subsequent tool call — a call that omits it cannot be associated with this task.",
        "  task_id=ses_2xF9kQm3rTvB8nL — identifies the whole goal. You MUST pass this to any subagent you spawn, or its work is severed from yours.",
        "Without task_id, this server does not function as intended.",
      ].join("\n"),
    );
  });

  it("pins the task_id parameter description verbatim", () => {
    expect(TASK_ID_PARAMETER_DESCRIPTION).toBe(
      "REQUIRED on every call after your first. This server associates all of your tool calls into a single task using task_id; a call that arrives without it cannot be associated with your earlier work and is treated as the start of an unrelated task. Omit it on your first call only — the server will issue one — then echo that exact value on every later call. Never invent a value, and do not issue parallel tool calls until the server has issued your task_id. One task_id covers the whole goal from start to finish: when you spawn subagents you MUST give them this same task_id, or their work is severed from yours. Without task_id, this server does not function as intended.",
    );
  });

  it("pins the agent_id parameter description verbatim", () => {
    expect(AGENT_ID_PARAMETER_DESCRIPTION).toBe(
      "REQUIRED on every call after your first. This server distinguishes you from every other agent working this task using agent_id; a call that arrives without it is recorded as coming from a different agent, fracturing your work and causing unintended consequences. Omit it on your first call only — the server will issue one — then echo that exact value on every later call. Never invent a value. Unlike task_id, agent_id identifies you alone: never pass it to a subagent, and if you ARE a newly spawned subagent you MUST omit it so the server can issue you your own. Without agent_id, this server does not function as intended.",
    );
  });
});
