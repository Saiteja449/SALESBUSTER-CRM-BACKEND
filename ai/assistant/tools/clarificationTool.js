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
        "Call this tool whenever the user's question is ambiguous, underspecified, lacks crucial scope or time period (e.g., today vs this month vs all time), or when there are multiple distinct logical interpretations. You MUST provide a clear, concise question and 2 to 4 distinct, clickable options for the sales manager to choose from.",
      schema: z.object({
        question: z
          .string()
          .describe(
            "The clarifying question explaining what specific criteria, timeframe, or detail is needed to proceed."
          ),
        options: z
          .array(z.string())
          .min(2)
          .max(5)
          .describe(
            "A list of 2 to 5 concrete, actionable option strings that the user can click to answer (e.g. ['Today', 'This Month', 'All-Time'] or ['By Won Leads', 'By Conversion Rate', 'By Talk Time'])."
          ),
      }),
    }
  );
};
