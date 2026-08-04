// src/modules/runtime-versions.ts
import { createRequire } from "module";
import packageJson from "../../package.json" with { type: "json" };

export interface RuntimeVersions {
  sdk: string;
  node: string | null;
  mcpV1: string | null;
  mcpV2: string | null;
}

export function loadNodeModule<T>(name: string): T | null {
  try {
    return createRequire(import.meta.url)(name) as T;
  } catch {
    return null;
  }
}

/**
 * Reads an installed package's version even when its exports map seals
 * "./package.json" (the v2 MCP packages do): resolve the entry module,
 * then walk up the real directory tree to the package manifest.
 */
export function readInstalledPackageVersion(name: string): string | null {
  const direct = loadNodeModule<{ version?: string }>(`${name}/package.json`);
  if (direct?.version) return direct.version;
  try {
    const req = createRequire(import.meta.url);
    const path = loadNodeModule<typeof import("path")>("path");
    const fs = loadNodeModule<typeof import("fs")>("fs");
    if (!path || !fs) return null;
    // Anchor on the package entry; some packages (e.g. v1 SDK >= 1.30) have
    // no root "." export, but do export "./package.json" (as a dist stub) —
    // its dirname is an equally valid starting point for the walk-up.
    let anchor: string;
    try {
      anchor = req.resolve(name);
    } catch {
      anchor = req.resolve(`${name}/package.json`);
    }
    let dir = path.dirname(anchor);
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, "package.json");
      try {
        if (fs.existsSync(candidate)) {
          const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"));
          if (pkg?.name === name) return pkg.version ?? null;
        }
      } catch {
        // malformed or unreadable manifest at this level; keep climbing
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // best-effort
  }
  return null;
}

// Resolved once per process: MCP resolution walks the filesystem, and
// writeToLog stamps every line, so this must not re-run per call.
let cachedVersions: RuntimeVersions | null = null;
let cachedPrefix: string | null = null;

// workerd cannot resolve node_modules; attempting it there makes test pools
// and dev tooling log loud module-resolution failures. Cloudflare documents
// this userAgent value as the supported runtime detection.
function isCloudflareWorkers(): boolean {
  try {
    const nav = (globalThis as { navigator?: { userAgent?: string } })
      .navigator;
    return nav?.userAgent === "Cloudflare-Workers";
  } catch {
    return false;
  }
}

export function getRuntimeVersions(): RuntimeVersions {
  if (cachedVersions) return cachedVersions;
  let node: string | null = null;
  try {
    node = globalThis.process?.version ?? null;
  } catch {
    node = null;
  }
  const resolvePackages = !isCloudflareWorkers();
  cachedVersions = {
    sdk: packageJson.version,
    node,
    mcpV1: resolvePackages
      ? readInstalledPackageVersion("@modelcontextprotocol/sdk")
      : null,
    mcpV2: resolvePackages
      ? readInstalledPackageVersion("@modelcontextprotocol/server")
      : null,
  };
  return cachedVersions;
}

/**
 * "[sdk=… node=… mcp=…( mcp2=…)]" — stamped onto every log line so a single
 * pasted line identifies the SDK, runtime, and MCP SDK that produced it.
 * Never throws: writeToLog must stay safe on edge runtimes.
 */
export function getVersionLogPrefix(): string {
  if (cachedPrefix) return cachedPrefix;
  try {
    const v = getRuntimeVersions();
    const parts = [`sdk=${v.sdk}`, `node=${v.node ?? "unknown"}`];
    if (v.mcpV1) parts.push(`mcp=${v.mcpV1}`);
    if (v.mcpV2) parts.push(`mcp2=${v.mcpV2}`);
    if (!v.mcpV1 && !v.mcpV2) parts.push("mcp=unknown");
    cachedPrefix = `[${parts.join(" ")}]`;
  } catch {
    cachedPrefix = "[sdk=unknown node=unknown mcp=unknown]";
  }
  return cachedPrefix;
}

export function _resetVersionCacheForTest(): void {
  cachedVersions = null;
  cachedPrefix = null;
}
