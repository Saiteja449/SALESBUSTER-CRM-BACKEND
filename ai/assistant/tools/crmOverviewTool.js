import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getCRMOverview } from "../analytics/crmAnalyticsService.js";

/**
 * Creates 360-degree CRM Overview tool bound to authenticated tenant context
 */
export const createCRMOverviewTool = ({ tenantModels, organization }) => {
  return tool(
    async ({ period = "all_time", startDate, endDate }) => {
      try {
        const overview = await getCRMOverview({
          tenantModels,
          filters: { period, startDate, endDate, timezone: organization?.timezone || "Asia/Kolkata" },
        });
        return JSON.stringify(overview);
      } catch (err) {
        return JSON.stringify({ error: `CRM Overview failed: ${err.message}` });
      }
    },
    {
      name: "get_crm_overview",
      description:
        "Returns a complete 360-degree CRM overview including total leads, exact status counts, Old/New Leads tab counts, Today/Upcoming Followup lead counts, follow-up task counts, calls, WhatsApp activity, and recordings. Use for overall summaries and when asked how many leads are in the Leads screen's Today or Upcoming Followup tab. Those tab counts are leads filtered by status and nextFollowUp, independent of lead creation date; use follow-up analytics for task counts.",
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

