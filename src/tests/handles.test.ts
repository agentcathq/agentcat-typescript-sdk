import { describe, it, expect } from "vitest";
import {
  newSessionId,
  deriveSessionId,
  extractHandle,
  SESSION_ID_PARAM,
  AGENT_ID_PARAM,
  buildMintBackText,
  appendMintBack,
  buildHandleTags,
  HandleResolution,
  resolveHandles,
  buildStructuredMintBack,
  mirrorStructuredMintBack,
  StructuredMintBack,
  isValidSessionId,
} from "../modules/handles.js";
import { MCP_INSTRUCTIONS_KEY } from "../modules/constants.js";
import { sid } from "./test-utils.js";

describe("handle primitives", () => {
  it("mints session ids with the ses_ prefix", () => {
    const id = newSessionId();
    expect(id).toMatch(/^ses_[0-9A-Za-z]{27}$/);
    expect(newSessionId()).not.toBe(id);
  });

  it("derives deterministic session ids from id+project", () => {
    const a = deriveSessionId("customer-abc", "proj_1");
    const b = deriveSessionId("customer-abc", "proj_1");
    expect(a).toBe(b);
    expect(a).toMatch(/^ses_/);
  });

  it("different project yields a different derived id", () => {
    expect(deriveSessionId("customer-abc", "proj_1")).not.toBe(
      deriveSessionId("customer-abc", "proj_2"),
    );
  });

  it("derives without a project id", () => {
    expect(deriveSessionId("customer-abc")).toBe(
      deriveSessionId("customer-abc"),
    );
    expect(deriveSessionId("customer-abc")).not.toBe(
      deriveSessionId("customer-abc", "proj_1"),
    );
  });

  // Golden vectors. deriveSessionId's construction (sha256 of `id:projectId`, a
  // 2024 epoch plus a hash-derived offset, bytes 4..20 as the KSUID payload) is
  // now the only derivation in the SDK — the legacy MCP-session derivation
  // twin that used to pin it is gone. These
  // literals were produced by the implementation and are frozen: changing them
  // means every previously-derived session id changes on the wire, splitting
  // customer sessions across an SDK upgrade.
  it("pins derived session ids to their golden values", () => {
    expect(deriveSessionId("customer-abc", "proj_1")).toBe(
      "ses_2cOHEO0LYGADMzRvWTXXVbbgxgm",
    );
    expect(deriveSessionId("customer-abc")).toBe(
      "ses_2cZY3tvyI25O2AmL2CGVo2B1IIj",
    );
  });

  // deriveSessionId hashes its input verbatim — it does NOT trim. Trimming is the
  // caller's job (resolveHandles trims the resolveSessionId hook's return before
  // deriving), so a stray space must produce a different id here.
  it("does not trim its input", () => {
    expect(deriveSessionId(" x ", "p")).not.toBe(deriveSessionId("x", "p"));
    expect(deriveSessionId(" x ", "p")).toBe("ses_2c3yR5mYKQdLaXsJNgZH6erbfQK");
    expect(deriveSessionId("x", "p")).toBe("ses_2bw285VY9apdgUgTPXKFnT6P4G0");
  });

  it("extractHandle returns trimmed non-empty strings only", () => {
    expect(extractHandle({ session_id: " ses_x " }, SESSION_ID_PARAM)).toBe(
      "ses_x",
    );
    expect(extractHandle({ session_id: "" }, SESSION_ID_PARAM)).toBeUndefined();
    expect(
      extractHandle({ session_id: "   " }, SESSION_ID_PARAM),
    ).toBeUndefined();
    expect(extractHandle({ session_id: 42 }, SESSION_ID_PARAM)).toBeUndefined();
    expect(extractHandle(undefined, SESSION_ID_PARAM)).toBeUndefined();
    expect(extractHandle(null, AGENT_ID_PARAM)).toBeUndefined();
    expect(extractHandle("not-an-object", SESSION_ID_PARAM)).toBeUndefined();
  });

  it("extractHandle returns any non-empty string; validation happens in resolveHandles", () => {
    expect(
      extractHandle({ session_id: "my-own-correlation-id" }, SESSION_ID_PARAM),
    ).toBe("my-own-correlation-id");
  });
});

const T = "ses_2xF9kQm3rTvB8nL";
const A = "opus-4.80-1m|claude-code|k3n9x";

describe("buildMintBackText", () => {
  it("task minted: task-only block, no agent mention even when agent supplied", () => {
    const res: HandleResolution = {
      sessionId: T,
      sessionSource: "minted",
      hookMode: false,
      agentId: A,
      agentSource: "supplied",
    };
    expect(buildMintBackText(res)).toBe(
      "[MCP INSTRUCTIONS]: session_id issued.\n" +
        `  session_id=${T} — required on every subsequent tool call\n` +
        "Without session_id, this server does not function as intended.",
    );
  });

  it("task minted without agent tracking: same task-only block", () => {
    const res: HandleResolution = {
      sessionId: T,
      sessionSource: "minted",
      hookMode: false,
    };
    expect(buildMintBackText(res)).toBe(
      "[MCP INSTRUCTIONS]: session_id issued.\n" +
        `  session_id=${T} — required on every subsequent tool call\n` +
        "Without session_id, this server does not function as intended.",
    );
  });

  it("task supplied -> null (nothing to announce, agent never mints)", () => {
    const res: HandleResolution = {
      sessionId: T,
      sessionSource: "supplied",
      hookMode: false,
      agentId: A,
      agentSource: "supplied",
    };
    expect(buildMintBackText(res)).toBeNull();
  });

  it("hook mode never emits task instructions, even when hook-null minted", () => {
    const res: HandleResolution = {
      sessionId: T,
      sessionSource: "minted",
      hookMode: true,
      agentId: A,
      agentSource: "supplied",
    };
    expect(buildMintBackText(res)).toBeNull();
  });
});

describe("appendMintBack", () => {
  it("appends a text block to array content", () => {
    const out = appendMintBack(
      { content: [{ type: "text", text: "hi" }] },
      "BLOCK",
    );
    expect(out.content).toHaveLength(2);
    expect(out.content[1]).toEqual({ type: "text", text: "BLOCK" });
  });

  it("appends on isError results too", () => {
    const out = appendMintBack(
      { isError: true, content: [{ type: "text", text: "boom" }] },
      "BLOCK",
    );
    expect(out.content).toHaveLength(2);
  });

  it("leaves non-array content untouched", () => {
    const r1 = { structuredContent: { a: 1 } };
    expect(appendMintBack(r1, "BLOCK")).toBe(r1);
    expect(appendMintBack(null, "BLOCK")).toBe(null);
  });

  it("does not mutate the original result", () => {
    const original = { content: [{ type: "text", text: "hi" }] };
    appendMintBack(original, "BLOCK");
    expect(original.content).toHaveLength(1);
  });
});

describe("buildHandleTags", () => {
  it("stamps sources, agent id, and protocol version", () => {
    const res: HandleResolution = {
      sessionId: T,
      sessionSource: "supplied",
      hookMode: false,
      agentId: A,
      agentSource: "supplied",
    };
    expect(buildHandleTags(res, "2026-07-28")).toEqual({
      agentcat_session_id_source: "supplied",
      agentcat_agent_id: A,
      agentcat_agent_id_source: "supplied",
      agentcat_protocol_version: "2026-07-28",
    });
  });

  it("omits agent and protocol keys when absent", () => {
    const res: HandleResolution = {
      sessionId: T,
      sessionSource: "hook",
      hookMode: true,
    };
    expect(buildHandleTags(res)).toEqual({
      agentcat_session_id_source: "hook",
    });
  });

  it("clamps a >200-char agent_id to exactly 200 chars in the tag only", () => {
    const longId = "a".repeat(500);
    const res: HandleResolution = {
      sessionId: T,
      sessionSource: "supplied",
      hookMode: false,
      agentId: longId,
      agentSource: "supplied",
    };
    const tags = buildHandleTags(res);
    expect(tags.agentcat_agent_id).toHaveLength(200);
    expect(tags.agentcat_agent_id).toBe("a".repeat(200));
    // The resolution itself stays verbatim — only the tag copy is clamped.
    expect(res.agentId).toBe(longId);
  });

  it("strips newlines from the agent_id tag", () => {
    const res: HandleResolution = {
      sessionId: T,
      sessionSource: "supplied",
      hookMode: false,
      agentId: "line1\nline2\r\nline3",
      agentSource: "supplied",
    };
    const tags = buildHandleTags(res);
    expect(tags.agentcat_agent_id).not.toContain("\n");
    expect(tags.agentcat_agent_id).not.toContain("\r");
    expect(tags.agentcat_agent_id).toBe("line1 line2  line3");
    expect(res.agentId).toBe("line1\nline2\r\nline3");
  });

  it("passes a normal agent_id through unchanged", () => {
    const res: HandleResolution = {
      sessionId: T,
      sessionSource: "supplied",
      hookMode: false,
      agentId: A,
      agentSource: "supplied",
    };
    expect(buildHandleTags(res).agentcat_agent_id).toBe(A);
  });
});

const req = (args?: Record<string, unknown>) => ({
  params: { name: "add_todo", arguments: args },
});

describe("resolveHandles — prompted mode", () => {
  it("mints the task but never the agent when nothing supplied (agent tracking on)", async () => {
    const res = await resolveHandles(
      { enableAgentTracking: true },
      "proj_1",
      req({}),
    );
    expect(res.hookMode).toBe(false);
    expect(res.sessionSource).toBe("minted");
    expect(res.sessionId).toMatch(/^ses_/);
    expect(res.agentId).toBeUndefined();
    expect(res.agentSource).toBeUndefined();
  });

  it("subagent flow: supplied task + omitted agent leaves the agent unresolved", async () => {
    const res = await resolveHandles(
      { enableAgentTracking: true },
      "proj_1",
      req({ session_id: sid("parent") }),
    );
    expect(res.sessionSource).toBe("supplied");
    expect(res.sessionId).toBe(sid("parent"));
    expect(res.agentId).toBeUndefined();
    expect(res.agentSource).toBeUndefined();
  });

  it("uses supplied handles verbatim", async () => {
    const res = await resolveHandles(
      { enableAgentTracking: true },
      "proj_1",
      req({
        session_id: sid("anythinggoes"),
        agent_id: " opus-4.80-1m|claude-code|k3n9x ",
      }),
    );
    expect(res.sessionSource).toBe("supplied");
    expect(res.sessionId).toBe(sid("anythinggoes"));
    expect(res.agentSource).toBe("supplied");
    expect(res.agentId).toBe("opus-4.80-1m|claude-code|k3n9x");
  });

  it("enableAgentTracking:false resolves no agent id at all", async () => {
    const res = await resolveHandles(
      { enableAgentTracking: false },
      "proj_1",
      req({ agent_id: "agt_ignored" }),
    );
    expect(res.agentId).toBeUndefined();
    expect(res.agentSource).toBeUndefined();
  });

  it("agent tracking is OFF by default — omitted option resolves no agent id", async () => {
    const res = await resolveHandles(
      {},
      "proj_1",
      req({ agent_id: "agt_ignored" }),
    );
    expect(res.sessionSource).toBe("minted");
    expect(res.agentId).toBeUndefined();
    expect(res.agentSource).toBeUndefined();
  });

  it("rejects a malformed supplied session_id: sessionless, source invalid", async () => {
    const res = await resolveHandles({}, "proj_1", req({ session_id: "nope" }));
    expect(res.sessionSource).toBe("invalid");
    expect(res.sessionId).toBe("");
  });

  it("never stores the raw rejected value", async () => {
    const res = await resolveHandles(
      {},
      "proj_1",
      req({ session_id: "sk_live_secret_token" }),
    );
    expect(res.sessionId).toBe("");
    expect(JSON.stringify(res)).not.toContain("sk_live_secret_token");
  });

  it("accepts a well-formed supplied session_id verbatim", async () => {
    const res = await resolveHandles(
      {},
      "proj_1",
      req({ session_id: sid("parent") }),
    );
    expect(res.sessionSource).toBe("supplied");
    expect(res.sessionId).toBe(sid("parent"));
  });

  it("foreign param: sessionless regardless of what the agent sent", async () => {
    const withValue = await resolveHandles(
      {},
      "proj_1",
      req({ session_id: "customer-value" }),
      undefined,
      false,
    );
    expect(withValue.sessionSource).toBe("foreign");
    expect(withValue.sessionId).toBe("");

    const withoutValue = await resolveHandles(
      {},
      "proj_1",
      req({}),
      undefined,
      false,
    );
    expect(withoutValue.sessionSource).toBe("foreign");
    expect(withoutValue.sessionId).toBe("");
  });

  it("hook mode wins over foreign: arguments are never read", async () => {
    const res = await resolveHandles(
      { resolveSessionId: () => "corr-7" },
      "proj_1",
      req({ session_id: "customer-value" }),
      undefined,
      false,
    );
    expect(res.sessionSource).toBe("hook");
    expect(res.sessionId).toMatch(/^ses_/);
  });

  it("still mints when nothing is supplied on our own param", async () => {
    const res = await resolveHandles({}, "proj_1", req({}));
    expect(res.sessionSource).toBe("minted");
    expect(res.sessionId).toMatch(/^ses_/);
  });
});

describe("resolveHandles — hook mode", () => {
  it("derives deterministically from the hook value + project", async () => {
    const opts = { resolveSessionId: async () => "customer-42" };
    const a = await resolveHandles(opts, "proj_1", req({}));
    const b = await resolveHandles(opts, "proj_1", req({}));
    expect(a.hookMode).toBe(true);
    expect(a.sessionSource).toBe("hook");
    expect(a.sessionId).toBe(b.sessionId);
    expect(a.sessionId).toMatch(/^ses_/);
  });

  it("ignores agent-supplied session_id — the hook wins", async () => {
    const opts = { resolveSessionId: () => "customer-42" };
    const res = await resolveHandles(
      opts,
      "proj_1",
      req({ session_id: "ses_agent_sent" }),
    );
    expect(res.sessionSource).toBe("hook");
    expect(res.sessionId).not.toBe("ses_agent_sent");
  });

  it("hook returning null mints silently", async () => {
    const res = await resolveHandles(
      { resolveSessionId: () => null },
      "proj_1",
      req({}),
    );
    expect(res.hookMode).toBe(true);
    expect(res.sessionSource).toBe("minted");
    expect(res.sessionId).toMatch(/^ses_/);
  });

  it("never reports 'supplied' when the hook falls back with a session_id present", async () => {
    // Guards the buildMintBackText ack line: it fires on sessionSource ===
    // "supplied", which must be unreachable in hook mode. A hook that returns
    // null while the agent happens to send session_id is the danger case.
    for (const resolveSessionId of [
      () => null,
      () => {
        throw new Error("db down");
      },
    ]) {
      const res = await resolveHandles(
        { resolveSessionId },
        "proj_1",
        req({ session_id: "ses_agent_sent" }),
      );
      expect(res.sessionSource).toBe("minted");
      expect(res.sessionId).not.toBe("ses_agent_sent");
    }
  });

  it("hook throwing mints silently", async () => {
    const res = await resolveHandles(
      {
        resolveSessionId: () => {
          throw new Error("db down");
        },
      },
      "proj_1",
      req({}),
    );
    expect(res.sessionSource).toBe("minted");
  });

  it("hook mode: supplied agent_id resolves, omitted stays unresolved", async () => {
    const supplied = await resolveHandles(
      { resolveSessionId: () => "c", enableAgentTracking: true },
      "proj_1",
      req({ agent_id: "opus-4.80-1m|claude-code|k3n9x" }),
    );
    expect(supplied.agentSource).toBe("supplied");
    expect(supplied.agentId).toBe("opus-4.80-1m|claude-code|k3n9x");

    const omitted = await resolveHandles(
      { resolveSessionId: () => "c", enableAgentTracking: true },
      "proj_1",
      req({}),
    );
    expect(omitted.agentId).toBeUndefined();
    expect(omitted.agentSource).toBeUndefined();
  });

  it("forwards the request and extra objects to the hook", async () => {
    // The flagship documented use reads off extra:
    //   resolveSessionId: (request, extra) =>
    //     extra?.requestInfo?.headers?.["x-correlation-id"]
    // Identity assertions (toBe) pin that the whole request is passed — not
    // request.params.arguments — and that extra is forwarded, not dropped.
    const calls: Array<[any, any]> = [];
    const request = req({ session_id: "ses_agent_sent" });
    const extra = {
      requestInfo: { headers: { "x-correlation-id": "corr-1" } },
    };

    const res = await resolveHandles(
      {
        resolveSessionId: (r, e) => {
          calls.push([r, e]);
          return e?.requestInfo?.headers?.["x-correlation-id"] ?? null;
        },
      },
      "proj_1",
      request,
      extra,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(request);
    expect(calls[0][1]).toBe(extra);
    // The header actually drove the derivation, so forwarding is observable.
    expect(res.sessionSource).toBe("hook");
    expect(res.sessionId).toBe(deriveSessionId("corr-1", "proj_1"));
  });
});

describe("buildStructuredMintBack", () => {
  it("task minted + agent supplied: both ids, task-issued instructions", () => {
    const res: HandleResolution = {
      sessionId: T,
      sessionSource: "minted",
      hookMode: false,
      agentId: A,
      agentSource: "supplied",
    };
    const mint = buildStructuredMintBack(res)!;
    expect(mint.session_id).toBe(T);
    expect(mint.agent_id).toBe(A);
    expect(mint.instructions).toContain("session_id issued");
    expect(mint.instructions).not.toContain("agent_id issued");
  });

  it("steady state (both supplied): ids plus confirmed copy", () => {
    const res: HandleResolution = {
      sessionId: T,
      sessionSource: "supplied",
      hookMode: false,
      agentId: A,
      agentSource: "supplied",
    };
    const mint = buildStructuredMintBack(res)!;
    expect(mint.session_id).toBe(T);
    expect(mint.agent_id).toBe(A);
    expect(mint.instructions).toContain("session_id and agent_id confirmed");
    expect(mint.instructions).toContain("these exact values");
  });

  it("agent tracking off: task only, singular confirmed copy", () => {
    const res: HandleResolution = {
      sessionId: T,
      sessionSource: "supplied",
      hookMode: false,
    };
    const mint = buildStructuredMintBack(res)!;
    expect(mint.session_id).toBe(T);
    expect(mint).not.toHaveProperty("agent_id");
    expect(mint.instructions).toContain("session_id confirmed");
    expect(mint.instructions).toContain("this exact value");
  });

  it("hook mode never exposes session_id; supplied agent is confirmed", () => {
    const res: HandleResolution = {
      sessionId: T,
      sessionSource: "minted",
      hookMode: true,
      agentId: A,
      agentSource: "supplied",
    };
    const mint = buildStructuredMintBack(res)!;
    expect(mint).not.toHaveProperty("session_id");
    expect(mint.agent_id).toBe(A);
    expect(mint.instructions).toContain("agent_id confirmed");
  });

  it("hook mode with agent tracking off: nothing echoable -> null", () => {
    const res: HandleResolution = {
      sessionId: T,
      sessionSource: "hook",
      hookMode: true,
    };
    expect(buildStructuredMintBack(res)).toBeNull();
  });
});

describe("mirrorStructuredMintBack", () => {
  const mint: StructuredMintBack = { session_id: T, instructions: "TEXT" };

  it("adds the field to plain-object structuredContent without mutating", () => {
    const original = { content: [], structuredContent: { a: 1 } };
    const out = mirrorStructuredMintBack(original, mint);
    expect(out.structuredContent[MCP_INSTRUCTIONS_KEY]).toEqual(mint);
    expect(out.structuredContent.a).toBe(1);
    // non-mutation of the customer's objects
    expect(original.structuredContent).toEqual({ a: 1 });
    expect(out).not.toBe(original);
  });

  it("returns the input untouched when structuredContent is absent or not a plain object", () => {
    const r1 = { content: [] };
    expect(mirrorStructuredMintBack(r1, mint)).toBe(r1);
    const r2 = { structuredContent: [1, 2] };
    expect(mirrorStructuredMintBack(r2, mint)).toBe(r2);
    const r3 = { structuredContent: "nope" };
    expect(mirrorStructuredMintBack(r3, mint)).toBe(r3);
    expect(mirrorStructuredMintBack(null, mint)).toBe(null);
  });

  it("never clobbers an existing key (customer data wins)", () => {
    const r = {
      structuredContent: { [MCP_INSTRUCTIONS_KEY]: "customer-owned" },
    };
    expect(mirrorStructuredMintBack(r, mint)).toBe(r);
  });

  it("applies to isError results that carry structuredContent", () => {
    const r = { isError: true, structuredContent: { msg: "boom" } };
    const out = mirrorStructuredMintBack(r, mint);
    expect(out.structuredContent[MCP_INSTRUCTIONS_KEY]).toEqual(mint);
  });
});

describe("isValidSessionId", () => {
  it("accepts an ID this SDK actually mints", () => {
    expect(isValidSessionId(newSessionId())).toBe(true);
    expect(isValidSessionId(deriveSessionId("anything", "proj_1"))).toBe(true);
  });

  it("accepts the test helper's IDs", () => {
    expect(isValidSessionId(sid("parent"))).toBe(true);
  });

  it.each([
    ["wrong prefix", "task_2xF9kQm3rTvB8nLpYw7ZcHd4Ke"],
    ["no prefix", "2xF9kQm3rTvB8nLpYw7ZcHd4Ke1"],
    ["too short", "ses_abc"],
    ["too long", "ses_" + "a".repeat(28)],
    ["empty", ""],
    ["prefix only", "ses_"],
    ["customer value", "my-app-session-42"],
    ["non-base62 body", "ses_" + "-".repeat(27)],
    ["inner whitespace", "ses_ " + "a".repeat(26)],
  ])("rejects %s", (_label, value) => {
    expect(isValidSessionId(value)).toBe(false);
  });
});

describe("invalid and foreign mint-back", () => {
  const invalidRes = {
    sessionId: "",
    sessionSource: "invalid" as const,
    hookMode: false,
  };
  const foreignRes = {
    sessionId: "",
    sessionSource: "foreign" as const,
    hookMode: false,
  };

  it("invalid: corrects the agent without issuing a replacement", () => {
    const text = buildMintBackText(invalidRes)!;
    expect(text).toContain("[MCP INSTRUCTIONS]: session_id not recognized.");
    expect(text).toContain("Re-send the exact session_id");
    // No value handed out: nothing that looks like an ID appears.
    expect(text).not.toMatch(/ses_[0-9A-Za-z]{27}/);
  });

  it("invalid: structured mirror carries instructions but no session_id", () => {
    const mint = buildStructuredMintBack(invalidRes)!;
    expect(mint.instructions).toContain("not recognized");
    expect(mint.session_id).toBeUndefined();
  });

  it("foreign: says nothing to the agent at all", () => {
    expect(buildMintBackText(foreignRes)).toBeNull();
    expect(buildStructuredMintBack(foreignRes)).toBeNull();
  });

  it("foreign: never confirms a value AgentCat did not issue", () => {
    const mint = buildStructuredMintBack({
      ...foreignRes,
      agentId: "opus|cc|k3n9x",
      agentSource: "supplied" as const,
    });
    expect(mint).toBeNull();
  });
});
