import mongoose from "mongoose";
import { resolveSalesperson } from "./salespersonResolver.js";
import { resolveAnalyticsDateRange } from "./dateRangeResolver.js";
import { validateAnalyticsQuery, formatPaginatedResponse } from "./analyticsQueryValidator.js";
import { wrapUntrustedData } from "../securityUtils.js";
import { composeMongoQuery } from "./queryComposer.js";

const canQuery = (model) => {
  if (!model) return false;
  if (model.prototype instanceof mongoose.Model || model.schema) {
    const readyState = model.db?.readyState ?? mongoose.connection?.readyState;
    return readyState === 1;
  }
  return true;
};

/**
 * WhatsApp Analytics: Message volumes, unreplied leads, response tracking, and rep messaging activity.
 * Properly attributes messages through Lead ownership and handles unsupported metrics explicitly.
 */
export const getWhatsAppAnalytics = async ({
  tenantModels = {},
  filters = {},
  pagination = {},
}) => {
  const {
    type = "unreplied_leads", // "unreplied_leads", "message_stats", "rep_messaging", "all"
    period = "all_time",
    startDate,
    endDate,
    salespersonNameOrId,
  } = filters;

  const { page, limit, skip } = validateAnalyticsQuery(pagination);
  const LeadModel = tenantModels.Lead;
  const MessageModel = tenantModels.Message;
  const ConversationModel = tenantModels.Conversation;

  if (!canQuery(LeadModel)) {
    return { success: false, error: "Lead model not available" };
  }

  const dateRange = resolveAnalyticsDateRange({ period, startDate, endDate });

  // 1. Resolve salesperson if specified
  let repResolution = null;
  if (salespersonNameOrId) {
    repResolution = await resolveSalesperson({ tenantModels, identifier: salespersonNameOrId });
    if (!repResolution.resolved) {
      if (repResolution.isAmbiguous) {
        return {
          success: false,
          error_code: "AMBIGUOUS_SALESPERSON",
          message: repResolution.message,
          matches: repResolution.matches,
        };
      }
      // Nonexistent salesperson: return 0 results immediately, never organization-wide
      return formatPaginatedResponse({
        totalCount: 0,
        page,
        limit,
        records: [],
        summary: {
          periodEvaluated: dateRange.label,
          salespersonEvaluated: salespersonNameOrId,
          totalLeadsAwaitingReply: 0,
          messagingActivity: {
            totalMessages: 0,
            incomingFromCustomers: 0,
            outgoingFromTeamOrAI: 0,
            responseRatePercent: "0%",
          },
        },
        filtersApplied: {
          salesperson: salespersonNameOrId,
          salespersonNotFound: true,
          period: dateRange.label,
          type,
        },
        coverage: "complete",
        message: repResolution.message || `Salesperson "${salespersonNameOrId}" not found.`,
      });
    }
  }

  // 2. Identify assigned Leads for reliable salesperson attribution
  let assignedLeadIds = null;
  if (repResolution && !repResolution.all && canQuery(LeadModel)) {
    try {
      assignedLeadIds = await LeadModel.find(repResolution.leadAssignedFilter).distinct("_id");
    } catch (leadErr) {
      console.warn("[WhatsAppAnalytics] Error finding rep leads:", leadErr.message);
      assignedLeadIds = [];
    }
  }

  // 3. Message Volume Breakdown (from Message collection if present)
  let messageStats = {
    totalMessages: 0,
    incomingFromCustomers: 0,
    outgoingFromTeamOrAI: 0,
    responseRatePercent: "0%",
  };

  let unsupportedNote = null;

  if (canQuery(MessageModel)) {
    try {
      const msgClauses = [];
      if (!dateRange.isAllTime) {
        msgClauses.push({ timestamp: { $gte: dateRange.start, $lte: dateRange.end } });
      }

      if (assignedLeadIds !== null) {
        if (assignedLeadIds.length === 0) {
          msgClauses.push({ leadId: { $in: [] } }); // salesperson has 0 leads -> 0 messages
        } else {
          msgClauses.push({ leadId: { $in: assignedLeadIds } });
        }
      }

      const msgMatch = composeMongoQuery(...msgClauses);

      const [mRes] = await MessageModel.aggregate([
        { $match: msgMatch },
        {
          $facet: {
            total: [{ $count: "c" }],
            incoming: [{ $match: { direction: "incoming" } }, { $count: "c" }],
            outgoing: [{ $match: { direction: "outgoing" } }, { $count: "c" }],
          },
        },
      ]);

      const tot = mRes?.total[0]?.c || 0;
      const inc = mRes?.incoming[0]?.c || 0;
      const out = mRes?.outgoing[0]?.c || 0;
      const respRate = inc > 0 ? Math.min(100, Math.round((out / inc) * 100)) : out > 0 ? 100 : 0;

      messageStats = {
        totalMessages: tot,
        incomingFromCustomers: inc,
        outgoingFromTeamOrAI: out,
        responseRatePercent: `${respRate}%`,
      };
    } catch (aggErr) {
      console.warn("[WhatsAppAnalytics] Aggregation error:", aggErr.message);
    }
  } else {
    unsupportedNote = "Raw Message collection is not available in the current tenant database.";
  }

  // 4. Unreplied / Unread Leads
  const unreadBase = {
    $or: [{ unreadCount: { $gt: 0 } }, { hasUnread: true }],
  };
  const unreadClauses = [unreadBase];

  if (repResolution?.leadAssignedFilter) {
    unreadClauses.push(repResolution.leadAssignedFilter);
  }

  if (!dateRange.isAllTime) {
    unreadClauses.push({
      $or: [
        { lastActivity: { $gte: dateRange.start, $lte: dateRange.end } },
        { updatedAt: { $gte: dateRange.start, $lte: dateRange.end } },
      ],
    });
  }

  const unreadFilter = composeMongoQuery(...unreadClauses);

  const totalUnreadCount = typeof LeadModel.countDocuments === "function"
    ? await LeadModel.countDocuments(unreadFilter)
    : 0;

  let unreadQuery = LeadModel.find(unreadFilter);
  if (typeof unreadQuery.sort === "function") {
    unreadQuery = unreadQuery.sort({ lastActivity: -1, updatedAt: -1 });
  }
  if (skip > 0 && typeof unreadQuery.skip === "function") {
    unreadQuery = unreadQuery.skip(skip);
  }
  if (typeof unreadQuery.limit === "function") {
    unreadQuery = unreadQuery.limit(limit);
  }
  if (typeof unreadQuery.select === "function") {
    unreadQuery = unreadQuery.select("name phone service assignedTo lastMessage lastActivity unreadCount");
  }

  const rawLeads = typeof unreadQuery.lean === "function"
    ? await unreadQuery.lean()
    : await unreadQuery;
  const unreadLeads = Array.isArray(rawLeads) ? rawLeads : [];

  const formattedLeads = unreadLeads.map((l) => ({
    leadId: l._id ? l._id.toString() : "",
    customerName: l.name || "Customer",
    customerPhone: l.phone,
    service: l.service,
    assignedRep: l.assignedTo ? String(l.assignedTo) : "Unassigned",
    unreadCount: l.unreadCount || 1,
    lastMessageSnippet: l.lastMessage ? wrapUntrustedData(l.lastMessage.slice(0, 150)) : "No message text",
    lastReceivedIST: l.lastActivity
      ? new Date(l.lastActivity).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
      : "Recently",
  }));

  const summary = {
    periodEvaluated: dateRange.label,
    salespersonEvaluated: repResolution?.canonicalName || "All Sales Representatives",
    totalLeadsAwaitingReply: totalUnreadCount,
    messagingActivity: messageStats,
    unsupportedMetrics: unsupportedNote || undefined,
  };

  return formatPaginatedResponse({
    totalCount: totalUnreadCount,
    page,
    limit,
    records: formattedLeads,
    summary,
    filtersApplied: {
      salesperson: repResolution?.canonicalName || "All Salespeople",
      period: dateRange.label,
      type,
    },
  });
};
