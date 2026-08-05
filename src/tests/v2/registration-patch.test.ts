import { describe, it, expect } from "vitest";
import { Server } from "@modelcontextprotocol/server";
import { z } from "zod4";
import { patchSetRequestHandler } from "../../engine/registrationPatch.js";

describe("patchSetRequestHandler on v2", () => {
  it("fires the re-arm callback for string tools/call registrations", () => {
    const server = new Server(
      { name: "t", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    let fired = 0;
    patchSetRequestHandler(server as any, () => fired++);
    server.setRequestHandler("tools/call", async () => ({ content: [] }));
    expect(fired).toBe(1);
    expect((server as any)._requestHandlers.has("tools/call")).toBe(true);
  });

  it("forwards 3-arg custom registrations intact (regression: dropped handler)", () => {
    const server = new Server(
      { name: "t", version: "1.0.0" },
      { capabilities: {} },
    );
    patchSetRequestHandler(server as any, () => {});
    expect(() =>
      server.setRequestHandler(
        "acme/search",
        { params: z.object({ q: z.string() }) },
        async (params: { q: string }) => ({ hits: [params.q] }),
      ),
    ).not.toThrow();
    expect((server as any)._requestHandlers.has("acme/search")).toBe(true);
  });

  it("does not fire for non-tool methods", () => {
    const server = new Server(
      { name: "t", version: "1.0.0" },
      { capabilities: { resources: {} } },
    );
    let fired = 0;
    patchSetRequestHandler(server as any, () => fired++);
    server.setRequestHandler("resources/list", async () => ({ resources: [] }));
    expect(fired).toBe(0);
  });
});
