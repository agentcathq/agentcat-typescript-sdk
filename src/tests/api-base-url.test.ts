import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MCPCatOptions } from "../types.js";
import { setupTestHooks } from "./test-utils.js";

describe("MCPCatOptions apiBaseUrl", () => {
  it("should accept apiBaseUrl as an optional string property", () => {
    const options: MCPCatOptions = {
      apiBaseUrl: "https://custom.example.com",
    };
    expect(options.apiBaseUrl).toBe("https://custom.example.com");
  });

  it("should be undefined when not set", () => {
    const options: MCPCatOptions = {};
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
vi.mock("../modules/tools.js");
vi.mock("../modules/tracing.js");
vi.mock("../modules/tracingV2.js");
vi.mock("../modules/telemetry.js");

import {
  isCompatibleServerType,
  isHighLevelServer,
} from "../modules/compatibility.js";
import { getSessionInfo, newSessionId } from "../modules/session.js";
import {
  setServerTrackingData,
  getServerTrackingData,
} from "../modules/internal.js";

// Import track after all mocks
const { track } = await import("../index.js");

describe("track() URL resolution", () => {
  setupTestHooks();

  const savedEnv = process.env.MCPCAT_API_URL;

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

    // Setup mock implementations as regular functions so `new` works
    (Configuration as any).mockImplementation(function () {
      return {};
    });
    (EventsApi as any).mockImplementation(function () {
      return { publishEvent: vi.fn().mockResolvedValue({}) };
    });

    // Setup compatibility mocks: return the server as-is (low-level server)
    (isCompatibleServerType as any).mockReturnValue(mockServer);
    (isHighLevelServer as any).mockReturnValue(false);

    // Setup session/internal mocks
    (getSessionInfo as any).mockReturnValue({});
    (newSessionId as any).mockReturnValue("ses_test123");
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

  it("should not call configure() when neither option nor env var is set", () => {
    delete process.env.MCPCAT_API_URL;

    track(mockServer, "proj_test123", {});

    expect(eventQueue.configure).not.toHaveBeenCalled();
  });
});
