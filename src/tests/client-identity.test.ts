import { describe, it, expect } from "vitest";
import {
  getClientInfoForRequest,
  getProtocolVersion,
  buildSessionInfo,
} from "../modules/session.js";
import { resolveIdentity } from "../modules/internal.js";

const serverWith = (clientVersion?: { name: string; version: string }) =>
  ({
    getClientVersion: () => clientVersion,
    _serverInfo: { name: "srv", version: "9.9" },
    setRequestHandler: () => {},
    _requestHandlers: new Map(),
  }) as any;

describe("getClientInfoForRequest", () => {
  it("prefers per-request _meta clientInfo (modern client)", () => {
    const request = {
      params: {
        name: "t",
        _meta: {
          "io.modelcontextprotocol/clientInfo": {
            name: "claude",
            version: "3.0",
          },
        },
      },
    };
    expect(
      getClientInfoForRequest(
        serverWith({ name: "legacy", version: "1" }),
        request,
      ),
    ).toEqual({ name: "claude", version: "3.0" });
  });

  it("falls back to getClientVersion (legacy initialize capture)", () => {
    expect(
      getClientInfoForRequest(serverWith({ name: "legacy", version: "1" }), {
        params: {},
      }),
    ).toEqual({ name: "legacy", version: "1" });
  });

  it("both missing -> undefined (client declined to identify)", () => {
    expect(
      getClientInfoForRequest(serverWith(undefined), { params: {} }),
    ).toBeUndefined();
  });

  it("ignores malformed _meta clientInfo", () => {
    const request = {
      params: {
        _meta: { "io.modelcontextprotocol/clientInfo": "not-an-object" },
      },
    };
    expect(
      getClientInfoForRequest(serverWith(undefined), request),
    ).toBeUndefined();
  });

  it("drops non-string fields from partially malformed _meta clientInfo", () => {
    const request = {
      params: {
        _meta: {
          "io.modelcontextprotocol/clientInfo": { name: "x", version: 42 },
        },
      },
    };
    expect(getClientInfoForRequest(serverWith(undefined), request)).toEqual({
      name: "x",
      version: undefined,
    });
  });
});

describe("getProtocolVersion", () => {
  it("reads _meta protocolVersion", () => {
    const request = {
      params: {
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      },
    };
    expect(getProtocolVersion(request)).toBe("2026-07-28");
  });
  it("absent -> undefined", () => {
    expect(getProtocolVersion({ params: {} })).toBeUndefined();
    expect(getProtocolVersion(undefined)).toBeUndefined();
  });
});

describe("buildSessionInfo", () => {
  it("stamps server, client, and identity without touching tracking data", () => {
    const info = buildSessionInfo(
      serverWith(undefined),
      { userId: "u1", userName: "Naseem", userData: { plan: "pro" } },
      { name: "claude", version: "3.0" },
    );
    expect(info.serverName).toBe("srv");
    expect(info.clientName).toBe("claude");
    expect(info.identifyActorGivenId).toBe("u1");
    expect(info.identifyActorName).toBe("Naseem");
    expect(info.identifyActorData).toEqual({ plan: "pro" });
    expect(info.sdkLanguage).toBe("TypeScript");
  });

  it("null identity yields anonymous info", () => {
    const info = buildSessionInfo(serverWith(undefined), null, undefined);
    expect(info.identifyActorGivenId).toBeUndefined();
    expect(info.clientName).toBeUndefined();
  });
});

describe("envelope-first identity ladder (v2 ctx.mcpReq.envelope)", () => {
  const server = {
    getClientVersion: () => ({ name: "from-handshake", version: "9.9.9" }),
  } as any;

  it("prefers ctx.mcpReq.envelope.clientInfo over _meta and handshake", () => {
    const extra = {
      mcpReq: {
        envelope: {
          "io.modelcontextprotocol/clientInfo": {
            name: "env-client",
            version: "2.0",
          },
        },
      },
    };
    const request = {
      params: {
        _meta: {
          "io.modelcontextprotocol/clientInfo": { name: "meta-client" },
        },
      },
    };
    expect(getClientInfoForRequest(server, request, extra)).toEqual({
      name: "env-client",
      version: "2.0",
    });
  });

  it("falls back to _meta (v1 passthrough), then getClientVersion()", () => {
    const request = {
      params: {
        _meta: {
          "io.modelcontextprotocol/clientInfo": { name: "meta-client" },
        },
      },
    };
    expect(getClientInfoForRequest(server, request, {})).toEqual({
      name: "meta-client",
      version: undefined,
    });
    expect(getClientInfoForRequest(server, { params: {} }, {})).toEqual({
      name: "from-handshake",
      version: "9.9.9",
    });
  });

  it("rejects non-string envelope fields (field-level narrowing)", () => {
    const extra = {
      mcpReq: {
        envelope: { "io.modelcontextprotocol/clientInfo": { name: 42 } },
      },
    };
    expect(getClientInfoForRequest(server, { params: {} }, extra)).toEqual({
      name: "from-handshake",
      version: "9.9.9",
    });
  });

  it("getProtocolVersion prefers the envelope, then _meta", () => {
    const extra = {
      mcpReq: {
        envelope: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      },
    };
    const request = {
      params: {
        _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" },
      },
    };
    expect(getProtocolVersion(request, extra)).toBe("2026-07-28");
    expect(getProtocolVersion(request, {})).toBe("2025-11-25");
    expect(getProtocolVersion({ params: {} }, {})).toBeUndefined();
  });
});

describe("resolveIdentity", () => {
  const dataWith = (identify?: any) =>
    ({ projectId: "p", options: { identify } }) as any;

  it("returns the identify result", async () => {
    const identity = await resolveIdentity(
      dataWith(async () => ({ userId: "u1" })),
      { params: {} },
    );
    expect(identity).toEqual({ userId: "u1" });
  });

  it("no identify configured -> null", async () => {
    expect(
      await resolveIdentity(dataWith(undefined), { params: {} }),
    ).toBeNull();
  });

  it("identify throwing -> null, never throws", async () => {
    expect(
      await resolveIdentity(
        dataWith(() => {
          throw new Error("boom");
        }),
        { params: {} },
      ),
    ).toBeNull();
  });

  it("runs on every call — no caching between calls", async () => {
    let calls = 0;
    const data = dataWith(async () => ({ userId: `u${++calls}` }));
    expect((await resolveIdentity(data, { params: {} }))!.userId).toBe("u1");
    expect((await resolveIdentity(data, { params: {} }))!.userId).toBe("u2");
  });
});
