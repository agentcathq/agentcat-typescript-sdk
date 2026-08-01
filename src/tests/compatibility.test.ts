import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isCompatibleServerType,
  getMCPCompatibleErrorMessage,
  logCompatibilityWarning,
  SUPPORT_MATRIX_SUFFIX,
} from "../modules/compatibility";

// Mock the logging module
vi.mock("../modules/logging", () => ({
  writeToLog: vi.fn(),
}));

// Import after mocking
import { writeToLog } from "../modules/logging";

describe("Compatibility Module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isCompatibleServerType", () => {
    it("should validate a fully compatible server", () => {
      const validServer = {
        setRequestHandler: vi.fn(),
        _requestHandlers: new Map([["test", vi.fn()]]),
        getClientVersion: vi.fn(),
        _serverInfo: { name: "TestServer" },
      };

      const result = isCompatibleServerType(validServer);
      expect(result).toBe(validServer);
      expect(writeToLog).not.toHaveBeenCalled();
    });

    it("should throw error and log warning for null server", () => {
      expect(() => isCompatibleServerType(null)).toThrowError(
        /does not match any supported MCP SDK shape/,
      );
      expect(writeToLog).toHaveBeenCalled();
    });

    it("should throw error and log warning for undefined server", () => {
      expect(() => isCompatibleServerType(undefined)).toThrowError(
        /does not match any supported MCP SDK shape/,
      );
      expect(writeToLog).toHaveBeenCalled();
    });

    it("should throw error and log warning for non-object server", () => {
      expect(() => isCompatibleServerType("not an object")).toThrowError(
        /does not match any supported MCP SDK shape/,
      );
      expect(writeToLog).toHaveBeenCalledTimes(1);

      vi.clearAllMocks();

      expect(() => isCompatibleServerType(42)).toThrowError(
        /does not match any supported MCP SDK shape/,
      );
      expect(writeToLog).toHaveBeenCalledTimes(1);

      vi.clearAllMocks();

      expect(() => isCompatibleServerType(true)).toThrowError(
        /does not match any supported MCP SDK shape/,
      );
      expect(writeToLog).toHaveBeenCalledTimes(1);
    });

    it("unknown-shape error names the full support matrix, never 'upgrade to v1.11'", () => {
      // The copy rule: an SDK-too-new situation must never read as
      // "upgrade to v1.11+". Every compat message names the support matrix.
      let thrown: Error | undefined;
      try {
        isCompatibleServerType({ some: "unrecognized shape" });
      } catch (e) {
        thrown = e as Error;
      }
      expect(thrown).toBeDefined();
      expect(thrown!.message).toContain(SUPPORT_MATRIX_SUFFIX);
      expect(thrown!.message).not.toMatch(/v1\.11 or higher/);
    });

    it("logs a shape-fingerprint beacon when rejecting an unrecognized server shape", () => {
      // Near-miss shape: high-level shell whose inner server has no signals.
      // The rejection log must carry the computed shape fingerprint so fleet
      // change-detection can spot "a new SDK shape appeared".
      const nearMiss = { server: {}, setRequestHandler() {} };

      expect(() => isCompatibleServerType(nearMiss)).toThrowError(
        /does not match any supported MCP SDK shape/,
      );

      const messages = (writeToLog as any).mock.calls.map(
        ([message]: [string]) => message,
      );
      const beacon = messages.find((m: string) =>
        m.includes("unrecognized server shape | signals"),
      );
      expect(beacon).toBeDefined();
      expect(beacon).toContain("hasServerProp");
      expect(beacon).toContain(SUPPORT_MATRIX_SUFFIX);
    });

    it("logs '(none)' as the fingerprint for signal-free non-object rejects", () => {
      expect(() => isCompatibleServerType(null)).toThrowError(
        /does not match any supported MCP SDK shape/,
      );
      const [[message]] = (writeToLog as any).mock.calls;
      expect(message).toContain("unrecognized server shape | signals (none)");
    });

    it("should throw the unknown-shape error when setRequestHandler is missing", () => {
      const server = {
        _requestHandlers: new Map(),
        getClientVersion: vi.fn(),
        _serverInfo: { name: "TestServer" },
      };

      // Detection owns shape discrimination now: a server without
      // setRequestHandler is not recognized as any SDK shape.
      expect(() => isCompatibleServerType(server)).toThrowError(
        /does not match any supported MCP SDK shape/,
      );
      expect(writeToLog).toHaveBeenCalled();
    });

    it("should throw the unknown-shape error when setRequestHandler is not a function", () => {
      const server = {
        setRequestHandler: "not a function",
        _requestHandlers: new Map(),
        getClientVersion: vi.fn(),
        _serverInfo: { name: "TestServer" },
      };

      expect(() => isCompatibleServerType(server)).toThrowError(
        /does not match any supported MCP SDK shape/,
      );
      expect(writeToLog).toHaveBeenCalled();
    });

    it("should throw the unknown-shape error when _requestHandlers is missing", () => {
      const server = {
        setRequestHandler: vi.fn(),
        getClientVersion: vi.fn(),
        _serverInfo: { name: "TestServer" },
      };

      expect(() => isCompatibleServerType(server)).toThrowError(
        /does not match any supported MCP SDK shape/,
      );
      expect(writeToLog).toHaveBeenCalled();
    });

    it("should throw the unknown-shape error when _requestHandlers is not a Map", () => {
      const server = {
        setRequestHandler: vi.fn(),
        _requestHandlers: {},
        getClientVersion: vi.fn(),
        _serverInfo: { name: "TestServer" },
      };

      expect(() => isCompatibleServerType(server)).toThrowError(
        /does not match any supported MCP SDK shape/,
      );
      expect(writeToLog).toHaveBeenCalled();
    });

    it("should throw the unknown-shape error when _requestHandlers is a non-Map with a get method", () => {
      const server = {
        setRequestHandler: vi.fn(),
        _requestHandlers: { get: "not a function" },
        getClientVersion: vi.fn(),
        _serverInfo: { name: "TestServer" },
      };

      expect(() => isCompatibleServerType(server)).toThrowError(
        /does not match any supported MCP SDK shape/,
      );
      expect(writeToLog).toHaveBeenCalled();
    });

    it("should throw error and log warning when getClientVersion is missing", () => {
      const server = {
        setRequestHandler: vi.fn(),
        _requestHandlers: new Map(),
        _serverInfo: { name: "TestServer" },
      };

      expect(() => isCompatibleServerType(server)).toThrowError(
        /getClientVersion/,
      );
      // Internals-validation errors carry the full support matrix, not the
      // old "requires v1.11 or higher" copy.
      expect(() => isCompatibleServerType(server)).toThrowError(
        SUPPORT_MATRIX_SUFFIX,
      );
      expect(writeToLog).toHaveBeenCalled();
    });

    it("should throw error and log warning when getClientVersion is not a function", () => {
      const server = {
        setRequestHandler: vi.fn(),
        _requestHandlers: new Map(),
        getClientVersion: "not a function",
        _serverInfo: { name: "TestServer" },
      };

      expect(() => isCompatibleServerType(server)).toThrowError(
        /getClientVersion/,
      );
      expect(writeToLog).toHaveBeenCalled();
    });

    it("should throw error and log warning when _serverInfo is missing", () => {
      const server = {
        setRequestHandler: vi.fn(),
        _requestHandlers: new Map(),
        getClientVersion: vi.fn(),
      };

      expect(() => isCompatibleServerType(server)).toThrowError(/_serverInfo/);
      expect(writeToLog).toHaveBeenCalled();
    });

    it("should throw error and log warning when _serverInfo is not an object", () => {
      const server = {
        setRequestHandler: vi.fn(),
        _requestHandlers: new Map(),
        getClientVersion: vi.fn(),
        _serverInfo: "not an object",
      };

      expect(() => isCompatibleServerType(server)).toThrowError(/_serverInfo/);
      expect(writeToLog).toHaveBeenCalled();
    });

    it("should throw error and log warning when _serverInfo.name is missing", () => {
      const server = {
        setRequestHandler: vi.fn(),
        _requestHandlers: new Map(),
        getClientVersion: vi.fn(),
        _serverInfo: {},
      };

      expect(() => isCompatibleServerType(server)).toThrowError(/_serverInfo/);
      expect(writeToLog).toHaveBeenCalled();
    });
  });

  describe("getMCPCompatibleErrorMessage", () => {
    it("should handle Error instances with standard properties", () => {
      const error = new Error("Test error message");
      const result = getMCPCompatibleErrorMessage(error);
      const parsed = JSON.parse(result);

      expect(parsed.message).toBe("Test error message");
      // Note: name property might not be enumerable in all environments
      if (parsed.name !== undefined) {
        expect(parsed.name).toBe("Error");
      }
      expect(parsed.stack).toBeDefined();
    });

    it("should handle Error instances with custom properties", () => {
      const error: any = new Error("Test error");
      error.code = "CUSTOM_ERROR";
      error.statusCode = 500;

      const result = getMCPCompatibleErrorMessage(error);
      const parsed = JSON.parse(result);

      expect(parsed.message).toBe("Test error");
      expect(parsed.code).toBe("CUSTOM_ERROR");
      expect(parsed.statusCode).toBe(500);
    });

    it("should handle string errors", () => {
      const result = getMCPCompatibleErrorMessage("String error message");
      expect(result).toBe("String error message");
    });

    it("should handle plain objects", () => {
      const errorObj = { code: "ERROR_CODE", details: "Some details" };
      const result = getMCPCompatibleErrorMessage(errorObj);
      expect(result).toBe(JSON.stringify(errorObj));
    });

    it("should handle null", () => {
      const result = getMCPCompatibleErrorMessage(null);
      expect(result).toBe("Unknown error");
    });

    it("should handle undefined", () => {
      const result = getMCPCompatibleErrorMessage(undefined);
      expect(result).toBe("Unknown error");
    });

    it("should handle numbers", () => {
      const result = getMCPCompatibleErrorMessage(42);
      expect(result).toBe("Unknown error");
    });

    it("should handle booleans", () => {
      const result = getMCPCompatibleErrorMessage(false);
      expect(result).toBe("Unknown error");
    });

    it("should handle circular reference errors", () => {
      const error: any = new Error("Circular error");
      error.circular = error; // Create circular reference

      const result = getMCPCompatibleErrorMessage(error);
      expect(result).toBe("Unknown error");
    });

    it("should handle arrays", () => {
      const errorArray = ["error1", "error2"];
      const result = getMCPCompatibleErrorMessage(errorArray);
      expect(result).toBe(JSON.stringify(errorArray));
    });
  });

  describe("McpServer compatibility", () => {
    it("should handle McpServer instances with server property", () => {
      const underlyingServer = {
        setRequestHandler: vi.fn(),
        _requestHandlers: new Map([["test", vi.fn()]]),
        getClientVersion: vi.fn(),
        _serverInfo: { name: "TestServer" },
      };

      const mcpServerWrapper = {
        server: underlyingServer,
        // Other McpServer properties
        requestContext: {},
        toolCallId: "test-id",
        _registeredTools: {},
        tool: () => {},
      };

      const result = isCompatibleServerType(mcpServerWrapper);
      expect(result).toBe(mcpServerWrapper);
      expect(writeToLog).not.toHaveBeenCalled();
    });

    it("should validate the underlying server when McpServer wrapper is provided", () => {
      const invalidUnderlyingServer = {
        // Missing setRequestHandler
        _requestHandlers: new Map(),
        getClientVersion: vi.fn(),
        _serverInfo: { name: "TestServer" },
      };

      const mcpServerWrapper = {
        server: invalidUnderlyingServer,
        _registeredTools: {},
        tool: () => {},
      };

      // An underlying server without setRequestHandler is not recognized as
      // any supported SDK shape by detection.
      expect(() => isCompatibleServerType(mcpServerWrapper)).toThrowError(
        /does not match any supported MCP SDK shape/,
      );
      expect(writeToLog).toHaveBeenCalled();
    });

    it("should handle objects with server property that is not an object", () => {
      const mcpServerWrapper = {
        server: "not an object",
        setRequestHandler: vi.fn(),
        _requestHandlers: new Map(),
        getClientVersion: vi.fn(),
        _serverInfo: { name: "TestServer" },
      };

      // Should use the wrapper itself since server property is not an object
      const result = isCompatibleServerType(mcpServerWrapper);
      expect(result).toBe(mcpServerWrapper);
      expect(writeToLog).not.toHaveBeenCalled();
    });

    it("should handle objects with null server property", () => {
      const mcpServerWrapper = {
        server: null,
        setRequestHandler: vi.fn(),
        _requestHandlers: new Map(),
        getClientVersion: vi.fn(),
        _serverInfo: { name: "TestServer" },
      };

      // Should use the wrapper itself since server property is null
      const result = isCompatibleServerType(mcpServerWrapper);
      expect(result).toBe(mcpServerWrapper);
      expect(writeToLog).not.toHaveBeenCalled();
    });

    it("should validate all required properties on the underlying server", () => {
      const testCases = [
        {
          name: "missing _requestHandlers",
          server: {
            setRequestHandler: vi.fn(),
            getClientVersion: vi.fn(),
            _serverInfo: { name: "TestServer" },
          },
          // Missing handlers map means detection rejects the shape outright.
          expectedPattern: /does not match any supported MCP SDK shape/,
        },
        {
          name: "missing getClientVersion",
          server: {
            setRequestHandler: vi.fn(),
            _requestHandlers: new Map(),
            _serverInfo: { name: "TestServer" },
          },
          expectedPattern: /getClientVersion/,
        },
        {
          name: "missing _serverInfo",
          server: {
            setRequestHandler: vi.fn(),
            _requestHandlers: new Map(),
            getClientVersion: vi.fn(),
          },
          expectedPattern: /_serverInfo/,
        },
      ];

      testCases.forEach((testCase) => {
        vi.clearAllMocks();
        const mcpServerWrapper = {
          server: testCase.server,
          _registeredTools: {},
          tool: () => {},
        };

        expect(() => isCompatibleServerType(mcpServerWrapper)).toThrowError(
          testCase.expectedPattern,
        );
        expect(writeToLog).toHaveBeenCalled();
      });
    });
  });

  describe("logCompatibilityWarning", () => {
    it("should log the correct compatibility message to the log file", () => {
      logCompatibilityWarning();

      expect(writeToLog).toHaveBeenCalled();
      expect(writeToLog).toHaveBeenCalledTimes(1);
      // Check that it contains key compatibility info rather than exact message
      const [[message]] = (writeToLog as any).mock.calls;
      expect(message).toMatch(/compatibility/i);
      expect(message).toMatch(/Model Context Protocol|MCP/);
    });
  });

  describe("McpServer integration tests", () => {
    // Dynamically check if McpServer is available (v1.3.0+)
    let McpServer: any;
    let hasCompatibleVersion = false;

    beforeEach(async () => {
      try {
        // Try to import McpServer - it's available in v1.3.0+
        const { McpServer: ImportedMcpServer } =
          await import("@modelcontextprotocol/sdk/server/mcp.js");
        McpServer = ImportedMcpServer;
        hasCompatibleVersion = true;
      } catch (error) {
        // McpServer not available in this version
        hasCompatibleVersion = false;
      }
    });

    it("should work with real McpServer instances if available", async () => {
      if (!hasCompatibleVersion) {
        console.log(
          "Skipping McpServer test - requires @modelcontextprotocol/sdk v1.3.0 or higher",
        );
        return;
      }

      // Create a real McpServer instance with server info
      const mcpServer = new McpServer({
        name: "test-mcp-server",
        version: "1.0.0",
      });

      // Test that isCompatibleServerType correctly handles it
      const result = isCompatibleServerType(mcpServer);

      // Should return the underlying server
      expect(result).toBe(mcpServer);
      expect(result).toBeDefined();
      // Note: _serverInfo exists but may be private - our compatibility check should handle this
    });

    it("should validate real McpServer underlying server properties", async () => {
      if (!hasCompatibleVersion) {
        console.log(
          "Skipping McpServer validation test - requires @modelcontextprotocol/sdk v1.3.0 or higher",
        );
        return;
      }

      const mcpServer = new McpServer({
        name: "test-validation-server",
        version: "1.0.0",
      });
      const underlyingServer = mcpServer.server;

      // Verify all required properties exist on the real server
      expect(underlyingServer).toBeDefined();
      expect(typeof underlyingServer.setRequestHandler).toBe("function");
      expect(underlyingServer._requestHandlers).toBeInstanceOf(Map);
      expect(typeof underlyingServer.getClientVersion).toBe("function");

      // Check if _serverInfo exists (it might be private but still accessible)
      // TypeScript will complain but JavaScript can still access it
      const serverInfo = (underlyingServer as any)._serverInfo;
      if (serverInfo) {
        expect(serverInfo).toBeDefined();
        expect(serverInfo.name).toBe("test-validation-server");
        expect(serverInfo.version).toBe("1.0.0");
      } else {
        // If truly private and inaccessible, we should update our compatibility check
        console.log(
          "Note: _serverInfo is not accessible in this MCP SDK version",
        );
      }
    });

    it("should show compatibility message when McpServer is not available", () => {
      if (hasCompatibleVersion) {
        console.log("Skipping version check test - McpServer is available");
        return;
      }

      // This test only runs on older versions
      expect(hasCompatibleVersion).toBe(false);
      console.log(
        "McpServer not available - using @modelcontextprotocol/sdk < v1.3.0",
      );
    });
  });
});
