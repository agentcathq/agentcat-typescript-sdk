// src/tests/logging-version-prefix.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { writeToLog, setDiagnosticsSink } from "../modules/logging.js";
import {
  getRuntimeVersions,
  _resetVersionCacheForTest,
} from "../modules/runtime-versions.js";
import packageJson from "../../package.json" with { type: "json" };

const LOG_PATH = join(homedir(), "agentcat.log");

// [<ISO timestamp>] [sdk=… node=… mcp=…( mcp2=…)?] <message>
const PREFIXED_LINE =
  /^\[\d{4}-\d{2}-\d{2}T[0-9:.]+Z\] \[sdk=([^\s\]]+) node=([^\s\]]+)( mcp=([^\s\]]+))?( mcp2=([^\s\]]+))?\] (.*)$/;

describe("version-info prefix on every log line", () => {
  afterEach(() => setDiagnosticsSink(null));

  it("prefixes sink entries with sdk, node, and mcp versions", () => {
    const seen: string[] = [];
    setDiagnosticsSink((entry) => seen.push(entry));
    writeToLog("hello prefix");

    expect(seen).toHaveLength(1);
    const m = seen[0].match(PREFIXED_LINE);
    expect(m, `line did not match prefix shape: ${seen[0]}`).toBeTruthy();
    const [, sdk, node, , mcpV1, , mcpV2, message] = m!;
    expect(sdk).toBe(packageJson.version);
    expect(node).toBe(process.version);
    expect(mcpV1).toMatch(/^1\./); // devDep is ~1.30.0
    expect(mcpV2).toMatch(/^2\./); // devDep is ^2
    expect(message).toBe("hello prefix");
  });

  it("writes the prefixed entry to the log file", () => {
    const offset = existsSync(LOG_PATH) ? statSync(LOG_PATH).size : 0;
    writeToLog("file prefix check");

    expect(existsSync(LOG_PATH)).toBe(true);
    const appended = readFileSync(LOG_PATH).subarray(offset).toString("utf8");
    const line = appended
      .split("\n")
      .find((l) => l.includes("file prefix check"));
    expect(line, `no appended line found in: ${appended}`).toBeTruthy();
    expect(line).toMatch(PREFIXED_LINE);
    expect(line).toContain(`sdk=${packageJson.version}`);
  });

  it("caches the prefix so repeated logging stays consistent", () => {
    const seen: string[] = [];
    setDiagnosticsSink((entry) => seen.push(entry));
    writeToLog("first");
    writeToLog("second");

    const prefixOf = (entry: string) => entry.match(PREFIXED_LINE)?.slice(1, 7);
    expect(prefixOf(seen[0])).toEqual(prefixOf(seen[1]));
  });

  it("skips MCP package resolution on Cloudflare Workers", () => {
    // workerd module resolution cannot reach node_modules; attempting it there
    // makes the workers test pool log loud resolution failures.
    _resetVersionCacheForTest();
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    try {
      const v = getRuntimeVersions();
      expect(v.sdk).toBe(packageJson.version);
      expect(v.mcpV1).toBeNull();
      expect(v.mcpV2).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      _resetVersionCacheForTest();
    }
  });
});
