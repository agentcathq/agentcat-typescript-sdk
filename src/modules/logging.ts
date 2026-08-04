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

/**
 * Attempts to initialize Node.js file logging.
 * Falls back to console.log in edge environments where fs/os modules are unavailable.
 */
function tryInitSync(): void {
  if (initAttempted) return;
  initAttempted = true;

  try {
    // Use createRequire for ESM compatibility
    // Works in Node.js ESM/CJS, fails gracefully in Workers/edge environments
    const require = createRequire(import.meta.url);
    const fs = require("fs");
    const os = require("os");
    const path = require("path");

    const home = os.homedir?.();
    if (home) {
      fsModule = fs;
      logFilePath = path.join(home, "agentcat.log");
    } else {
      // homedir() returned null/undefined - use console fallback
      useConsoleFallback = true;
    }
  } catch {
    // Module not available or homedir() not implemented - use console fallback
    useConsoleFallback = true;
    fsModule = null;
    logFilePath = null;
  }
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
