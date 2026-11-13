import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getSalespersonAnalytics } from "../analytics/crmAnalyticsService.js";

/**
 * Creates Sales Performance & Analytics tool bound to authenticated tenant context.
 * Used for both get_salesperson_performance and get_salesperson_analytics.
 */
export const createSalesPerformanceTool = ({ tenantModels, toolName = "get_salesperson_performance" }) => {
  return tool(
    async ({
      period = "all_time",
      startDate,
      endDate,
      salespersonNameOrId,
    }) => {
      try {
        const result = await getSalespersonAnalytics({
          tenantModels,
          filters: {
            period,
            startDate,
            endDate,
            salespersonNameOrId,
          },
        });
        return JSON.stringify(result);
      } catch (error) {
        return JSON.stringify({ error: `Sales performance query failed: ${error.message}` });
      }
    },
    {
      name: toolName,
      description:
        "Analyzes sales team performance, individual rep performance, team leaderboard, calls logged, incoming/outgoing/connected/missed calls, talk time, lead generation, conversions, conversion rates, and follow-ups. Supports periods: 'all_time' (complete/overall history), 'this_month', 'last_month', 'this_week', 'last_week', 'today', 'yesterday', or custom dates. Answers: 'get complete my team reports', 'How many missed calls did Shanmukh receive?', 'Compare Shanmukh and Jhansi', and 'Which salesperson has highest missed calls?'. Internal IDs are for tooling only; never expose MongoDB ObjectIds to the user. Always use resolved human names.",
      schema: z.object({
        period: z
          .string()
          .default("all_time")
          .describe("Time period to evaluate sales performance for. Use 'all_time' when user asks for complete, overall, or total team reports; use 'this_month' for the current month."),
        startDate: z.string().optional().describe("Optional custom start date in YYYY-MM-DD format"),
        endDate: z.string().optional().describe("Optional custom end date in YYYY-MM-DD format"),
        salespersonNameOrId: z
          .string()
          .optional()
          .describe("Optional name or ID to filter down to a specific sales representative (supports exact or partial name)"),
      }),
    }
  );
};
