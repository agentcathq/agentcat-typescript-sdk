import { beforeEach } from "vitest";
import {
  resetServerInfoStateForTests,
  setServerInfoSender,
} from "../../modules/serverInfo.js";
import { serverInfoRecorder } from "../test-utils/server-info-recorder.js";

// The recorder takes the place of the real server info sender in every
// Workers test, and each test starts with an empty heartbeat memory. A test
// that needs the real sender restores it with setServerInfoSender().
beforeEach(() => {
  serverInfoRecorder.reset();
  setServerInfoSender(serverInfoRecorder.sender);
  resetServerInfoStateForTests();
});
