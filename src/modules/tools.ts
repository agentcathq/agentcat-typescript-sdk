import { writeToLog } from "./logging.js";

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
    // Spec defaults assume the worst (destructive, open-world); declare the
    // honest hints so annotation-aware clients skip confirmation prompts.
    annotations: {
      title: "Get More Tools",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
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
