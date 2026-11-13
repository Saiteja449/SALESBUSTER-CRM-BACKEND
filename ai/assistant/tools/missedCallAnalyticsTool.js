import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getMissedCallAnalytics } from "../analytics/crmAnalyticsService.js";

/**
 * Creates Missed Call Analytics tool bound to authenticated tenant context
 */
export const createMissedCallAnalyticsTool = ({ tenantModels }) => {
  return tool(
    async ({
      salespersonNameOrId,
      period = "all_time",
      startDate,
      endDate,
      customerPhone,
      followupStatus,
      leadStatus,
      unknownSalespersonOnly = false,
      page = 1,
      limit = 10,
    }) => {
      try {
        const result = await getMissedCallAnalytics({
          tenantModels,
          filters: {
            salespersonNameOrId,
            period,
            startDate,
            endDate,
            customerPhone,
            followupStatus,
            leadStatus,
            unknownSalespersonOnly,
          },
          pagination: { page, limit },
        });
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({ error: `Missed call query failed: ${err.message}` });
      }
    },
    {
      name: "get_missed_call_analytics",
      description:
        "Analyzes missed calls across the CRM with comprehensive filters: overall missed calls, salesperson-wise, date-wise, customer phone or name, missed calls without follow-up, with overdue follow-ups, successfully followed up, missed calls by lead status, or calls from unknown/unassigned salespeople. Returns both calculated summary statistics and paginated record details. Internal IDs are for tooling only; never expose MongoDB ObjectIds to the user. Always use resolved human names.",
      schema: z.object({
        salespersonNameOrId: z.string().optional().describe("Salesperson name or ID to filter by. Supports exact, partial, or alias names."),
        period: z.string().optional().describe("Period identifier: 'all_time', 'this_month', 'last_month', 'today', 'yesterday', 'this_week', 'last_7_days', 'custom'"),
        startDate: z.string().optional().describe("Custom start date in YYYY-MM-DD format"),
        endDate: z.string().optional().describe("Custom end date in YYYY-MM-DD format"),
        customerPhone: z.string().optional().describe("Filter by specific customer phone number"),
        followupStatus: z.enum(["pending", "overdue", "completed", "none", "all"]).optional().describe("Filter missed calls by follow-up progress"),
        leadStatus: z.string().optional().describe("Filter by lead status e.g. Converted, Follow Up, New, Lost"),
        unknownSalespersonOnly: z.boolean().default(false).describe("Set true to inspect missed calls received without rep assignment"),
        page: z.number().default(1).describe("Page number for paginated individual records"),
        limit: z.number().default(10).describe("Record count per page (max 25)"),
      }),
    }
  );
};

