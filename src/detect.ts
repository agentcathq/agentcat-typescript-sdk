import { HighLevelMCPServerLike, MCPServerLike } from "./types.js";

export type SdkMajor = 1 | 2;
export type ServerFlavor = "high" | "low";

export interface Detection {
  major: SdkMajor;
  flavor: ServerFlavor;
  lowLevel: MCPServerLike;
  highLevel?: HighLevelMCPServerLike;
  /** Raw feature-detection signals — logged for fleet-level change detection. */
  signals: Record<string, boolean>;
}

/**
 * Per-object feature detection. No module resolution, no SDK imports:
 * the object in hand is the only evidence.
 *
 * v1 high-level: has .tool() (removed in v2).
 * v2 high-level: no .tool(), has registerTool().
 * v2 low-level:  has projectCallToolResult() (v2-only Server method) or the
 *                _negotiatedWireCodec internal; otherwise v1 low-level.
 */
/**
 * Single source of truth for the probe list: both detection and the
 * shape-fingerprint beacon read the same signals, so they cannot drift.
 */
function collectSignals(s: any): {
  signals: Record<string, boolean>;
  low: any;
} {
  const signals: Record<string, boolean> = {
    hasServerProp: !!(s.server && typeof s.server === "object"),
    hasTool: typeof s.tool === "function",
    hasRegisterTool: typeof s.registerTool === "function",
  };
  const low = signals.hasServerProp ? s.server : s;
  signals.hasSetRequestHandler = typeof low?.setRequestHandler === "function";
  signals.hasRequestHandlersMap = low?._requestHandlers instanceof Map;
  signals.hasProjectCallToolResult =
    typeof low?.projectCallToolResult === "function";
  signals.hasNegotiatedWireCodec =
    typeof low?._negotiatedWireCodec === "function";
  return { signals, low };
}

export function detectServer(server: unknown): Detection | null {
  if (!server || typeof server !== "object") return null;
  const s = server as any;

  const { signals, low } = collectSignals(s);

  if (!signals.hasSetRequestHandler || !signals.hasRequestHandlersMap) {
    return null;
  }

  const flavor: ServerFlavor = signals.hasServerProp ? "high" : "low";
  let major: SdkMajor;
  if (flavor === "high") {
    if (signals.hasTool) major = 1;
    else if (signals.hasRegisterTool) major = 2;
    else return null;
  } else {
    major =
      signals.hasProjectCallToolResult || signals.hasNegotiatedWireCodec
        ? 2
        : 1;
  }

  return {
    major,
    flavor,
    lowLevel: low as MCPServerLike,
    highLevel: flavor === "high" ? (s as HighLevelMCPServerLike) : undefined,
    signals,
  };
}

export function describeSignals(signals: Record<string, boolean>): string {
  return Object.entries(signals)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(",");
}

/**
 * Shape-fingerprint for diagnostics: the exact signals detection computed,
 * rendered for the log. Emitted when a server shape is unrecognized so a
 * fleet-level "new SDK shape appeared" change is visible in the beacon
 * stream. Empty string when the input is not an object.
 */
export function fingerprintServerShape(server: unknown): string {
  if (!server || typeof server !== "object") return "";
  return describeSignals(collectSignals(server as any).signals);
}
