import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { PublishEventRequestEventTypeEnum } from "agentcat-api";
import {
  setupTestServerAndClient,
  resetTodos,
} from "./test-utils/client-server-factory.js";
import { EventCapture } from "./test-utils.js";
import { track } from "../index.js";
import * as tokenEstimate from "../modules/tokenEstimate.js";

// Vectors: {"text":"hi there"} is 19 bytes -> 6 tokens; "hello world" is 11
// bytes -> 4; "secret-value-123456789" is 22 bytes -> 7 and its arguments
// object {"text":"secret-value-123456789"} is 33 bytes -> 10.

async function callTool(client: any, name: string, args: object) {
  return client.request(
    { method: "tools/call", params: { name, arguments: args } },
    CallToolResultSchema,
  );
}

function toolEvent(capture: EventCapture, name: string) {
  return capture
    .getEvents()
    .find(
      (e) =>
        e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall &&
        e.resourceName === name,
    );
}

describe("token estimates on tool-call events", () => {
  it("counts the raw arguments and the content text", async () => {
    resetTodos();
    const { server, client, cleanup } = await setupTestServerAndClient();
    const capture = new EventCapture();
    await capture.start();
    try {
      await track(server, "test-tokens", {
        enableToolCallContext: false,
        enableTracing: true,
      });
      server.tool(
        "token_probe",
        "fixed reply",
        { text: z.string() },
        async () => ({
          content: [{ type: "text", text: "hello world" }],
          structuredContent: { padding: "y".repeat(1000) },
        }),
      );

      await callTool(client, "token_probe", { text: "hi there" });
      await capture.flush();

      const event = toolEvent(capture, "token_probe")!;
      expect(event).toBeDefined();
      expect(event.inputTokens).toBe(6);
      expect(event.outputTokens).toBe(4);
    } finally {
      await capture.stop();
      await cleanup();
    }
  });

  it("counts an error result's content, including a throw the SDK turns into one", async () => {
    resetTodos();
    const { server, client, cleanup } = await setupTestServerAndClient();
    const capture = new EventCapture();
    await capture.start();
    try {
      await track(server, "test-tokens", {
        enableToolCallContext: false,
        enableTracing: true,
      });
      server.tool(
        "error_result",
        "isError result",
        { text: z.string() },
        async () => ({
          isError: true,
          content: [{ type: "text", text: "boom!" }],
        }),
      );
      server.tool("throws", "throws", { text: z.string() }, async () => {
        throw new Error("no");
      });

      await callTool(client, "error_result", { text: "hi there" });
      // McpServer converts a thrown handler error into an isError result whose
      // text is the message, so the client sees a result, never a rejection.
      const thrownResult = await callTool(client, "throws", {
        text: "hi there",
      });
      expect(thrownResult.isError).toBe(true);
      await capture.flush();

      const errorResult = toolEvent(capture, "error_result")!;
      expect(errorResult.isError).toBe(true);
      expect(errorResult.inputTokens).toBe(6);
      expect(errorResult.outputTokens).toBe(2); // "boom!" = 5 bytes

      const thrown = toolEvent(capture, "throws")!;
      expect(thrown.isError).toBe(true);
      expect(thrown.inputTokens).toBe(6);
      expect(thrown.outputTokens).toBe(1); // the converted result's text "no" = 2 bytes
    } finally {
      await capture.stop();
      await cleanup();
    }
  });

  it("keeps the raw counts when redaction rewrites the payloads", async () => {
    resetTodos();
    const { server, client, cleanup } = await setupTestServerAndClient();
    const capture = new EventCapture();
    await capture.start();
    try {
      await track(server, "test-tokens", {
        enableToolCallContext: false,
        enableTracing: true,
        // Only the secret string is rewritten: a hook that replaced every
        // string would also clobber the content block's `type` discriminator.
        redactSensitiveInformation: async (text) =>
          text.includes("secret") ? "[REDACTED]" : text,
      });
      server.tool(
        "secret_echo",
        "echoes",
        { text: z.string() },
        async (args) => ({
          content: [{ type: "text", text: args.text }],
        }),
      );

      await callTool(client, "secret_echo", { text: "secret-value-123456789" });
      await capture.flush();

      const event = toolEvent(capture, "secret_echo")!;
      // The pipeline ran: the stored strings are the hook's replacement...
      expect(event.response.content[0].text).toBe("[REDACTED]");
      expect(event.parameters.request.params.arguments.text).toBe("[REDACTED]");
      // ...and the counts still describe the original bytes.
      expect(event.inputTokens).toBe(10);
      expect(event.outputTokens).toBe(7);
    } finally {
      await capture.stop();
      await cleanup();
    }
  });

  it("keeps the raw counts when truncation shortens the response", async () => {
    resetTodos();
    const { server, client, cleanup } = await setupTestServerAndClient();
    const capture = new EventCapture();
    await capture.start();
    try {
      await track(server, "test-tokens", {
        enableToolCallContext: false,
        enableTracing: true,
      });
      server.tool("big", "big", { text: z.string() }, async () => ({
        content: [{ type: "text", text: "x".repeat(40_000) }],
      }));

      await callTool(client, "big", { text: "hi there" });
      await capture.flush();

      const event = toolEvent(capture, "big")!;
      expect(event.response.content[0].text.length).toBe(32768 + 3);
      expect(event.outputTokens).toBe(11429); // ceil(40000 / 3.5)
    } finally {
      await capture.stop();
      await cleanup();
    }
  });

  it("never breaks the tool call when the estimator itself throws", async () => {
    resetTodos();
    const { server, client, cleanup } = await setupTestServerAndClient();
    const capture = new EventCapture();
    await capture.start();
    const inputSpy = vi
      .spyOn(tokenEstimate, "estimateInputTokens")
      .mockImplementation(() => {
        throw new Error("estimator bug");
      });
    const outputSpy = vi
      .spyOn(tokenEstimate, "estimateOutputTokens")
      .mockImplementation(() => {
        throw new Error("estimator bug");
      });
    try {
      await track(server, "test-tokens", {
        enableToolCallContext: false,
        enableTracing: true,
      });
      server.tool(
        "still_works",
        "fixed reply",
        { text: z.string() },
        async () => ({
          content: [{ type: "text", text: "hello world" }],
        }),
      );

      // The customer's result reaches the client unchanged: no throw, no
      // error result, the text intact. Analytics for this call may be lost;
      // the response never is.
      const result = await callTool(client, "still_works", {
        text: "hi there",
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: "hello world",
      });
      expect(inputSpy).toHaveBeenCalled();
    } finally {
      inputSpy.mockRestore();
      outputSpy.mockRestore();
      await capture.stop();
      await cleanup();
    }
  });
});
