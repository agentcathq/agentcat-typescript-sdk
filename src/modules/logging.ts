import { createRequire } from "module";
import { getVersionLogPrefix } from "./runtime-versions.js";

// Lazy-loaded module references for Node.js file logging
// These are loaded dynamically to support edge environments (Cloudflare Workers, etc.)
let fsModule: typeof import("fs") | null = null;
let logFilePath: string | null = null;
let initAttempted = false;
let useConsoleFallback = false;

let diagnosticsSink: ((entry: string) => void) | null = null;

export function setDiagnosticsSink(fn: ((entry: string) => void) | null): void {
  diagnosticsSink = fn;
}

export type LogTarget =
  | { kind: "file"; fs: typeof import("fs"); path: string }
  | { kind: "console" }
  | { kind: "silent" };

/**
 * Decides where log lines go. Pure so the decision is testable:
 *
 * - `file`: Node-like runtime with a resolvable home directory.
 * - `console`: fs/os modules unavailable — an edge isolate (Workers), where
 *   console is the only sink and no stdio protocol channel exists.
 * - `silent`: a Node-like runtime whose home directory cannot be resolved
 *   (containers running an arbitrary UID with no passwd entry, HOME unset).
 *   Logging is dropped entirely rather than falling back to console:
 *   stdout IS the JSON-RPC wire for stdio-transport MCP servers, and one
 *   stray line per event would corrupt the protocol stream. The diagnostics
 *   sink still receives every entry.
 */
export function resolveLogTarget(
  loadModules: () => {
    fs: typeof import("fs");
    os: { homedir?: () => string | undefined };
    path: { join: (...parts: string[]) => string };
  },
): LogTarget {
  let mods;
  try {
    mods = loadModules();
  } catch {
    return { kind: "console" };
  }
  try {
    const home = mods.os.homedir?.();
    if (home) {
      return {
        kind: "file",
        fs: mods.fs,
        path: mods.path.join(home, "agentcat.log"),
      };
    }
  } catch {
    // homedir threw (ENOENT on no-passwd-entry containers) — silent below.
  }
  return { kind: "silent" };
}

/**
 * Attempts to initialize Node.js file logging.
 */
function tryInitSync(): void {
  if (initAttempted) return;
  initAttempted = true;

  const target = resolveLogTarget(() => {
    // Use createRequire for ESM compatibility
    // Works in Node.js ESM/CJS, throws in Workers/edge environments
    const require = createRequire(import.meta.url);
    return { fs: require("fs"), os: require("os"), path: require("path") };
  });
  if (target.kind === "file") {
    fsModule = target.fs;
    logFilePath = target.path;
  } else if (target.kind === "console") {
    useConsoleFallback = true;
  }
  // "silent": all state stays null — writeToLog drops messages after the
  // diagnostics tee.
}

export function writeToLog(message: string): void {
  tryInitSync();

  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${getVersionLogPrefix()} ${message}`;

  // Tee to diagnostics if registered. Must never break logging.
  try {
    diagnosticsSink?.(logEntry);
  } catch {
    // diagnostics must never break logging
  }

  if (useConsoleFallback) {
    console.log(`[agentcat] ${logEntry}`);
    return;
  }

  // Node.js environment: write to file
  if (!logFilePath || !fsModule) {
    return;
  }

  try {
    if (!fsModule.existsSync(logFilePath)) {
      fsModule.writeFileSync(logFilePath, logEntry + "\n");
    } else {
      fsModule.appendFileSync(logFilePath, logEntry + "\n");
    }
  } catch {
    // Silently fail to avoid breaking the server
  }
}
