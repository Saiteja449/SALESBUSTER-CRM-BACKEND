import mongoose from "mongoose";
import { resolveSalesperson, listAllSalespeople } from "./salespersonResolver.js";
import { resolveAnalyticsDateRange } from "./dateRangeResolver.js";
import { searchCallRecords, getMissedCallAnalytics } from "./callAnalyticsService.js";
import { searchLeadsAdvanced } from "./leadAnalyticsService.js";
import { getFollowupAnalytics } from "./followupAnalyticsService.js";
import { getConversionAnalytics } from "./conversionAnalyticsService.js";
import { getRecordingAnalytics } from "./recordingAnalyticsService.js";
import { getWhatsAppAnalytics } from "./whatsappAnalyticsService.js";
import { formatDuration, getISTDateBoundaries } from "../dateUtils.js";

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

  // 1. Lead KPI Facet
  let leadStats = {
    totalLeads: 0,
    newLeads: 0,
    activeLeads: 0,
    convertedLeads: 0,
    lostLeads: 0,
    unassignedLeads: 0,
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
                        { $in: ["$status", ["Not Interested", "Price Issue", "Not Attended"]] },
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
                            { $eq: ["$assignedTo", null] },
                            { $eq: ["$assignedTo", ""] },
                          ],
                        },
                        1,
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
          totalDealValue: t.dealVal > 0 ? `₹${t.dealVal.toLocaleString("en-IN")}` : "₹0",
        };
      }
    } catch (lErr) {
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

  // 3. Followup KPIs
  let followupStats = {
    pendingFollowups: 0,
    overdueFollowups: 0,
    completedFollowups: 0,
  };

  if (canQuery(FollowupModel)) {
    try {
      const [fRes] = await FollowupModel.aggregate([
        {
          $facet: {
            pending: [{ $match: { done: false } }, { $count: "c" }],
            overdue: [{ $match: { done: false, date: { $lt: todayStr } } }, { $count: "c" }],
            completed: [{ $match: { done: true } }, { $count: "c" }],
          },
        },
      ]);
      followupStats = {
        pendingFollowups: fRes?.pending[0]?.c || 0,
        overdueFollowups: fRes?.overdue[0]?.c || 0,
        completedFollowups: fRes?.completed[0]?.c || 0,
      };
    } catch (_) {}
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
      const [mRes] = await MessageModel.aggregate([
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

  // 5. Recordings
  let availableRecordings = 0;
  if (canQuery(LeadModel)) {
    try {
      const [rRes] = await LeadModel.aggregate([
        { $unwind: "$recordings" },
        { $count: "c" },
      ]);
      availableRecordings = rRes?.c || 0;
    } catch (_) {}
  }

  return {
    success: true,
    periodEvaluated: dateRange.label,
    leads: leadStats,
    calls: callStats,
    followups: followupStats,
    whatsapp: whatsappStats,
    recordings: {
      availableRecordings,
    },
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
    return { success: false, error: "Required models not available in tenant database" };
  }

  const dateRange = resolveAnalyticsDateRange({ period, startDate, endDate });

  // 1. Fetch all salespeople (active and inactive)
  const allUsers = await listAllSalespeople({ tenantModels });
  const userMap = new Map();
  for (const u of allUsers) {
    userMap.set(u._id.toString(), u);
    if (u.name) userMap.set(u.name.toLowerCase(), u);
  }

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
            $cond: [{ $in: ["$status", ["Not Interested", "Price Issue", "Not Attended"]] }, 1, 0],
          },
        },
        dealValue: { $sum: { $ifNull: ["$dealValue", 0] } },
      },
    },
  ]);

  const leadStatsMap = new Map();
  let unassignedLeads = 0;
  for (const la of leadAgg) {
    const rawId = la._id ? String(la._id) : "Unassigned";
    if (rawId === "Unassigned" || rawId === "null" || rawId === "") {
      unassignedLeads += la.totalLeads;
    } else {
      leadStatsMap.set(rawId, la);
      leadStatsMap.set(rawId.toLowerCase(), la);
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
        const key = ca._id ? String(ca._id).toLowerCase() : "";
        if (key === "unassigned" || !ca._id) {
          unassignedMissedCalls += ca.missed || 0;
        } else {
          callStatsMap.set(key, ca);
          if (ca.salespersonName) callStatsMap.set(ca.salespersonName.toLowerCase(), ca);
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
        const key = ca._id ? String(ca._id).toLowerCase() : "";
        if (key === "unassigned" || !ca._id) {
          unassignedMissedCalls += ca.missed || 0;
        } else {
          callStatsMap.set(key, ca);
          if (ca.salespersonName) callStatsMap.set(ca.salespersonName.toLowerCase(), ca);
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
          const k = String(p._id).toLowerCase();
          if (!followupStatsMap.has(k)) followupStatsMap.set(k, {});
          followupStatsMap.get(k).pending = p.count;
        }
      }
      for (const o of fFacet?.overdueByAuthor || []) {
        if (o._id) {
          const k = String(o._id).toLowerCase();
          if (!followupStatsMap.has(k)) followupStatsMap.set(k, {});
          followupStatsMap.get(k).overdue = o.count;
        }
      }
      for (const c of fFacet?.completedByAuthor || []) {
        if (c._id) {
          const k = String(c._id).toLowerCase();
          if (!followupStatsMap.has(k)) followupStatsMap.set(k, {});
          followupStatsMap.get(k).completed = c.count;
        }
      }
    } catch (_) {}
  }

  // 5. Build Cards for Each User
  const performanceList = [];

  for (const user of allUsers) {
    const uid = user._id.toString();
    const uname = user.name || user.email;
    const unameLower = uname.toLowerCase();

    const lStat = leadStatsMap.get(uid) || leadStatsMap.get(unameLower) || {};
    const cStat = callStatsMap.get(uid.toLowerCase()) || callStatsMap.get(unameLower) || {};
    const fStat = followupStatsMap.get(unameLower) || followupStatsMap.get(uid.toLowerCase()) || {};

    const totLeads = lStat.totalLeads || 0;
    const convLeads = lStat.convertedLeads || 0;
    const convRate = totLeads > 0 ? Math.round((convLeads / totLeads) * 100) : 0;
    const talkSec = cStat.talkTime || 0;

    performanceList.push({
      repId: uid,
      name: uname,
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
        periodEvaluated: dateRange.label,
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
    periodEvaluated: dateRange.label,
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
};

