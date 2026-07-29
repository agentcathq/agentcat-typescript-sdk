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
} from "../modules/handles.js";

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
