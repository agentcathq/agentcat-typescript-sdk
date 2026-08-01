import { Detection } from "../detect.js";
import { v1Adapter } from "../adapters/v1.js";
import { v2Adapter } from "../adapters/v2.js";
import { initEngineState } from "./registry.js";
import { installListWrap } from "./listWrap.js";
import { installCallWrap } from "./callWrap.js";
import { patchSetRequestHandler } from "./registrationPatch.js";
import { installRegistryProxy, rewrapAllTools } from "./innerTap.js";

/**
 * Installs the full interception engine on a detected server:
 * map-seam wraps for tools/list + tools/call, the registration re-arm
 * patch, and (high-level flavor) the registry proxy + initial inner-tap
 * sweep.
 */
export function installEngine(detection: Detection): void {
  const server = detection.lowLevel;
  const adapter = detection.major === 2 ? v2Adapter : v1Adapter;
  initEngineState(server, { adapter, highLevel: detection.highLevel });

  const rearm = () => {
    installListWrap(server);
    installCallWrap(server);
  };

  patchSetRequestHandler(server, rearm);
  if (detection.highLevel) {
    installRegistryProxy(server, detection.highLevel, adapter, rearm);
  }
  rearm();
  if (detection.highLevel) {
    rewrapAllTools(server, detection.highLevel, adapter);
  }
}
