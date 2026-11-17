import { beforeEach } from "vitest";
import { serverInfoRecorder } from "./test-utils/server-info-recorder.js";

// Belt-and-suspenders: the SDK also auto-disables diagnostics in test
// environments, but this guarantees no test run ever ships OTLP diagnostics
// to the live collector regardless of ordering or future detection changes.
// Tests that exercise diagnostics opt back in with DISABLE_DIAGNOSTICS=false
// and a mocked fetch.
process.env.DISABLE_DIAGNOSTICS = "true";

// Every tracked tools/list request starts a server info heartbeat. The
// recorder takes the place of the real sender, so no test sends one to the
// AgentCat API; each test starts with an empty heartbeat memory. The import
// is dynamic so that it resolves after the test file's vi.mock calls: a
// static import here would load the SDK modules before those mocks exist.
beforeEach(async () => {
  const { resetServerInfoStateForTests, setServerInfoSender } =
    await import("../modules/serverInfo.js");
  serverInfoRecorder.reset();
  setServerInfoSender(serverInfoRecorder.sender);
  resetServerInfoStateForTests();
});
