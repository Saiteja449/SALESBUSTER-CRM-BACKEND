import { tool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * Creates the Clarification tool.
 * Enables the LLM agent to ask structured clarification questions
 * with multiple-choice options when user intent is ambiguous, broad, or underspecified.
 */
export const createClarificationTool = () => {
  return tool(
    async ({ question, options }) => {
      return JSON.stringify({
        isClarification: true,
        question: question.trim(),
        options: Array.isArray(options) ? options.map((o) => String(o).trim()) : [],
      });
    },
    {
      name: "ask_clarification",
      description:
        "Call this tool ONLY when the user's question is ambiguous or missing required parameters (such as an unspecified timeframe or filter) and you are completely unable to run a data query without their clarification. DO NOT call this tool if you can answer the question or if the user is already answering your previous question.",
      schema: z.object({
        question: z
          .string()
          .describe(
            "The clarifying question explaining what specific criteria or detail is needed to proceed."
          ),
        options: z
          .array(z.string())
          .min(2)
          .max(5)
          .describe(
            "A list of 2 to 5 concrete, actionable option strings for the user to choose from."
          ),
      }),
    }
  );
};
