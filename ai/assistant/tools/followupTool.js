import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getFollowupAnalytics } from "../analytics/crmAnalyticsService.js";

/**
 * Creates Follow-ups & Tasks analytics tool bound to authenticated tenant context.
 * Supports both get_followup_status and get_followup_analytics.
 */
export const createFollowupTool = ({ tenantModels, toolName = "get_followup_status" }) => {
  return tool(
    async ({
      filter,
      status,
      salespersonNameOrId,
      priority,
      period,
      startDate,
      endDate,
      page = 1,
      limit = 10,
    }) => {
      try {
        const effectiveStatus = status || filter || "all_pending";
        const result = await getFollowupAnalytics({
          tenantModels,
          filters: {
            status: effectiveStatus,
            salespersonNameOrId,
            priority,
            period,
            startDate,
            endDate,
          },
          pagination: { page, limit },
        });
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({ error: `Follow-up query failed: ${err.message}` });
      }
    },
    {
      name: toolName,
      description:
        "Analyzes scheduled and pending follow-ups and CRM tasks. Reports total pending, overdue, pending today, upcoming, completed follow-ups, priority breakdown, salesperson-wise follow-up distribution, and missed-call follow-ups. Answers: 'Which salesperson has highest overdue missed-call follow-ups?', 'Show pending follow-ups for Shanmukh', and 'How many tasks are overdue?'. Internal IDs are for tooling only; never expose MongoDB ObjectIds to the user. Always use resolved human names.",
      schema: z.object({
        status: z
          .enum([
            "all_pending",
            "overdue",
            "pending_today",
            "upcoming",
            "completed",
            "missed_call_followups",
          ])
          .optional()
          .describe("Status category of follow-ups to inspect"),
        filter: z
          .enum([
            "all_pending",
            "overdue",
            "pending_today",
            "upcoming",
            "completed",
            "missed_call_followups",
          ])
          .optional()
          .describe("Legacy filter alias for status"),
        salespersonNameOrId: z.string().optional().describe("Filter follow-ups assigned to a specific representative"),
        priority: z.enum(["High", "Medium", "Low", "all"]).optional().describe("Priority level filter"),
        period: z.string().optional().describe("Period e.g. 'today', 'this_week', 'this_month', 'all_time'"),
        startDate: z.string().optional().describe("Start date in YYYY-MM-DD format"),
        endDate: z.string().optional().describe("End date in YYYY-MM-DD format"),
        page: z.number().default(1).describe("Pagination page number"),
        limit: z.number().default(10).describe("Record count per page (max 25)"),
      }),
    }
  );
};
