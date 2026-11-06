import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getConversionAnalytics } from "../analytics/crmAnalyticsService.js";

/**
 * Creates Conversion Analytics tool bound to authenticated tenant context
 */
export const createConversionAnalyticsTool = ({ tenantModels }) => {
  return tool(
    async ({
      period = "all_time",
      startDate,
      endDate,
      salespersonNameOrId,
    }) => {
      try {
        const result = await getConversionAnalytics({
          tenantModels,
          filters: { period, startDate, endDate, salespersonNameOrId },
        });
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({ error: `Conversion analytics query failed: ${err.message}` });
      }
    },
    {
      name: "get_conversion_analytics",
      description:
        "Analyzes conversion rates, won deals, salesperson-wise conversion rankings, lead source conversion efficiency, service-wise conversions, lost-lead reasons, and comparative performance. Answers: 'Which rep has the best conversion rate?', 'What is our conversion rate by source?', or 'Which rep has highest missed calls but lowest conversions?'.",
      schema: z.object({
        period: z.string().default("all_time").describe("Period identifier: 'all_time', 'this_month', 'last_month', 'this_week', 'today', 'custom'"),
        startDate: z.string().optional().describe("Start date in YYYY-MM-DD format"),
        endDate: z.string().optional().describe("End date in YYYY-MM-DD format"),
        salespersonNameOrId: z.string().optional().describe("Filter down to a specific salesperson"),
      }),
    }
  );
};

