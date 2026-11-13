import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  getWhatsAppAnalytics,
  getWhatsAppConnectionStatus,
  searchWhatsAppConversations,
  getConversationMessages,
  summarizeWhatsAppConversation,
} from "../analytics/crmAnalyticsService.js";

/**
 * Creates WhatsApp Analytics & Overview tool bound to authenticated tenant context
 */
export const createWhatsAppAnalyticsTool = ({ tenantModels, organization }) => {
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
          organization,
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
        "Analyzes WhatsApp communication metrics: leads awaiting reply, unread customer messages, message volume breakdown (sent vs received), response rates, recent messages overview, and team connection status. Answers: 'Which leads haven't received a WhatsApp reply?', 'Show message volumes for Shanmukh', 'Show team WhatsApp connection statuses'. Internal IDs are for tooling only; never expose MongoDB ObjectIds to the user. Always use resolved human names.",
      schema: z.object({
        type: z
          .enum([
            "unreplied_leads",
            "unread_leads",
            "recent_messages_overview",
            "message_stats",
            "connection_status",
            "all",
          ])
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

/**
 * Creates WhatsApp Connection Status tool bound to authenticated tenant context
 */
export const createWhatsAppConnectionStatusTool = ({ tenantModels, organization }) => {
  return tool(
    async ({ salespersonNameOrId, page = 1, limit = 20 }) => {
      try {
        const result = await getWhatsAppConnectionStatus({
          tenantModels,
          organization,
          filters: { salespersonNameOrId },
          pagination: { page, limit },
        });
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({ error: `WhatsApp connection status query failed: ${err.message}` });
      }
    },
    {
      name: "get_whatsapp_connection_status",
      description:
        "Checks WhatsApp session connection status across sales representatives and team members: connection state ('connected', 'connecting', 'qr', 'disconnected'), connection type ('Baileys WhatsApp Web'), connected phone, expected phone, and last active/sync time. Excludes sensitive auth tokens and QR payloads.",
      schema: z.object({
        salespersonNameOrId: z.string().optional().describe("Filter by specific sales representative name or ID"),
        page: z.number().default(1).describe("Pagination page"),
        limit: z.number().default(20).describe("Number of team member records per page"),
      }),
    }
  );
};

/**
 * Creates Search WhatsApp Conversations tool bound to authenticated tenant context
 */
export const createSearchConversationsTool = ({ tenantModels }) => {
  return tool(
    async ({
      customerName,
      customerPhone,
      leadId,
      salespersonNameOrId,
      unreadOnly = false,
      searchTerm,
      period = "all_time",
      startDate,
      endDate,
      page = 1,
      limit = 10,
    }) => {
      try {
        const result = await searchWhatsAppConversations({
          tenantModels,
          filters: {
            customerName,
            customerPhone,
            leadId,
            salespersonNameOrId,
            unreadOnly,
            searchTerm,
            period,
            startDate,
            endDate,
          },
          pagination: { page, limit },
        });
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({ error: `Conversation search failed: ${err.message}` });
      }
    },
    {
      name: "search_whatsapp_conversations",
      description:
        "Searches customer WhatsApp chat threads and conversations. Filterable by customer name, phone number, lead ID, assigned sales representative, unread status, content search term, or date range. Supports pagination.",
      schema: z.object({
        customerName: z.string().optional().describe("Customer or contact name"),
        customerPhone: z.string().optional().describe("Customer phone number or last 10 digits"),
        leadId: z.string().optional().describe("CRM Lead ID"),
        salespersonNameOrId: z.string().optional().describe("Assigned sales representative"),
        unreadOnly: z.boolean().default(false).describe("Only return conversations with unread customer messages"),
        searchTerm: z.string().optional().describe("Search term across customer name, company, or message snippet"),
        period: z.string().default("all_time").describe("Period to evaluate (today, this_month, all_time, custom)"),
        startDate: z.string().optional().describe("Start date in YYYY-MM-DD format"),
        endDate: z.string().optional().describe("End date in YYYY-MM-DD format"),
        page: z.number().default(1).describe("Pagination page number"),
        limit: z.number().default(10).describe("Records per page"),
      }),
    }
  );
};

/**
 * Creates Get Conversation Messages tool bound to authenticated tenant context
 */
export const createConversationMessagesTool = ({ tenantModels }) => {
  return tool(
    async ({ conversationId, leadId, customerPhone, page = 1, limit = 25 }) => {
      try {
        const result = await getConversationMessages({
          tenantModels,
          filters: { conversationId, leadId, customerPhone },
          pagination: { page, limit },
        });
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({ error: `Get conversation messages failed: ${err.message}` });
      }
    },
    {
      name: "get_conversation_messages",
      description:
        "Retrieves chronological messages from a selected customer WhatsApp chat thread. Requires conversationId, leadId, or customerPhone. Returns chronological messages (direction, sender, text wrapped as untrusted data, timestamp, and status) with stable pagination.",
      schema: z.object({
        conversationId: z.string().optional().describe("Conversation document ID"),
        leadId: z.string().optional().describe("Lead document ID"),
        customerPhone: z.string().optional().describe("Customer phone number"),
        page: z.number().default(1).describe("Pagination page number"),
        limit: z.number().default(25).describe("Number of messages to retrieve (default 25, max 100)"),
      }),
    }
  );
};

/**
 * Creates Summarize WhatsApp Conversation tool bound to authenticated tenant context
 */
export const createSummarizeConversationTool = ({ tenantModels }) => {
  return tool(
    async ({ conversationId, leadId, customerPhone }) => {
      try {
        const result = await summarizeWhatsAppConversation({
          tenantModels,
          filters: { conversationId, leadId, customerPhone },
        });
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({ error: `Summarize conversation failed: ${err.message}` });
      }
    },
    {
      name: "summarize_whatsapp_conversation",
      description:
        "Analyzes and summarizes a customer WhatsApp conversation from its transcript. Identifies key discussion points, customer intent, unresolved questions, sentiment (Positive/Neutral/Negative), and actionable next steps. Treats customer message text strictly as untrusted data.",
      schema: z.object({
        conversationId: z.string().optional().describe("Conversation document ID"),
        leadId: z.string().optional().describe("Lead document ID"),
        customerPhone: z.string().optional().describe("Customer phone number"),
      }),
    }
  );
};
