import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { wrapUntrustedData } from "../securityUtils.js";

/**
 * Creates WhatsApp Conversations & Call Analytics tool bound to authenticated tenant context
 */
export const createWhatsAppAnalyticsTool = ({ tenantModels }) => {
  return tool(
    async ({ type = "unreplied_leads", limit = 10 }) => {
      try {
        const { Lead: LeadModel, Message: MessageModel, Conversation: ConversationModel } = tenantModels;
        if (!LeadModel) {
          return JSON.stringify({ error: "Lead model not found in tenant database" });
        }

        const safeLimit = Math.min(Math.max(1, limit), 25);

        if (type === "unreplied_leads" || type === "unread_leads") {
          // 1. Leads with unread flag
          const unreadFilter = {
            $or: [{ unreadCount: { $gt: 0 } }, { hasUnread: true }],
          };

          const totalUnreadCount = await LeadModel.countDocuments(unreadFilter);
          const unreadLeads = await LeadModel.find(unreadFilter)
            .sort({ lastActivity: -1, updatedAt: -1 })
            .limit(safeLimit)
            .select("name phone service assignedTo lastMessage lastActivity unreadCount")
            .lean();

          const formatted = unreadLeads.map((l) => ({
            leadId: l._id.toString(),
            name: l.name || "Unnamed Customer",
            phone: l.phone,
            service: l.service,
            assignedRep: l.assignedTo ? String(l.assignedTo) : "Unassigned",
            unreadCount: l.unreadCount || 1,
            lastMessagePreview: l.lastMessage ? wrapUntrustedData(l.lastMessage.slice(0, 150)) : "No text available",
            lastReceivedIST: l.lastActivity
              ? new Date(l.lastActivity).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
              : "Recently",
          }));

          return JSON.stringify({
            category: "Leads Awaiting Reply / Unread",
            totalLeadsAwaitingReply: totalUnreadCount,
            showingCount: formatted.length,
            leads: formatted,
          });
        }

        if (type === "recent_messages_overview" && MessageModel) {
          // Recent message stats
          const now = new Date();
          const startOfToday = new Date(now.toISOString().split("T")[0] + "T00:00:00+05:30");

          const [stats] = await MessageModel.aggregate([
            {
              $facet: {
                todayTotal: [{ $match: { timestamp: { $gte: startOfToday } } }, { $count: "c" }],
                todayIncoming: [
                  { $match: { timestamp: { $gte: startOfToday }, direction: "incoming" } },
                  { $count: "c" },
                ],
                todayOutgoing: [
                  { $match: { timestamp: { $gte: startOfToday }, direction: "outgoing" } },
                  { $count: "c" },
                ],
                allTimeTotal: [{ $count: "c" }],
              },
            },
          ]);

          return JSON.stringify({
            todayMessages: {
              total: stats.todayTotal[0]?.c || 0,
              incomingFromCustomers: stats.todayIncoming[0]?.c || 0,
              outgoingFromTeamOrAI: stats.todayOutgoing[0]?.c || 0,
            },
            allTimeTotalMessages: stats.allTimeTotal[0]?.c || 0,
          });
        }

        return JSON.stringify({ message: "No WhatsApp data found for specified type" });
      } catch (error) {
        return JSON.stringify({ error: `WhatsApp analytics query failed: ${error.message}` });
      }
    },
    {
      name: "get_whatsapp_analytics",
      description:
        "Queries WhatsApp conversation statuses and message stats. Answers: 'Which leads haven't received a WhatsApp reply?', 'Show me unread customer messages', or message activity overview.",
      schema: z.object({
        type: z
          .enum(["unreplied_leads", "unread_leads", "recent_messages_overview"])
          .default("unreplied_leads")
          .describe("WhatsApp inquiry category to inspect"),
        limit: z
          .number()
          .min(1)
          .max(25)
          .default(10)
          .describe("Maximum number of leads to return (1-25)"),
      }),
    }
  );
};
