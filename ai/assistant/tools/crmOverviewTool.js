import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getCRMOverview } from "../analytics/crmAnalyticsService.js";

/**
 * Creates 360-degree CRM Overview tool bound to authenticated tenant context
 */
export const createCRMOverviewTool = ({ tenantModels }) => {
  return tool(
    async ({ period = "all_time", startDate, endDate }) => {
      try {
        const overview = await getCRMOverview({
          tenantModels,
          filters: { period, startDate, endDate },
        });
        return JSON.stringify(overview);
      } catch (err) {
        return JSON.stringify({ error: `CRM Overview failed: ${err.message}` });
      }
    },
    {
      name: "get_crm_overview",
      description:
        "Returns a complete 360-degree overview of the CRM: total leads, new/active/converted/lost leads, total calls, incoming/outgoing/connected/missed calls, pending and overdue follow-ups, WhatsApp activity, and call recordings. Use when asked for overall metrics, summaries, or dashboard health.",
      schema: z.object({
        period: z
          .enum([
            "all_time",
            "this_month",
            "last_month",
            "this_week",
            "last_week",
            "today",
            "yesterday",
            "this_morning",
            "last_7_days",
            "last_30_days",
            "custom",
          ])
          .default("all_time")
          .describe("Time period to evaluate CRM metrics for. Use 'all_time' for complete history."),
        startDate: z.string().optional().describe("Optional custom start date in YYYY-MM-DD format"),
        endDate: z.string().optional().describe("Optional custom end date in YYYY-MM-DD format"),
      }),
    }
  );
};

