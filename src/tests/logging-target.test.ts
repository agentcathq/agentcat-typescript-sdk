import { describe, it, expect } from "vitest";
import { resolveLogTarget } from "../modules/logging.js";

const nodeModules = (homedir: (() => string | undefined) | undefined) =>
  (() => ({
    fs: { appendFileSync: () => {} } as any,
    os: { homedir } as any,
    path: { join: (...parts: string[]) => parts.join("/") } as any,
  })) as any;

describe("resolveLogTarget", () => {
  it("targets the home log file on a healthy Node runtime", () => {
    const target = resolveLogTarget(nodeModules(() => "/home/u"));
    expect(target.kind).toBe("file");
    expect((target as any).path).toBe("/home/u/agentcat.log");
  });

  it("targets console only when the runtime lacks fs/os modules (edge isolates)", () => {
    const target = resolveLogTarget(() => {
      throw new Error("no module");
    });
    expect(target.kind).toBe("console");
  });

  it("goes silent — never console — when homedir resolves falsy on Node", () => {
    // Console would be stdout: the JSON-RPC wire of stdio-transport servers.
    const target = resolveLogTarget(nodeModules(() => undefined));
    expect(target.kind).toBe("silent");
  });

  it("goes silent — never console — when homedir throws on Node", () => {
    // ENOENT from a container with no passwd entry for the current UID.
    const target = resolveLogTarget(
      nodeModules(() => {
        throw new Error("ENOENT: no such file or directory, uv_os_homedir");
      }),
    );
    expect(target.kind).toBe("silent");
  });

  it("goes silent when os.homedir is not implemented at all", () => {
    const target = resolveLogTarget(nodeModules(undefined));
    expect(target.kind).toBe("silent");
  });
});
