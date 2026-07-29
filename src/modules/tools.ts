import {
  ListToolsRequestSchema,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { MCPServerLike } from "../types.js";
import { writeToLog } from "./logging.js";
import { getServerTrackingData } from "./internal.js";
import { addContextParameterToTools } from "./context-parameters.js";
import {
  addHandleParametersToTools,
  recordHandleCollisions,
} from "./handle-parameters.js";

export const GET_MORE_TOOLS_NAME = "get_more_tools" as const;

export function getReportMissingToolDescriptor() {
  return {
    name: GET_MORE_TOOLS_NAME,
    description:
      "Check for additional tools whenever your task might benefit from specialized capabilities - even if existing tools could work as a fallback.",
    inputSchema: {
      type: "object",
      properties: {
        context: {
          type: "string",
          description:
            "A description of your goal and what kind of tool would help accomplish it.",
        },
      },
      required: ["context"],
    },
  } as const;
}

export function handleReportMissing(args: { context: string }) {
  writeToLog(
    `Missing tool reported (context length: ${args?.context?.length ?? 0})`,
  );

  return {
    content: [
      {
        type: "text" as const,
        text: `Unfortunately, we have shown you the full tool list. We have noted your feedback and will work to improve the tool list in the future.`,
      },
    ],
  };
}

export function setupAgentCatTools(server: MCPServerLike): void {
  // Store reference to original handlers - need to use the method name, not the schema
  const handlers = server._requestHandlers;

  const originalListToolsHandler = handlers.get("tools/list");
  const originalCallToolHandler = handlers.get("tools/call");

  if (!originalListToolsHandler || !originalCallToolHandler) {
    writeToLog(
      "Warning: Original tool handlers not found. Your tools may not be setup before AgentCat .track().",
    );
    return;
  }

  // Override tools list to include get_more_tools and inject handle/context parameters
  try {
    server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      const data = getServerTrackingData(server);

      const originalResponse = (await originalListToolsHandler(
        request,
        extra,
      )) as ListToolsResult;
      let tools: any[] = originalResponse.tools || [];

      if (!data) {
        writeToLog(
          "Warning: AgentCat is unable to find server tracking data. Please ensure you have called track(server, options) before using tool calls.",
        );
        return { tools };
      }

      if (tools.length === 0) {
        writeToLog(
          "Warning: No tools found in the original list. This is likely due to the tools not being registered before AgentCat.track().",
        );
        return { tools };
      }

      // get_more_tools is pushed first so handle injection reaches it.
      if (data.options.enableReportMissing) {
        const alreadyPresent = tools.some(
          (t: any) => t?.name === GET_MORE_TOOLS_NAME,
        );
        if (!alreadyPresent) tools.push(getReportMissingToolDescriptor());
      }

      recordHandleCollisions(data, tools);

      if (data.options.enableTracing) {
        tools = addHandleParametersToTools(
          tools,
          data.options.enableAgentTracking ?? true,
        );
      }

      if (data.options.enableToolCallContext) {
        tools = addContextParameterToTools(
          tools,
          data.options.customContextDescription,
        );
      }

      return { tools };
    });
  } catch (error) {
    writeToLog(`Warning: Failed to override list tools handler - ${error}`);
  }
}
