import mongoose from "mongoose";
import { resolveSalesperson, listAllSalespeople } from "./salespersonResolver.js";
import { resolveAnalyticsDateRange } from "./dateRangeResolver.js";
import { validateAnalyticsQuery, formatPaginatedResponse } from "./analyticsQueryValidator.js";
import { wrapUntrustedData, escapeRegex } from "../securityUtils.js";
import { composeMongoQuery } from "./queryComposer.js";
import { getISTDateBoundaries } from "../dateUtils.js";
import { buildOwnerDirectory } from "./ownerResolver.js";

const canQuery = (model) => {
  if (!model) return false;
  if (model.prototype instanceof mongoose.Model || model.schema) {
    const readyState = model.db?.readyState ?? mongoose.connection?.readyState;
    return readyState === 1;
  }
  return true;
};

/**
 * Normalizes a phone string to the last 10 digits
 */
const normalize10 = (phoneStr) => {
  if (!phoneStr) return "";
  const digits = String(phoneStr).replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
};

/**
 * WhatsApp Analytics: Message volumes, unreplied leads, response tracking, and rep messaging activity.
 * Properly attributes messages through Lead ownership, verifies categories, and handles unsupported metrics explicitly.
 */
export const getWhatsAppAnalytics = async ({
  tenantModels = {},
  filters = {},
  pagination = {},
  organization = null,
}) => {
  const {
    type = "unreplied_leads", // "unreplied_leads", "unread_leads", "message_stats", "recent_messages_overview", "connection_status", "all"
    period = "all_time",
    startDate,
    endDate,
    salespersonNameOrId,
  } = filters;

  const { page, limit, skip } = validateAnalyticsQuery(pagination);
  const LeadModel = tenantModels.Lead;
  const MessageModel = tenantModels.Message;
  const ConversationModel = tenantModels.Conversation;

  const dateRange = resolveAnalyticsDateRange({ period, startDate, endDate });

  // 1. If connection_status is requested, delegate to getWhatsAppConnectionStatus
  if (type === "connection_status") {
    return getWhatsAppConnectionStatus({
      tenantModels,
      organization,
      filters: { salespersonNameOrId },
      pagination: { page, limit },
    });
  }

  // 2. Resolve salesperson if specified
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

  // 3. Identify assigned Leads for reliable salesperson attribution
  let assignedLeadIds = null;
  if (repResolution && !repResolution.all && canQuery(LeadModel)) {
    try {
      assignedLeadIds = await LeadModel.find(repResolution.leadAssignedFilter).distinct("_id");
    } catch (leadErr) {
      console.warn("[WhatsAppAnalytics] Error finding rep leads:", leadErr.message);
      assignedLeadIds = [];
    }
  }

  // 4. Message Volume Breakdown (from Message collection if present)
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

  // 5. If type is "message_stats", return the message stats directly
  if (type === "message_stats") {
    return formatPaginatedResponse({
      totalCount: messageStats.totalMessages,
      page,
      limit,
      records: [
        {
          metric: "Total Messages",
          count: messageStats.totalMessages,
          incoming: messageStats.incomingFromCustomers,
          outgoing: messageStats.outgoingFromTeamOrAI,
          responseRate: messageStats.responseRatePercent,
          periodEvaluated: dateRange.label,
        },
      ],
      summary: {
        periodEvaluated: dateRange.label,
        salespersonEvaluated: repResolution?.canonicalName || "All Sales Representatives",
        messagingActivity: messageStats,
        unsupportedMetrics: unsupportedNote || undefined,
      },
      filtersApplied: {
        salesperson: repResolution?.canonicalName || "All Salespeople",
        period: dateRange.label,
        type,
      },
    });
  }

  // 6. If type is "recent_messages_overview", return recent message records
  if (type === "recent_messages_overview" && canQuery(MessageModel)) {
    try {
      const rClauses = [];
      if (!dateRange.isAllTime) {
        rClauses.push({ timestamp: { $gte: dateRange.start, $lte: dateRange.end } });
      }
      if (assignedLeadIds !== null) {
        rClauses.push({ leadId: { $in: assignedLeadIds } });
      }
      const rMatch = composeMongoQuery(...rClauses);

      const totalMsgCount = typeof MessageModel.countDocuments === "function"
        ? await MessageModel.countDocuments(rMatch)
        : 0;

      let msgQuery = MessageModel.find(rMatch)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(limit)
        .select("messageId leadId contactPhone sender senderName direction messageType text timestamp status delivered read");

      const recentMsgs = typeof msgQuery.lean === "function" ? await msgQuery.lean() : await msgQuery;

      const formattedMsgs = (recentMsgs || []).map((m) => ({
        messageId: m.messageId || m._id?.toString(),
        leadId: m.leadId ? m.leadId.toString() : null,
        contactPhone: m.contactPhone || "Unknown",
        direction: m.direction || "incoming",
        sender: m.sender || "Unknown",
        senderName: m.senderName || undefined,
        messageType: m.messageType || "text",
        textSnippet: m.text ? wrapUntrustedData(m.text.slice(0, 160)) : "",
        timestampIST: m.timestamp
          ? new Date(m.timestamp).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
          : "Recently",
        status: m.status || (m.read ? "read" : m.delivered ? "delivered" : "sent"),
      }));

      return formatPaginatedResponse({
        totalCount: totalMsgCount,
        page,
        limit,
        records: formattedMsgs,
        summary: {
          periodEvaluated: dateRange.label,
          salespersonEvaluated: repResolution?.canonicalName || "All Sales Representatives",
          messagingActivity: messageStats,
        },
        filtersApplied: {
          salesperson: repResolution?.canonicalName || "All Salespeople",
          period: dateRange.label,
          type,
        },
      });
    } catch (rmErr) {
      console.warn("[WhatsAppAnalytics] Recent messages query error:", rmErr.message);
    }
  }

  // 7. Unreplied / Unread Leads (default & for "unreplied_leads", "unread_leads", "all")
  if (!canQuery(LeadModel)) {
    return {
      success: false,
      coverage: "unavailable",
      errorCode: "LEAD_MODEL_UNAVAILABLE",
      message: "Lead model not available to retrieve unreplied WhatsApp leads.",
    };
  }

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

  const ownerDir = await buildOwnerDirectory({ tenantModels });

  const formattedLeads = unreadLeads.map((l) => {
    const owner = ownerDir.resolveOwner(l.assignedTo);
    const displayName = (l.name && l.name.trim()) || l.phone || "Customer";
    return {
      leadId: l._id ? l._id.toString() : "",
      displayName,
      customerName: (l.name && l.name.trim()) || displayName,
      customerPhone: l.phone,
      service: l.service,
      assignedRep: owner.name,
      assignedRepId: owner.id || undefined,
      unreadCount: l.unreadCount || 1,
      lastMessageSnippet: l.lastMessage ? wrapUntrustedData(l.lastMessage.slice(0, 150)) : "No message text",
      lastReceivedIST: l.lastActivity
        ? new Date(l.lastActivity).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
        : "Recently",
    };
  });

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

/**
 * Retrieves WhatsApp connection status by team member.
 * Strictly redacts credentials, QR codes, and auth state tokens.
 */
export const getWhatsAppConnectionStatus = async ({
  tenantModels = {},
  organization = null,
  filters = {},
  pagination = {},
}) => {
  const { page, limit, skip } = validateAnalyticsQuery(pagination);
  const UserModel = tenantModels.User;
  const WhatsAppSessionModel = tenantModels.WhatsAppSession;

  if (!canQuery(UserModel)) {
    return {
      success: false,
      coverage: "unavailable",
      errorCode: "USER_MODEL_UNAVAILABLE",
      message: "User model not available to check WhatsApp connection status.",
    };
  }

  const orgId = organization?._id?.toString() || organization?.id;

  // Resolve salesperson if filtering by a specific rep
  let targetUserIds = null;
  if (filters.salespersonNameOrId) {
    const repRes = await resolveSalesperson({ tenantModels, identifier: filters.salespersonNameOrId });
    if (!repRes.resolved) {
      if (repRes.isAmbiguous) {
        return {
          success: false,
          error_code: "AMBIGUOUS_SALESPERSON",
          message: repRes.message,
          matches: repRes.matches,
        };
      }
      return formatPaginatedResponse({
        totalCount: 0,
        page,
        limit,
        records: [],
        summary: { totalReps: 0, connectedReps: 0, disconnectedReps: 0 },
        filtersApplied: { salesperson: filters.salespersonNameOrId },
        coverage: "complete",
        message: repRes.message || `Salesperson "${filters.salespersonNameOrId}" not found.`,
      });
    }
    if (repRes.canonicalId) {
      targetUserIds = [repRes.canonicalId];
    }
  }

  const userQuery = { status: "active" };
  if (targetUserIds) {
    userQuery._id = { $in: targetUserIds };
  } else {
    // Frontline sales roles
    userQuery.role = { $regex: /^sales\s*(person|rep)|telecaller|agent/i };
  }

  let users = await UserModel.find(userQuery)
    .select("name email phone role status")
    .lean();

  if ((!users || users.length === 0) && !targetUserIds) {
    // Fall back to all active users if no explicit sales roles found
    users = await UserModel.find({ status: "active" })
      .select("name email phone role status")
      .lean();
  }

  const teamStatuses = [];

  for (const u of users || []) {
    const uidStr = u._id ? u._id.toString() : u.id;
    let dbSession = null;

    if (canQuery(WhatsAppSessionModel)) {
      try {
        const sessionClauses = [{ userId: u._id }];
        if (orgId) {
          sessionClauses.push({ sessionId: `org_${orgId}_user_${uidStr}` });
        }
        dbSession = await WhatsAppSessionModel.findOne({ $or: sessionClauses })
          .select("status connectedPhone connectedName expectedPhone errorMessage updatedAt")
          .lean();
      } catch (_) {}
    }

    const rawStatus = dbSession?.status || "disconnected";
    const status = ["connected", "connecting", "qr", "disconnected"].includes(rawStatus)
      ? rawStatus
      : "disconnected";

    teamStatuses.push({
      userId: uidStr,
      name: u.name || "Unknown Representative",
      email: u.email || "",
      role: u.role || "sales person",
      whatsappStatus: status,
      connectionType: "Baileys WhatsApp Web",
      connectedPhone: dbSession?.connectedPhone || u.phone || "Not connected",
      expectedPhone: dbSession?.expectedPhone || u.phone || undefined,
      lastUpdatedIST: dbSession?.updatedAt
        ? new Date(dbSession.updatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
        : "Never connected",
      errorMessage: dbSession?.errorMessage || undefined,
    });
  }

  const connectedCount = teamStatuses.filter((s) => s.whatsappStatus === "connected").length;
  const disconnectedCount = teamStatuses.filter((s) => s.whatsappStatus === "disconnected").length;
  const pendingQrCount = teamStatuses.filter((s) => s.whatsappStatus === "qr" || s.whatsappStatus === "connecting").length;

  const pagedStatuses = teamStatuses.slice(skip, skip + limit);

  return formatPaginatedResponse({
    totalCount: teamStatuses.length,
    page,
    limit,
    records: pagedStatuses,
    summary: {
      totalRepsEvaluated: teamStatuses.length,
      connectedCount,
      disconnectedCount,
      pendingScanOrConnectingCount: pendingQrCount,
    },
    filtersApplied: {
      salesperson: filters.salespersonNameOrId || "All Sales Representatives",
    },
  });
};

/**
 * Searches WhatsApp Conversations with customer name, phone, lead association, unread status, and date range.
 */
export const searchWhatsAppConversations = async ({
  tenantModels = {},
  filters = {},
  pagination = {},
}) => {
  const {
    customerName,
    customerPhone,
    leadId,
    salespersonNameOrId,
    unreadOnly = false,
    searchTerm,
    period = "all_time",
    startDate,
    endDate,
  } = filters;

  const { page, limit, skip } = validateAnalyticsQuery(pagination);
  const ConversationModel = tenantModels.Conversation;
  const LeadModel = tenantModels.Lead;

  if (!canQuery(ConversationModel)) {
    return {
      success: false,
      coverage: "unavailable",
      errorCode: "CONVERSATION_MODEL_UNAVAILABLE",
      message: "Conversation model is not available in tenant database.",
    };
  }

  const dateRange = resolveAnalyticsDateRange({ period, startDate, endDate });
  const clauses = [];

  // Lead ID
  if (leadId && mongoose.Types.ObjectId.isValid(leadId)) {
    clauses.push({ leadId: new mongoose.Types.ObjectId(leadId) });
  }

  // Customer Phone
  if (customerPhone) {
    const last10 = normalize10(customerPhone);
    if (last10) {
      clauses.push({ phone: new RegExp(`${escapeRegex(last10)}$`) });
    }
  }

  // Customer Name
  if (customerName) {
    clauses.push({ customerName: new RegExp(escapeRegex(customerName.trim()), "i") });
  }

  // Unread status
  if (unreadOnly) {
    clauses.push({ unreadCount: { $gt: 0 } });
  }

  // Date range on lastMessageTime or startedAt
  if (!dateRange.isAllTime) {
    clauses.push({
      $or: [
        { lastMessageTime: { $gte: dateRange.start, $lte: dateRange.end } },
        { startedAt: { $gte: dateRange.start, $lte: dateRange.end } },
      ],
    });
  }

  // Salesperson filter (via assigned Lead or userId)
  if (salespersonNameOrId) {
    const repRes = await resolveSalesperson({ tenantModels, identifier: salespersonNameOrId });
    if (!repRes.resolved) {
      if (repRes.isAmbiguous) {
        return {
          success: false,
          error_code: "AMBIGUOUS_SALESPERSON",
          message: repRes.message,
          matches: repRes.matches,
        };
      }
      return formatPaginatedResponse({
        totalCount: 0,
        page,
        limit,
        records: [],
        filtersApplied: { salesperson: salespersonNameOrId },
        coverage: "complete",
        message: repRes.message || `Salesperson "${salespersonNameOrId}" not found.`,
      });
    }

    if (canQuery(LeadModel) && repRes.leadAssignedFilter) {
      try {
        const repLeadIds = await LeadModel.find(repRes.leadAssignedFilter).distinct("_id");
        const userOrLeadClauses = [{ leadId: { $in: repLeadIds } }];
        if (repRes.canonicalId && mongoose.Types.ObjectId.isValid(repRes.canonicalId)) {
          userOrLeadClauses.push({ userId: new mongoose.Types.ObjectId(repRes.canonicalId) });
        }
        clauses.push({ $or: userOrLeadClauses });
      } catch (_) {}
    }
  }

  // Search term
  if (searchTerm && searchTerm.trim()) {
    const sTerm = escapeRegex(searchTerm.trim());
    const digits = searchTerm.replace(/\D/g, "");
    const termOr = [
      { customerName: new RegExp(sTerm, "i") },
      { companyName: new RegExp(sTerm, "i") },
      { lastMessage: new RegExp(sTerm, "i") },
    ];
    if (digits.length >= 7) {
      termOr.push({ phone: new RegExp(`${digits.slice(-10)}$`) });
    }
    clauses.push({ $or: termOr });
  }

  const queryMatch = composeMongoQuery(...clauses);

  const totalCount = typeof ConversationModel.countDocuments === "function"
    ? await ConversationModel.countDocuments(queryMatch)
    : 0;

  let q = ConversationModel.find(queryMatch)
    .sort({ lastMessageTime: -1, updatedAt: -1 })
    .skip(skip)
    .limit(limit)
    .select("leadId phone customerName companyName unreadCount lastMessage lastMessageTime isLead chatSummary");

  const conversations = typeof q.lean === "function" ? await q.lean() : await q;

  const formatted = (conversations || []).map((c) => {
    const displayName = (c.customerName && c.customerName.trim()) || (c.companyName && c.companyName.trim()) || c.phone || "Customer";
    return {
      conversationId: c._id ? c._id.toString() : "",
      leadId: c.leadId ? c.leadId.toString() : null,
      displayName,
      customerName: (c.customerName && c.customerName.trim()) || displayName,
      customerPhone: c.phone || "Unknown",
      company: c.companyName || undefined,
      unreadCount: c.unreadCount || 0,
      lastMessage: c.lastMessage ? wrapUntrustedData(c.lastMessage.slice(0, 160)) : "No messages yet",
      lastMessageTimeIST: c.lastMessageTime
        ? new Date(c.lastMessageTime).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
        : undefined,
      isLead: Boolean(c.isLead),
      hasSummary: Boolean(c.chatSummary?.summary),
    };
  });

  return formatPaginatedResponse({
    totalCount,
    page,
    limit,
    records: formatted,
    filtersApplied: {
      customerName: customerName || undefined,
      customerPhone: customerPhone || undefined,
      salesperson: salespersonNameOrId || undefined,
      unreadOnly,
      period: dateRange.label,
    },
  });
};

/**
 * Retrieves chronological messages from a selected WhatsApp conversation / customer thread.
 * Treats customer message contents as untrusted input.
 */
export const getConversationMessages = async ({
  tenantModels = {},
  filters = {},
  pagination = {},
}) => {
  const { conversationId, leadId, customerPhone } = filters;
  const { page, limit, skip } = validateAnalyticsQuery(pagination);
  const MessageModel = tenantModels.Message;
  const ConversationModel = tenantModels.Conversation;

  if (!canQuery(MessageModel)) {
    return {
      success: false,
      coverage: "unavailable",
      errorCode: "MESSAGE_MODEL_UNAVAILABLE",
      message: "Message model is not available in tenant database.",
    };
  }

  const clauses = [];

  if (conversationId && mongoose.Types.ObjectId.isValid(conversationId)) {
    // If conversationId provided, find its leadId or phone to broaden query safely
    if (canQuery(ConversationModel)) {
      try {
        const conv = await ConversationModel.findById(conversationId).lean();
        if (conv) {
          const cOr = [];
          if (conv.leadId) cOr.push({ leadId: conv.leadId });
          if (conv.phone) {
            const p10 = normalize10(conv.phone);
            if (p10) cOr.push({ contactPhone: new RegExp(`${escapeRegex(p10)}$`) });
          }
          if (cOr.length > 0) clauses.push({ $or: cOr });
        }
      } catch (_) {}
    }
  }

  if (leadId && mongoose.Types.ObjectId.isValid(leadId)) {
    clauses.push({ leadId: new mongoose.Types.ObjectId(leadId) });
  }

  if (customerPhone) {
    const last10 = normalize10(customerPhone);
    if (last10) {
      clauses.push({ contactPhone: new RegExp(`${escapeRegex(last10)}$`) });
    }
  }

  if (clauses.length === 0) {
    return {
      success: false,
      errorCode: "MISSING_IDENTIFIER",
      message: "Please provide a conversationId, leadId, or customerPhone to retrieve conversation messages.",
    };
  }

  const matchQuery = composeMongoQuery(...clauses);

  const totalCount = typeof MessageModel.countDocuments === "function"
    ? await MessageModel.countDocuments(matchQuery)
    : 0;

  let msgQuery = MessageModel.find(matchQuery)
    .sort({ timestamp: 1 }) // Chronological order
    .skip(skip)
    .limit(limit)
    .select("messageId sender senderName direction messageType text mediaUrl timestamp status delivered read");

  const messages = typeof msgQuery.lean === "function" ? await msgQuery.lean() : await msgQuery;

  const formattedMessages = (messages || []).map((m) => ({
    messageId: m.messageId || m._id?.toString(),
    direction: m.direction || "incoming",
    sender: m.sender,
    senderName: m.senderName || undefined,
    messageType: m.messageType || "text",
    text: m.text ? wrapUntrustedData(m.text) : "[Non-text or Media Message]",
    timestampIST: m.timestamp
      ? new Date(m.timestamp).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
      : "Unknown",
    status: m.status || (m.read ? "read" : m.delivered ? "delivered" : "sent"),
  }));

  return formatPaginatedResponse({
    totalCount,
    page,
    limit,
    records: formattedMessages,
    filtersApplied: {
      conversationId: conversationId || undefined,
      leadId: leadId || undefined,
      customerPhone: customerPhone || undefined,
    },
  });
};

/**
 * Summarizes a selected conversation transcript:
 * Extracts key discussion points, customer intent, unresolved questions, sentiment, and next steps.
 * Treats message content as untrusted input.
 */
export const summarizeWhatsAppConversation = async ({
  tenantModels = {},
  filters = {},
}) => {
  const { conversationId, leadId, customerPhone } = filters;
  const ConversationModel = tenantModels.Conversation;
  const MessageModel = tenantModels.Message;
  const LeadModel = tenantModels.Lead;

  let convDoc = null;
  let leadDoc = null;

  if (canQuery(ConversationModel)) {
    try {
      if (conversationId && mongoose.Types.ObjectId.isValid(conversationId)) {
        convDoc = await ConversationModel.findById(conversationId).lean();
      } else if (leadId && mongoose.Types.ObjectId.isValid(leadId)) {
        convDoc = await ConversationModel.findOne({ leadId }).lean();
      } else if (customerPhone) {
        const last10 = normalize10(customerPhone);
        if (last10) {
          convDoc = await ConversationModel.findOne({ phone: new RegExp(`${escapeRegex(last10)}$`) }).lean();
        }
      }
    } catch (_) {}
  }

  const effectiveLeadId = convDoc?.leadId || (leadId && mongoose.Types.ObjectId.isValid(leadId) ? leadId : null);
  if (canQuery(LeadModel) && effectiveLeadId) {
    try {
      leadDoc = await LeadModel.findById(effectiveLeadId).select("name phone company service status assignedTo notes").lean();
    } catch (_) {}
  }

  // Retrieve up to 40 chronological messages
  let messages = [];
  if (canQuery(MessageModel)) {
    try {
      const clauses = [];
      if (effectiveLeadId) clauses.push({ leadId: effectiveLeadId });
      const phone = convDoc?.phone || customerPhone;
      if (phone) {
        const last10 = normalize10(phone);
        if (last10) clauses.push({ contactPhone: new RegExp(`${escapeRegex(last10)}$`) });
      }
      if (clauses.length > 0) {
        messages = await MessageModel.find(composeMongoQuery({ $or: clauses }))
          .sort({ timestamp: 1 })
          .limit(40)
          .lean();
      }
    } catch (_) {}
  }

  if (!convDoc && messages.length === 0) {
    return {
      success: false,
      errorCode: "CONVERSATION_NOT_FOUND",
      message: "No conversation or messages found matching the requested identifier.",
    };
  }

  // If chatSummary is already saved on Conversation document
  const savedSummary = convDoc?.chatSummary;

  // Extract customer and team text fragments
  const customerTexts = messages
    .filter((m) => m.direction === "incoming" && m.text)
    .map((m) => m.text.trim());
  const teamTexts = messages
    .filter((m) => m.direction === "outgoing" && m.text)
    .map((m) => m.text.trim());

  // Determine sentiment
  let sentiment = savedSummary?.sentiment || "Neutral";
  if (!savedSummary?.sentiment && customerTexts.length > 0) {
    const combinedCust = customerTexts.join(" ").toLowerCase();
    if (/thank|great|perfect|awesome|agree|interested|yes|ok/i.test(combinedCust)) {
      sentiment = "Positive";
    } else if (/bad|cancel|issue|delay|not interested|expensive|angry|poor/i.test(combinedCust)) {
      sentiment = "Negative";
    }
  }

  // Key discussion points & unresolved questions
  const keyPoints = (savedSummary?.keyPoints && savedSummary.keyPoints.length > 0)
    ? savedSummary.keyPoints
    : customerTexts.slice(0, 3).map((t) => `Customer inquired: "${t.slice(0, 80)}"`);

  const unresolved = customerTexts
    .filter((t) => t.includes("?") || /price|cost|quote|how much|when|status|update/i.test(t))
    .slice(-2)
    .map((q) => wrapUntrustedData(q));

  const ownerDir = await buildOwnerDirectory({ tenantModels });
  const owner = ownerDir.resolveOwner(leadDoc?.assignedTo);
  const displayName = (convDoc?.customerName && convDoc.customerName.trim()) || (leadDoc?.name && leadDoc.name.trim()) || (leadDoc?.company && leadDoc?.company.trim()) || convDoc?.phone || leadDoc?.phone || "Customer";

  const nextSteps = (savedSummary?.nextSteps && savedSummary.nextSteps.length > 0)
    ? savedSummary.nextSteps
    : [
        owner.name !== "Unassigned" ? `Assigned rep (${owner.name}) to follow up.` : "Assign representative to follow up.",
        unresolved.length > 0 ? "Address pending customer questions." : "Confirm customer requirements.",
      ];

  return {
    success: true,
    conversationId: convDoc?._id?.toString() || undefined,
    leadId: effectiveLeadId ? effectiveLeadId.toString() : undefined,
    displayName,
    customerName: (convDoc?.customerName && convDoc.customerName.trim()) || (leadDoc?.name && leadDoc?.name.trim()) || displayName,
    customerPhone: convDoc?.phone || leadDoc?.phone || customerPhone || "Unknown",
    assignedRep: owner.name,
    assignedRepId: owner.id || undefined,
    totalMessagesAnalyzed: messages.length,
    summary: {
      overview: savedSummary?.summary || (customerTexts.length > 0 ? `Customer initiated ${customerTexts.length} inquiries; team sent ${teamTexts.length} replies.` : "Conversation initiated with no recent messages."),
      keyPoints,
      customerIntent: customerTexts.length > 0 ? `Service inquiry regarding ${leadDoc?.service || "CRM service"}` : "General inquiry",
      unresolvedQuestions: unresolved.length > 0 ? unresolved : ["None identified; conversation is current."],
      sentiment,
      nextSteps,
    },
  };
};
