import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getWhatsAppAnalytics } from "../analytics/crmAnalyticsService.js";

/**
 * Creates WhatsApp Analytics & Conversations tool bound to authenticated tenant context
 */
export const createWhatsAppAnalyticsTool = ({ tenantModels }) => {
  return tool(
    async ({
      type = "unreplied_leads",
      period = "all_time",
      startDate,
      endDate,
      salespersonNameOrId,
      page = 1,
      limit = 10,
    }) => {
      try {
        const result = await getWhatsAppAnalytics({
          tenantModels,
          filters: {
            type,
            period,
            startDate,
            endDate,
            salespersonNameOrId,
          },
          pagination: { page, limit },
        });
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({ error: `WhatsApp analytics query failed: ${err.message}` });
      }
    },
    {
      name: "get_whatsapp_analytics",
      description:
        "Analyzes WhatsApp conversation statuses, unreplied/unread customer messages, message volumes (sent vs received), and rep-wise messaging activity. Answers: 'Which leads haven't received a WhatsApp reply?', 'Show me unread customer messages', or 'Show missed calls where customer has not received a WhatsApp response'.",
      schema: z.object({
        type: z
          .enum(["unreplied_leads", "unread_leads", "recent_messages_overview", "message_stats", "all"])
          .default("unreplied_leads")
          .describe("WhatsApp inquiry category"),
        period: z.string().default("all_time").describe("Period to evaluate"),
        startDate: z.string().optional().describe("Start date in YYYY-MM-DD format"),
        endDate: z.string().optional().describe("End date in YYYY-MM-DD format"),
        salespersonNameOrId: z.string().optional().describe("Filter leads awaiting reply by assigned salesperson"),
        page: z.number().default(1).describe("Pagination page"),
        limit: z.number().default(10).describe("Records per page"),
      }),
    }
  );
};
