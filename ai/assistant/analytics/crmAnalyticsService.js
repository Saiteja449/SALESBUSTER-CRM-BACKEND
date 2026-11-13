import mongoose from "mongoose";
import { resolveSalesperson, listAllSalespeople } from "./salespersonResolver.js";
import { resolveAnalyticsDateRange } from "./dateRangeResolver.js";
import { searchCallRecords, getMissedCallAnalytics } from "./callAnalyticsService.js";
import { searchLeadsAdvanced } from "./leadAnalyticsService.js";
import { getFollowupAnalytics } from "./followupAnalyticsService.js";
import { getConversionAnalytics } from "./conversionAnalyticsService.js";
import { getRecordingAnalytics } from "./recordingAnalyticsService.js";
import {
  getWhatsAppAnalytics,
  getWhatsAppConnectionStatus,
  searchWhatsAppConversations,
  getConversationMessages,
  summarizeWhatsAppConversation,
} from "./whatsappAnalyticsService.js";
import { formatDuration, getISTDateBoundaries } from "../dateUtils.js";
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
 * CRM 360-degree Overview synthesizing leads, calls, missed calls, follow-ups, and whatsapp activity
 */
export const getCRMOverview = async ({
  tenantModels = {},
  filters = {},
}) => {
  const { period = "all_time", startDate, endDate } = filters;
  const dateRange = resolveAnalyticsDateRange({ period, startDate, endDate });

  const LeadModel = tenantModels.Lead;
  const FollowupModel = tenantModels.Followup;
  const CallRecordModel = tenantModels.CallRecord;
  const AnalyticsModel = tenantModels.TelecallerAnalytics;
  const MessageModel = tenantModels.Message;

  const boundaries = getISTDateBoundaries();
  const todayStr = boundaries.todayStr;

  const anyModelAvailable = canQuery(LeadModel) || canQuery(CallRecordModel) || canQuery(FollowupModel) || canQuery(MessageModel);
  if (!anyModelAvailable) {
    return {
      success: false,
      coverage: "unavailable",
      dataCoverage: "unavailable",
      errorCode: "ALL_MODELS_UNAVAILABLE",
      message: "Database models unavailable in tenant context.",
      periodEvaluated: dateRange.label,
      timezone: "Asia/Kolkata",
      coverageWarnings: ["No CRM database models were available to query."],
    };
  }

  const coverageWarnings = [];

  // 1. Lead KPI Facet
  let leadStats = {
    totalLeads: 0,
    newLeads: 0,
    activeLeads: 0,
    convertedLeads: 0,
    lostLeads: 0,
    unassignedLeads: 0,
    convertedRevenue: "₹0",
    activePipelineValue: "₹0",
    totalDealValue: "₹0",
  };

  if (canQuery(LeadModel)) {
    try {
      const matchStage = dateRange.isAllTime ? {} : { createdAt: { $gte: dateRange.start, $lte: dateRange.end } };
      const [lRes] = await LeadModel.aggregate([
        { $match: matchStage },
        {
          $facet: {
            totals: [
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  converted: { $sum: { $cond: [{ $eq: ["$status", "Converted"] }, 1, 0] } },
                  new: { $sum: { $cond: [{ $eq: ["$status", "New"] }, 1, 0] } },
                  active: {
                    $sum: {
                      $cond: [
                        { $in: ["$status", ["New", "Follow Up", "Missed Call"]] },
                        1,
                        0,
                      ],
                    },
                  },
                  lost: {
                    $sum: {
                      $cond: [
                        {
                          $in: [
                            "$status",
                            ["Not Interested", "Price Issue", "Not Attended", "Lost", "lost"],
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  unassigned: {
                    $sum: {
                      $cond: [
                        {
                          $or: [
                            { $eq: ["$assignedTo", "Unassigned"] },
                            { $eq: ["$assignedTo", "unassigned"] },
                            { $eq: ["$assignedTo", null] },
                            { $eq: ["$assignedTo", ""] },
                            { $not: ["$assignedTo"] },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  convRev: {
                    $sum: {
                      $cond: [{ $eq: ["$status", "Converted"] }, { $ifNull: ["$dealValue", 0] }, 0],
                    },
                  },
                  pipeVal: {
                    $sum: {
                      $cond: [
                        { $in: ["$status", ["New", "Follow Up", "Missed Call"]] },
                        { $ifNull: ["$dealValue", 0] },
                        0,
                      ],
                    },
                  },
                  dealVal: { $sum: { $ifNull: ["$dealValue", 0] } },
                },
              },
            ],
          },
        },
      ]);

      const t = lRes?.totals[0];
      if (t) {
        leadStats = {
          totalLeads: t.total || 0,
          newLeads: t.new || 0,
          activeLeads: t.active || 0,
          convertedLeads: t.converted || 0,
          lostLeads: t.lost || 0,
          unassignedLeads: t.unassigned || 0,
          convertedRevenue: t.convRev > 0 ? `₹${t.convRev.toLocaleString("en-IN")}` : "₹0",
          activePipelineValue: t.pipeVal > 0 ? `₹${t.pipeVal.toLocaleString("en-IN")}` : "₹0",
          totalDealValue: t.dealVal > 0 ? `₹${t.dealVal.toLocaleString("en-IN")}` : "₹0",
        };
      }
    } catch (lErr) {
      coverageWarnings.push(`Lead aggregation error: ${lErr.message}`);
      console.warn("[CRMOverview] Lead aggregation error:", lErr.message);
    }
  }

  // 2. Call KPIs (from CallRecord, TelecallerAnalytics, or Lead.callHistory)
  let callStats = {
    totalCalls: 0,
    incomingCalls: 0,
    outgoingCalls: 0,
    connectedCalls: 0,
    missedCalls: 0,
    rejectedCalls: 0,
    totalTalkTime: "0s",
  };

  if (canQuery(CallRecordModel)) {
    try {
      const callMatch = dateRange.isAllTime ? {} : { calledAt: { $gte: dateRange.start, $lte: dateRange.end } };
      const [cRes] = await CallRecordModel.aggregate([
        { $match: callMatch },
        {
          $facet: {
            totals: [
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  incoming: { $sum: { $cond: [{ $in: ["$callType", ["incoming", "missed"]] }, 1, 0] } },
                  outgoing: { $sum: { $cond: [{ $eq: ["$callType", "outgoing"] }, 1, 0] } },
                  connected: { $sum: { $cond: [{ $eq: ["$callStatus", "connected"] }, 1, 0] } },
                  missed: { $sum: { $cond: [{ $eq: ["$callStatus", "missed"] }, 1, 0] } },
                  rejected: { $sum: { $cond: [{ $eq: ["$callStatus", "rejected"] }, 1, 0] } },
                  talkSec: { $sum: { $ifNull: ["$duration", 0] } },
                },
              },
            ],
          },
        },
      ]);

      const c = cRes?.totals[0];
      if (c && c.total > 0) {
        callStats = {
          totalCalls: c.total || 0,
          incomingCalls: c.incoming || 0,
          outgoingCalls: c.outgoing || 0,
          connectedCalls: c.connected || 0,
          missedCalls: c.missed || 0,
          rejectedCalls: c.rejected || 0,
          totalTalkTime: formatDuration(c.talkSec || 0),
        };
      }
    } catch (_) {}
  }

  if (callStats.totalCalls === 0 && canQuery(AnalyticsModel)) {
    try {
      const aMatch = dateRange.isAllTime ? {} : { date: { $gte: dateRange.startStr, $lte: dateRange.endStr } };
      const [aRes] = await AnalyticsModel.aggregate([
        { $match: aMatch },
        {
          $group: {
            _id: null,
            total: { $sum: "$totalCalls" },
            incoming: { $sum: "$incoming" },
            outgoing: { $sum: "$outgoing" },
            connected: { $sum: "$connected" },
            missed: { $sum: "$missed" },
            rejected: { $sum: "$rejected" },
            talkSec: { $sum: "$talkTime" },
          },
        },
      ]);
      if (aRes) {
        callStats = {
          totalCalls: aRes.total || 0,
          incomingCalls: aRes.incoming || 0,
          outgoingCalls: aRes.outgoing || 0,
          connectedCalls: aRes.connected || 0,
          missedCalls: aRes.missed || 0,
          rejectedCalls: aRes.rejected || 0,
          totalTalkTime: formatDuration(aRes.talkSec || 0),
        };
      }
    } catch (_) {}
  }

  // 3. Followup KPIs (period-scoped tasks plus all-time backlog)
  let followupStats = {
    pendingFollowups: 0,
    overdueFollowups: 0,
    completedFollowups: 0,
    periodEvaluated: dateRange.label,
    allTimeBacklog: {
      totalPending: 0,
      totalOverdue: 0,
    },
  };

  if (canQuery(FollowupModel)) {
    try {
      const periodFacet = dateRange.isAllTime
        ? {
            pending: [{ $match: { done: false } }, { $count: "c" }],
            overdue: [{ $match: { done: false, date: { $lt: todayStr } } }, { $count: "c" }],
            completed: [{ $match: { done: true } }, { $count: "c" }],
          }
        : {
            pending: [
              { $match: { done: false, date: { $gte: dateRange.startStr, $lte: dateRange.endStr } } },
              { $count: "c" },
            ],
            overdue: [
              { $match: { done: false, date: { $gte: dateRange.startStr, $lte: dateRange.endStr, $lt: todayStr } } },
              { $count: "c" },
            ],
            completed: [
              { $match: { done: true, date: { $gte: dateRange.startStr, $lte: dateRange.endStr } } },
              { $count: "c" },
            ],
          };

      const [fRes] = await FollowupModel.aggregate([
        {
          $facet: {
            ...periodFacet,
            allPending: [{ $match: { done: false } }, { $count: "c" }],
            allOverdue: [{ $match: { done: false, date: { $lt: todayStr } } }, { $count: "c" }],
          },
        },
      ]);
      followupStats = {
        pendingFollowups: fRes?.pending[0]?.c || 0,
        overdueFollowups: fRes?.overdue[0]?.c || 0,
        completedFollowups: fRes?.completed[0]?.c || 0,
        periodEvaluated: dateRange.label,
        allTimeBacklog: {
          totalPending: fRes?.allPending[0]?.c || 0,
          totalOverdue: fRes?.allOverdue[0]?.c || 0,
        },
      };
    } catch (fuErr) {
      coverageWarnings.push(`Followup overview query error: ${fuErr.message}`);
    }
  }

  // 4. WhatsApp KPIs
  let whatsappStats = {
    leadsAwaitingReply: 0,
    totalMessagesSent: 0,
    totalMessagesReceived: 0,
  };

  if (canQuery(LeadModel)) {
    try {
      whatsappStats.leadsAwaitingReply = await LeadModel.countDocuments({
        $or: [{ unreadCount: { $gt: 0 } }, { hasUnread: true }],
      });
    } catch (_) {}
  }
  if (canQuery(MessageModel)) {
    try {
      const msgMatch = dateRange.isAllTime ? {} : { timestamp: { $gte: dateRange.start, $lte: dateRange.end } };
      const [mRes] = await MessageModel.aggregate([
        { $match: msgMatch },
        {
          $facet: {
            outgoing: [{ $match: { direction: "outgoing" } }, { $count: "c" }],
            incoming: [{ $match: { direction: "incoming" } }, { $count: "c" }],
          },
        },
      ]);
      whatsappStats.totalMessagesSent = mRes?.outgoing[0]?.c || 0;
      whatsappStats.totalMessagesReceived = mRes?.incoming[0]?.c || 0;
    } catch (_) {}
  }

  // 5. Recordings (Lead uploads + CallRecord recordings)
  let availableRecordings = 0;
  if (canQuery(LeadModel)) {
    try {
      const leadRecMatch = dateRange.isAllTime
        ? {}
        : {
            $or: [
              { "recordings.uploadedAt": { $gte: dateRange.start, $lte: dateRange.end } },
              { createdAt: { $gte: dateRange.start, $lte: dateRange.end } },
            ],
          };
      const [rRes] = await LeadModel.aggregate([
        { $match: leadRecMatch },
        { $unwind: "$recordings" },
        ...(dateRange.isAllTime
          ? []
          : [
              {
                $match: {
                  $or: [
                    { "recordings.uploadedAt": { $gte: dateRange.start, $lte: dateRange.end } },
                    {
                      $and: [
                        { "recordings.uploadedAt": { $exists: false } },
                        { createdAt: { $gte: dateRange.start, $lte: dateRange.end } },
                      ],
                    },
                  ],
                },
              },
            ]),
        { $count: "c" },
      ]);
      availableRecordings += rRes?.c || 0;
    } catch (_) {}
  }
  if (canQuery(CallRecordModel)) {
    try {
      const crFilter = { recordingUrl: { $exists: true, $ne: null } };
      if (!dateRange.isAllTime) {
        crFilter.calledAt = { $gte: dateRange.start, $lte: dateRange.end };
      }
      const crRecordingsCount = await CallRecordModel.countDocuments(crFilter);
      availableRecordings += crRecordingsCount;
    } catch (_) {}
  }

  return {
    success: true,
    coverage: coverageWarnings.length > 0 ? "partial" : "complete",
    dataCoverage: coverageWarnings.length > 0 ? "partial" : "complete",
    periodEvaluated: dateRange.label,
    timezone: "Asia/Kolkata",
    ownershipAttribution: {
      leadAttribution: "Current Lead Assignment (Lead.assignedTo)",
      callAttribution: "Historical Event Activity (CallRecord.salespersonId / CallRecord.salespersonName)",
      followupAttribution: "Current Lead Assignment (Lead.assignedTo)",
    },
    leads: leadStats,
    calls: callStats,
    followups: followupStats,
    whatsapp: whatsappStats,
    recordings: {
      availableRecordings,
    },
    coverageWarnings,
  };
};

/**
 * Comprehensive Salesperson Performance & Leaderboard analytics
 */
export const getSalespersonAnalytics = async ({
  tenantModels = {},
  filters = {},
}) => {
  const {
    period = "all_time",
    startDate,
    endDate,
    salespersonNameOrId,
  } = filters;

  const LeadModel = tenantModels.Lead;
  const UserModel = tenantModels.User;
  const FollowupModel = tenantModels.Followup;
  const AnalyticsModel = tenantModels.TelecallerAnalytics;
  const CallRecordModel = tenantModels.CallRecord;

  if (!canQuery(LeadModel) || !canQuery(UserModel)) {
    return {
      success: false,
      coverage: "unavailable",
      dataCoverage: "unavailable",
      errorCode: "MODELS_UNAVAILABLE",
      message: "Required models (Lead, User) are not available in tenant database.",
      periodEvaluated: dateRange.label,
      timezone: "Asia/Kolkata",
      teamLeaderboard: [],
    };
  }

  const dateRange = resolveAnalyticsDateRange({ period, startDate, endDate });

  // 1. Fetch all users directory (active and inactive, all roles)
  const ownerDir = await buildOwnerDirectory({ tenantModels });
  const allUsers = ownerDir.allUsers;

  // 2. Aggregate Leads by assignedTo
  const leadMatch = dateRange.isAllTime ? {} : { createdAt: { $gte: dateRange.start, $lte: dateRange.end } };
  const leadAgg = await LeadModel.aggregate([
    { $match: leadMatch },
    {
      $group: {
        _id: "$assignedTo",
        totalLeads: { $sum: 1 },
        newLeads: { $sum: { $cond: [{ $eq: ["$status", "New"] }, 1, 0] } },
        convertedLeads: { $sum: { $cond: [{ $eq: ["$status", "Converted"] }, 1, 0] } },
        lostLeads: {
          $sum: {
            $cond: [
              { $in: ["$status", ["Not Interested", "Price Issue", "Not Attended", "Lost", "lost"]] },
              1,
              0,
            ],
          },
        },
        dealValue: { $sum: { $ifNull: ["$dealValue", 0] } },
      },
    },
  ]);

  const leadStatsMap = new Map();
  let unassignedLeads = 0;
  for (const la of leadAgg) {
    const owner = ownerDir.resolveOwner(la._id);
    if (!owner.id && owner.name === "Unassigned") {
      unassignedLeads += la.totalLeads;
    } else {
      const existing = (owner.id && leadStatsMap.get(owner.id)) || {
        totalLeads: 0,
        newLeads: 0,
        convertedLeads: 0,
        lostLeads: 0,
        dealValue: 0,
      };
      existing.totalLeads += la.totalLeads || 0;
      existing.newLeads += la.newLeads || 0;
      existing.convertedLeads += la.convertedLeads || 0;
      existing.lostLeads += la.lostLeads || 0;
      existing.dealValue += la.dealValue || 0;
      if (owner.id) leadStatsMap.set(owner.id, existing);
      if (owner.name) leadStatsMap.set(owner.name.toLowerCase(), existing);
    }
  }

  // 3. Aggregate Call stats from CallRecord or TelecallerAnalytics
  const callStatsMap = new Map();
  let unassignedMissedCalls = 0;

  if (canQuery(CallRecordModel)) {
    try {
      const callMatch = dateRange.isAllTime ? {} : { calledAt: { $gte: dateRange.start, $lte: dateRange.end } };
      const callAgg = await CallRecordModel.aggregate([
        { $match: callMatch },
        {
          $group: {
            _id: { $ifNull: ["$salespersonId", "$salespersonName"] },
            salespersonName: { $first: "$salespersonName" },
            totalCalls: { $sum: 1 },
            incoming: { $sum: { $cond: [{ $in: ["$callType", ["incoming", "missed"]] }, 1, 0] } },
            outgoing: { $sum: { $cond: [{ $eq: ["$callType", "outgoing"] }, 1, 0] } },
            connected: { $sum: { $cond: [{ $eq: ["$callStatus", "connected"] }, 1, 0] } },
            missed: { $sum: { $cond: [{ $eq: ["$callStatus", "missed"] }, 1, 0] } },
            talkTime: { $sum: { $ifNull: ["$duration", 0] } },
          },
        },
      ]);

      for (const ca of callAgg) {
        const owner = ownerDir.resolveOwner(ca._id || ca.salespersonName);
        if (!owner.id && owner.name === "Unassigned") {
          unassignedMissedCalls += ca.missed || 0;
        } else {
          const existing = (owner.id && callStatsMap.get(owner.id)) || {
            totalCalls: 0,
            incoming: 0,
            outgoing: 0,
            connected: 0,
            missed: 0,
            talkTime: 0,
          };
          existing.totalCalls += ca.totalCalls || 0;
          existing.incoming += ca.incoming || 0;
          existing.outgoing += ca.outgoing || 0;
          existing.connected += ca.connected || 0;
          existing.missed += ca.missed || 0;
          existing.talkTime += ca.talkTime || 0;
          if (owner.id) callStatsMap.set(owner.id, existing);
          if (owner.name) callStatsMap.set(owner.name.toLowerCase(), existing);
        }
      }
    } catch (_) {}
  }

  // Complement from TelecallerAnalytics if CallRecord has no records
  if (callStatsMap.size === 0 && canQuery(AnalyticsModel)) {
    try {
      const aMatch = dateRange.isAllTime ? {} : { date: { $gte: dateRange.startStr, $lte: dateRange.endStr } };
      const aAgg = await AnalyticsModel.aggregate([
        { $match: aMatch },
        {
          $group: {
            _id: { $ifNull: ["$salespersonId", "$salesperson"] },
            salespersonName: { $first: "$salesperson" },
            totalCalls: { $sum: "$totalCalls" },
            incoming: { $sum: "$incoming" },
            outgoing: { $sum: "$outgoing" },
            connected: { $sum: "$connected" },
            missed: { $sum: "$missed" },
            talkTime: { $sum: "$talkTime" },
          },
        },
      ]);
      for (const ca of aAgg) {
        const owner = ownerDir.resolveOwner(ca._id || ca.salespersonName);
        if (!owner.id && owner.name === "Unassigned") {
          unassignedMissedCalls += ca.missed || 0;
        } else {
          const existing = (owner.id && callStatsMap.get(owner.id)) || {
            totalCalls: 0,
            incoming: 0,
            outgoing: 0,
            connected: 0,
            missed: 0,
            talkTime: 0,
          };
          existing.totalCalls += ca.totalCalls || 0;
          existing.incoming += ca.incoming || 0;
          existing.outgoing += ca.outgoing || 0;
          existing.connected += ca.connected || 0;
          existing.missed += ca.missed || 0;
          existing.talkTime += ca.talkTime || 0;
          if (owner.id) callStatsMap.set(owner.id, existing);
          if (owner.name) callStatsMap.set(owner.name.toLowerCase(), existing);
        }
      }
    } catch (_) {}
  }

  // 4. Aggregate Follow-ups by salesperson
  const boundaries = getISTDateBoundaries();
  const todayStr = boundaries.todayStr;
  const followupStatsMap = new Map();

  if (canQuery(FollowupModel)) {
    try {
      const [fFacet] = await FollowupModel.aggregate([
        {
          $facet: {
            pendingByAuthor: [
              { $match: { done: false } },
              { $group: { _id: "$author", count: { $sum: 1 } } },
            ],
            overdueByAuthor: [
              { $match: { done: false, date: { $lt: todayStr } } },
              { $group: { _id: "$author", count: { $sum: 1 } } },
            ],
            completedByAuthor: [
              { $match: { done: true } },
              { $group: { _id: "$author", count: { $sum: 1 } } },
            ],
          },
        },
      ]);

      for (const p of fFacet?.pendingByAuthor || []) {
        if (p._id) {
          const owner = ownerDir.resolveOwner(p._id);
          const k = owner.id || (owner.name ? owner.name.toLowerCase() : String(p._id).toLowerCase());
          if (!followupStatsMap.has(k)) followupStatsMap.set(k, {});
          const entry = followupStatsMap.get(k);
          entry.pending = (entry.pending || 0) + p.count;
          if (owner.name) followupStatsMap.set(owner.name.toLowerCase(), entry);
        }
      }
      for (const o of fFacet?.overdueByAuthor || []) {
        if (o._id) {
          const owner = ownerDir.resolveOwner(o._id);
          const k = owner.id || (owner.name ? owner.name.toLowerCase() : String(o._id).toLowerCase());
          if (!followupStatsMap.has(k)) followupStatsMap.set(k, {});
          const entry = followupStatsMap.get(k);
          entry.overdue = (entry.overdue || 0) + o.count;
          if (owner.name) followupStatsMap.set(owner.name.toLowerCase(), entry);
        }
      }
      for (const c of fFacet?.completedByAuthor || []) {
        if (c._id) {
          const owner = ownerDir.resolveOwner(c._id);
          const k = owner.id || (owner.name ? owner.name.toLowerCase() : String(c._id).toLowerCase());
          if (!followupStatsMap.has(k)) followupStatsMap.set(k, {});
          const entry = followupStatsMap.get(k);
          entry.completed = (entry.completed || 0) + c.count;
          if (owner.name) followupStatsMap.set(owner.name.toLowerCase(), entry);
        }
      }
    } catch (_) {}
  }

  // 5. Build Cards for Each User
  const performanceList = [];

  for (const user of allUsers) {
    const uid = user.id || (user._id ? user._id.toString() : "");
    const uname = user.name || user.email;
    const unameLower = uname ? uname.toLowerCase() : "";

    const lStat = leadStatsMap.get(uid) || leadStatsMap.get(unameLower) || {};
    const cStat = callStatsMap.get(uid) || callStatsMap.get(unameLower) || {};
    const fStat = followupStatsMap.get(uid) || followupStatsMap.get(unameLower) || {};

    const totLeads = lStat.totalLeads || 0;
    const convLeads = lStat.convertedLeads || 0;
    const convRate = totLeads > 0 ? Math.round((convLeads / totLeads) * 100) : 0;
    const talkSec = cStat.talkTime || 0;

    performanceList.push({
      repId: uid,
      salespersonId: uid,
      name: uname,
      salesperson: uname,
      salespersonName: uname,
      role: user.role,
      status: user.status,
      // Lead metrics
      totalLeads: totLeads,
      newLeads: lStat.newLeads || 0,
      convertedLeads: convLeads,
      lostLeads: lStat.lostLeads || 0,
      conversionRatePercent: `${convRate}%`,
      conversionRateNum: convRate,
      dealValue: lStat.dealValue > 0 ? `₹${lStat.dealValue.toLocaleString("en-IN")}` : "₹0",
      // Call metrics
      totalCalls: cStat.totalCalls || 0,
      incomingCalls: cStat.incoming || 0,
      outgoingCalls: cStat.outgoing || 0,
      connectedCalls: cStat.connected || 0,
      missedCalls: cStat.missed || 0,
      talkTime: formatDuration(talkSec),
      rawTalkTimeSeconds: talkSec,
      // Followup metrics
      pendingFollowups: fStat.pending || 0,
      overdueFollowups: fStat.overdue || 0,
      completedFollowups: fStat.completed || 0,
    });
  }

  // Sort descending by totalLeads
  performanceList.sort((a, b) => b.totalLeads - a.totalLeads);

  // Filter down if specific salesperson requested
  let results = performanceList;
  if (salespersonNameOrId && salespersonNameOrId.trim()) {
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
      return {
        success: true,
        coverage: "complete",
        dataCoverage: "complete",
        periodEvaluated: dateRange.label,
        timezone: "Asia/Kolkata",
        totalMatchingCount: 0,
        returnedCount: 0,
        topPerformerByLeads: null,
        unassignedLeadsCount: unassignedLeads,
        unassignedMissedCallsCount: unassignedMissedCalls,
        teamLeaderboard: [],
        message: repRes.message || `Salesperson "${salespersonNameOrId}" not found.`,
      };
    }

    if (repRes.canonicalId) {
      results = performanceList.filter((r) => r.repId === repRes.canonicalId);
    } else if (repRes.canonicalName) {
      const searchName = repRes.canonicalName.toLowerCase();
      results = performanceList.filter((r) => r.name.toLowerCase().includes(searchName));
    }
  }

  const topPerformer = performanceList.length > 0 ? performanceList[0] : null;

  return {
    success: true,
    coverage: "complete",
    dataCoverage: "complete",
    periodEvaluated: dateRange.label,
    timezone: "Asia/Kolkata",
    ownershipAttribution: {
      leadAttribution: "Current Lead Assignment (Lead.assignedTo)",
      callAttribution: "Historical Event Activity (CallRecord.salespersonId / CallRecord.salespersonName)",
      followupAttribution: "Current Lead Assignment (Lead.assignedTo)",
    },
    topPerformerByLeads: topPerformer
      ? {
          name: topPerformer.name,
          leads: topPerformer.totalLeads,
          conversions: topPerformer.convertedLeads,
          conversionRate: topPerformer.conversionRatePercent,
        }
      : null,
    unassignedLeadsCount: unassignedLeads,
    unassignedMissedCallsCount: unassignedMissedCalls,
    teamLeaderboard: results,
  };
};

export {
  resolveSalesperson,
  listAllSalespeople,
  resolveAnalyticsDateRange,
  searchCallRecords,
  getMissedCallAnalytics,
  searchLeadsAdvanced,
  getFollowupAnalytics,
  getConversionAnalytics,
  getRecordingAnalytics,
  getWhatsAppAnalytics,
  getWhatsAppConnectionStatus,
  searchWhatsAppConversations,
  getConversationMessages,
  summarizeWhatsAppConversation,
};

