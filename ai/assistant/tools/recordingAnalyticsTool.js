import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getRecordingAnalytics } from "../analytics/crmAnalyticsService.js";

/**
 * Creates Call Recording Analytics tool bound to authenticated tenant context
 */
export const createRecordingAnalyticsTool = ({ tenantModels }) => {
  return tool(
    async ({
      salespersonNameOrId,
      period = "all_time",
      startDate,
      endDate,
      analysisStatus,
      missingRecordingsOnly = false,
      page = 1,
      limit = 10,
    }) => {
      try {
        const result = await getRecordingAnalytics({
          tenantModels,
          filters: {
            salespersonNameOrId,
            period,
            startDate,
            endDate,
            analysisStatus,
            missingRecordingsOnly,
          },
          pagination: { page, limit },
        });
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({ error: `Recording analytics query failed: ${err.message}` });
      }
    },
    {
      name: "get_recording_analytics",
      description:
        "Analyzes call audio recordings: available recordings, missing recordings for connected calls, AI analysis and transcription status, recordings by salesperson, and inspects transcription summaries. Answers: 'Show call recordings for Shanmukh', 'Which calls have missing recordings?', and 'How many call recordings were analyzed?'.",
      schema: z.object({
        salespersonNameOrId: z.string().optional().describe("Filter recordings by salesperson"),
        period: z.string().default("all_time").describe("Period to evaluate: 'all_time', 'this_month', 'today', 'custom'"),
        startDate: z.string().optional().describe("Start date in YYYY-MM-DD format"),
        endDate: z.string().optional().describe("End date in YYYY-MM-DD format"),
        analysisStatus: z.enum(["completed", "pending", "failed", "all"]).optional().describe("Filter by AI analysis status"),
        missingRecordingsOnly: z.boolean().default(false).describe("Only return calls that should have a recording but don't"),
        page: z.number().default(1).describe("Pagination page number"),
        limit: z.number().default(10).describe("Number of recordings per page"),
      }),
    }
  );
};

