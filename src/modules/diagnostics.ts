// src/modules/diagnostics.ts
import { createRequire } from "module";
import { setDiagnosticsSink } from "./logging.js";
import {
  DIAGNOSTICS_SCOPE_NAME,
  DEFAULT_DIAGNOSTICS_ENDPOINT,
  DEFAULT_DIAGNOSTICS_TOKEN,
} from "./constants.js";
import packageJson from "../../package.json" with { type: "json" };

let enabled = false;
let initialized = false;

interface OtlpAttribute {
  key: string;
  value: { stringValue: string };
}

let staticAttributes: OtlpAttribute[] = [];

const MAX_BUFFER = 1000;
const BATCH_FLUSH_MS = 2000;
let buffer: OtlpLogRecord[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function resolveEndpoint(): string {
  let base = DEFAULT_DIAGNOSTICS_ENDPOINT;
  try {
    base = globalThis.process?.env?.DIAGNOSTICS_ENDPOINT || base;
  } catch {
    // ignore
  }
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith("/v1/logs") ? trimmed : `${trimmed}/v1/logs`;
}

function resolveToken(): string {
  try {
    return (
      globalThis.process?.env?.DIAGNOSTICS_TOKEN || DEFAULT_DIAGNOSTICS_TOKEN
    );
  } catch {
    return DEFAULT_DIAGNOSTICS_TOKEN;
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  try {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushDiagnostics();
    }, BATCH_FLUSH_MS);
    // Do not keep the event loop alive solely for diagnostics.
    (flushTimer as any)?.unref?.();
  } catch {
    flushTimer = null;
  }
}

function attr(key: string, value: string | undefined | null): OtlpAttribute[] {
  return value ? [{ key, value: { stringValue: String(value) } }] : [];
}

function loadNodeModule<T>(name: string): T | null {
  try {
    return createRequire(import.meta.url)(name) as T;
  } catch {
    return null;
  }
}

function computeInstallId(): string | null {
  try {
    const os = loadNodeModule<typeof import("os")>("os");
    const crypto = loadNodeModule<typeof import("crypto")>("crypto");
    if (!os || !crypto) return null;
    const seed = `${os.hostname?.() ?? ""}|${import.meta.url}`;
    return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

function buildStaticAttributes(projectId: string | null): OtlpAttribute[] {
  const out: OtlpAttribute[] = [];
  try {
    // Identity / traceability
    if (projectId) {
      out.push(...attr("agentcat.project_id", projectId));
    } else {
      out.push(...attr("agentcat.install_id", computeInstallId()));
    }

    // SDK
    out.push(...attr("agentcat.sdk.language", "typescript"));
    out.push(...attr("agentcat.sdk.version", packageJson.version));

    // Best-effort: resolved @modelcontextprotocol/sdk (peer dep) version.
    const mcpPkg = loadNodeModule<{ version?: string }>(
      "@modelcontextprotocol/sdk/package.json",
    );
    out.push(...attr("agentcat.mcp_sdk.version", mcpPkg?.version));

    // Runtime
    const proc = globalThis.process;
    out.push(
      ...attr(
        "process.runtime.name",
        proc?.versions?.node ? "nodejs" : "other",
      ),
    );
    out.push(...attr("process.runtime.version", proc?.version));
    out.push(
      ...attr("process.pid", proc?.pid != null ? String(proc.pid) : null),
    );

    // OS / host
    const os = loadNodeModule<typeof import("os")>("os");
    if (os) {
      out.push(...attr("os.type", os.platform?.()));
      out.push(...attr("os.version", os.release?.()));
      out.push(...attr("host.arch", os.arch?.()));
      out.push(
        ...attr("host.cpu.count", os.cpus ? String(os.cpus().length) : null),
      );
    }

    // Deploy/CI hints
    out.push(...attr("deployment.environment", proc?.env?.NODE_ENV));
  } catch {
    // best-effort; partial attributes are fine
  }
  return out;
}

export function _getStaticAttributesForTest(): OtlpAttribute[] {
  return staticAttributes;
}

interface OtlpLogRecord {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: OtlpAttribute[];
}

function inferSeverity(entry: string): { number: number; text: string } {
  if (/fail|error/i.test(entry)) return { number: 17, text: "ERROR" };
  if (entry.includes("Warning:")) return { number: 13, text: "WARN" };
  return { number: 9, text: "INFO" };
}

function buildRecord(entry: string): OtlpLogRecord {
  const sev = inferSeverity(entry);
  return {
    timeUnixNano: (BigInt(Date.now()) * BigInt(1_000_000)).toString(),
    severityNumber: sev.number,
    severityText: sev.text,
    body: { stringValue: entry },
    attributes: [],
  };
}

export function _buildRecordForTest(entry: string): OtlpLogRecord {
  return buildRecord(entry);
}

function isTestEnvironment(): boolean {
  try {
    const env = globalThis.process?.env;
    return Boolean(
      env?.VITEST || env?.JEST_WORKER_ID || env?.NODE_ENV === "test",
    );
  } catch {
    return false;
  }
}

function envDiagnosticsFlag(): "disabled" | "force-enabled" | "unset" {
  try {
    const raw = globalThis.process?.env?.DISABLE_DIAGNOSTICS;
    if (raw == null || raw.trim() === "") return "unset";
    // Interpret the value rather than treating mere presence as truthy. An
    // explicitly falsy value (DISABLE_DIAGNOSTICS=false / 0 / no / off) is a
    // deliberate opt-in that also overrides test-environment detection.
    const normalized = raw.trim().toLowerCase();
    return ["false", "0", "no", "off"].includes(normalized)
      ? "force-enabled"
      : "disabled";
  } catch {
    return "unset";
  }
}

export function initDiagnostics(opts: {
  projectId: string | null;
  disabled?: boolean;
}): void {
  try {
    if (initialized) return;
    initialized = true;
    const flag = envDiagnosticsFlag();
    enabled =
      !opts.disabled &&
      flag !== "disabled" &&
      (flag === "force-enabled" || !isTestEnvironment());
    if (!enabled) return;
    staticAttributes = buildStaticAttributes(opts.projectId);
    setDiagnosticsSink(capture);
  } catch {
    // diagnostics init must never throw
  }
}

function capture(entry: string): void {
  try {
    if (!enabled) return;
    if (buffer.length >= MAX_BUFFER) buffer.shift();
    buffer.push(buildRecord(entry));
    scheduleFlush();
  } catch {
    // diagnostics capture must never throw
  }
}

export async function flushDiagnostics(): Promise<void> {
  try {
    if (!enabled || buffer.length === 0) return;
    const records = buffer;
    buffer = [];

    const payload = {
      resourceLogs: [
        {
          resource: { attributes: staticAttributes },
          scopeLogs: [
            {
              scope: {
                name: DIAGNOSTICS_SCOPE_NAME,
                version: packageJson.version,
              },
              logRecords: records,
            },
          ],
        },
      ],
    };

    const token = resolveToken();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    await fetch(resolveEndpoint(), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch {
    // fire-and-forget: never propagate diagnostics network errors
  }
}

export function isDiagnosticsEnabled(): boolean {
  return enabled;
}

export function _resetDiagnosticsForTest(): void {
  enabled = false;
  initialized = false;
  staticAttributes = [];
  buffer = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  setDiagnosticsSink(null);
}
