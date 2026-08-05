import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentCatOptions } from "../types.js";
import { setupTestHooks } from "./test-utils.js";

describe("AgentCatOptions apiBaseUrl", () => {
  it("should accept apiBaseUrl as an optional string property", () => {
    const options: AgentCatOptions = {
      apiBaseUrl: "https://custom.example.com",
    };
    expect(options.apiBaseUrl).toBe("https://custom.example.com");
  });

  it("should be undefined when not set", () => {
    const options: AgentCatOptions = {};
    expect(options.apiBaseUrl).toBeUndefined();
  });
});

// Mock external dependencies (same pattern as eventQueue.test.ts)
vi.mock("agentcat-api");
vi.mock("../modules/logging.js");
vi.mock("../thirdparty/ksuid/index.js");

// Import mocked modules
import { Configuration, EventsApi } from "agentcat-api";

// Import the module under test after mocking
const { eventQueue } = await import("../modules/eventQueue.js");

describe("EventQueue.configure()", () => {
  setupTestHooks();

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup mock implementations as regular functions (not arrow functions) so `new` works
    (Configuration as any).mockImplementation(function () {
      return {};
    });
    (EventsApi as any).mockImplementation(function () {
      return { publishEvent: vi.fn().mockResolvedValue({}) };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should reconfigure the apiClient with the given base URL", () => {
    // Clear the constructor call from EventQueue's constructor
    (Configuration as any).mockClear();

    eventQueue.configure("https://custom.example.com");

    expect(Configuration).toHaveBeenCalledWith({
      basePath: "https://custom.example.com",
    });
  });
});

// Additional mocks needed for track() tests
vi.mock("../modules/compatibility.js");
vi.mock("../modules/session.js");
vi.mock("../modules/internal.js");
vi.mock("../engine/index.js");
vi.mock("../modules/telemetry.js");

import { isCompatibleServerType } from "../modules/compatibility.js";
import {
  setServerTrackingData,
  getServerTrackingData,
} from "../modules/internal.js";

// Import track after all mocks
const { track } = await import("../index.js");

describe("track() URL resolution", () => {
  setupTestHooks();

  const savedEnv = process.env.MCPCAT_API_URL;
  const savedAgentcatEnv = process.env.AGENTCAT_API_URL;

  // Create a mock server object that passes isCompatibleServerType
  const mockServer = {
    _requestHandlers: new Map(),
    _serverInfo: { name: "test-server", version: "1.0.0" },
    getClientVersion: () => undefined,
    setRequestHandler: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MCPCAT_API_URL;
    delete process.env.AGENTCAT_API_URL;

    // Setup mock implementations as regular functions so `new` works
    (Configuration as any).mockImplementation(function () {
      return {};
    });
    (EventsApi as any).mockImplementation(function () {
      return { publishEvent: vi.fn().mockResolvedValue({}) };
    });

    // Setup compatibility mock: return the server as-is (low-level server).
    // detectServer runs for real against mockServer's v1-low shape; the
    // engine install is mocked out (unit test scope is URL resolution).
    (isCompatibleServerType as any).mockReturnValue(mockServer);

    // Setup internal mocks
    (getServerTrackingData as any).mockReturnValue(null); // Not yet tracked
    (setServerTrackingData as any).mockImplementation(() => {});

    // Spy on eventQueue.configure
    vi.spyOn(eventQueue, "configure");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore env var
    if (savedEnv !== undefined) {
      process.env.MCPCAT_API_URL = savedEnv;
    } else {
      delete process.env.MCPCAT_API_URL;
    }
    if (savedAgentcatEnv !== undefined) {
      process.env.AGENTCAT_API_URL = savedAgentcatEnv;
    } else {
      delete process.env.AGENTCAT_API_URL;
    }
  });

  it("should call configure() when apiBaseUrl option is provided", () => {
    track(mockServer, "proj_test123", {
      apiBaseUrl: "https://custom-api.example.com",
    });

    expect(eventQueue.configure).toHaveBeenCalledWith(
      "https://custom-api.example.com",
    );
  });

  it("should call configure() with MCPCAT_API_URL env var when no option is set", () => {
    process.env.MCPCAT_API_URL = "https://env-api.example.com";

    track(mockServer, "proj_test123", {});

    expect(eventQueue.configure).toHaveBeenCalledWith(
      "https://env-api.example.com",
    );
  });

  it("should call configure() with AGENTCAT_API_URL env var when no option is set", () => {
    process.env.AGENTCAT_API_URL = "https://agentcat-env.example.com";

    track(mockServer, "proj_test123", {});

    expect(eventQueue.configure).toHaveBeenCalledWith(
      "https://agentcat-env.example.com",
    );
  });

  it("should prioritize AGENTCAT_API_URL over legacy MCPCAT_API_URL", () => {
    process.env.AGENTCAT_API_URL = "https://agentcat-env.example.com";
    process.env.MCPCAT_API_URL = "https://legacy-env.example.com";

    track(mockServer, "proj_test123", {});

    expect(eventQueue.configure).toHaveBeenCalledWith(
      "https://agentcat-env.example.com",
    );
  });

  it("should fall back to legacy MCPCAT_API_URL when AGENTCAT_API_URL is unset", () => {
    delete process.env.AGENTCAT_API_URL;
    process.env.MCPCAT_API_URL = "https://legacy-env.example.com";

    track(mockServer, "proj_test123", {});

    expect(eventQueue.configure).toHaveBeenCalledWith(
      "https://legacy-env.example.com",
    );
  });

  it("should prioritize apiBaseUrl option over MCPCAT_API_URL env var", () => {
    process.env.MCPCAT_API_URL = "https://env-api.example.com";

    track(mockServer, "proj_test123", {
      apiBaseUrl: "https://option-api.example.com",
    });

    expect(eventQueue.configure).toHaveBeenCalledWith(
      "https://option-api.example.com",
    );
    expect(eventQueue.configure).toHaveBeenCalledTimes(1);
  });

  it("should prioritize apiBaseUrl option over AGENTCAT_API_URL env var", () => {
    process.env.AGENTCAT_API_URL = "https://agentcat-env.example.com";

    track(mockServer, "proj_test123", {
      apiBaseUrl: "https://option-api.example.com",
    });

    expect(eventQueue.configure).toHaveBeenCalledWith(
      "https://option-api.example.com",
    );
    expect(eventQueue.configure).toHaveBeenCalledTimes(1);
  });

  it("should not call configure() when neither option nor env var is set", () => {
    delete process.env.MCPCAT_API_URL;

    track(mockServer, "proj_test123", {});

    expect(eventQueue.configure).not.toHaveBeenCalled();
  });
});
