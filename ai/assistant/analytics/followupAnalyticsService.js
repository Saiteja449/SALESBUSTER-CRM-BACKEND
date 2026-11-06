import mongoose from "mongoose";
import { resolveSalesperson } from "./salespersonResolver.js";
import { resolveAnalyticsDateRange } from "./dateRangeResolver.js";
import { validateAnalyticsQuery, formatPaginatedResponse } from "./analyticsQueryValidator.js";
import { getISTDateBoundaries } from "../dateUtils.js";
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
 * In-depth follow-up analytics with salesperson filtering, overdue detection, and paginated records
 */
export const getFollowupAnalytics = async ({
  tenantModels = {},
  filters = {},
  pagination = {},
}) => {
  const {
    status = "all_pending", // "all_pending", "overdue", "pending_today", "upcoming", "completed", "missed_call_followups"
    salespersonNameOrId,
    priority,
    period,
    startDate,
    endDate,
  } = filters;

  const { page, limit, skip } = validateAnalyticsQuery(pagination);
  const FollowupModel = tenantModels.Followup;
  const LeadModel = tenantModels.Lead;

  if (!canQuery(FollowupModel)) {
    return { success: false, error: "Followup model not available" };
  }

  const boundaries = getISTDateBoundaries();
  const todayStr = boundaries.todayStr;

  // 1. Resolve Salesperson if provided
  let repResolution = null;
  let repLeadIds = null;
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
          totalFollowups: 0,
          overdueCount: 0,
          todayCount: 0,
          upcomingCount: 0,
          completedCount: 0,
        },
        filtersApplied: {
          salesperson: salespersonNameOrId,
          salespersonNotFound: true,
        },
        coverage: "complete",
        message: repResolution.message || `Salesperson "${salespersonNameOrId}" not found.`,
      });
    }

    if (canQuery(LeadModel) && repResolution.leadAssignedFilter) {
      repLeadIds = await LeadModel.distinct("_id", repResolution.leadAssignedFilter);
    }
  }

  // 2. Build Base Query for Counts & Filtering safely
  const baseClauses = [];

  if (priority && priority !== "all") {
    baseClauses.push({ priority });
  }

  if (repLeadIds && repLeadIds.length > 0) {
    baseClauses.push({ leadId: { $in: repLeadIds } });
  } else if (repLeadIds && repLeadIds.length === 0) {
    // Salesperson has 0 leads, so 0 followups
    return formatPaginatedResponse({
      totalCount: 0,
      page,
      limit,
      records: [],
      summary: {
        totalFollowups: 0,
        overdueCount: 0,
        todayCount: 0,
        upcomingCount: 0,
        completedCount: 0,
      },
      filtersApplied: {
        salesperson: repResolution?.canonicalName || salespersonNameOrId,
      },
      coverage: "complete",
    });
  }

  if (period || startDate || endDate) {
    const dRange = resolveAnalyticsDateRange({ period: period || "all_time", startDate, endDate });
    if (!dRange.isAllTime) {
      baseClauses.push({ date: { $gte: dRange.startStr, $lte: dRange.endStr } });
    }
  }

  const baseMatch = composeMongoQuery(...baseClauses);

  // 3. Facet count aggregation
  const [counts] = await FollowupModel.aggregate([
    {
      $facet: {
        overdueCount: [
          { $match: composeMongoQuery(baseMatch, { done: false, date: { $lt: todayStr } }) },
          { $count: "c" },
        ],
        todayCount: [
          { $match: composeMongoQuery(baseMatch, { done: false, date: todayStr }) },
          { $count: "c" },
        ],
        upcomingCount: [
          { $match: composeMongoQuery(baseMatch, { done: false, date: { $gt: todayStr } }) },
          { $count: "c" },
        ],
        completedCount: [
          { $match: composeMongoQuery(baseMatch, { done: true }) },
          { $count: "c" },
        ],
        byPriority: [
          { $match: composeMongoQuery(baseMatch, { done: false }) },
          { $group: { _id: { $ifNull: ["$priority", "Medium"] }, count: { $sum: 1 } } },
        ],
      },
    },
  ]);

  const overdueTotal = counts?.overdueCount[0]?.c || 0;
  const todayTotal = counts?.todayCount[0]?.c || 0;
  const upcomingTotal = counts?.upcomingCount[0]?.c || 0;
  const completedTotal = counts?.completedCount[0]?.c || 0;
  const allPendingTotal = overdueTotal + todayTotal + upcomingTotal;

  // 4. Status Filter for Specific Records
  const listClauses = [baseMatch];
  if (status === "overdue") {
    listClauses.push({ done: false, date: { $lt: todayStr } });
  } else if (status === "pending_today") {
    listClauses.push({ done: false, date: todayStr });
  } else if (status === "upcoming") {
    listClauses.push({ done: false, date: { $gt: todayStr } });
  } else if (status === "completed") {
    listClauses.push({ done: true });
  } else if (status === "all_pending") {
    listClauses.push({ done: false });
  } else if (status === "missed_call_followups") {
    listClauses.push({ notes: { $regex: /missed call/i } });
  }

  const listMatch = composeMongoQuery(...listClauses);

  const totalMatching = typeof FollowupModel.countDocuments === "function"
    ? await FollowupModel.countDocuments(listMatch)
    : 0;
  let fq = FollowupModel.find(listMatch);
  if (typeof fq.sort === "function") fq = fq.sort({ date: 1, time: 1 });
  if (skip > 0 && typeof fq.skip === "function") fq = fq.skip(skip);
  if (typeof fq.limit === "function") fq = fq.limit(limit);
  const rawFollowups = typeof fq.lean === "function" ? await fq.lean() : await fq;

  // Populate Lead Details
  const leadIds = (rawFollowups || []).map((f) => f.leadId).filter(Boolean);
  const leadMap = new Map();
  if (canQuery(LeadModel) && leadIds.length > 0) {
    try {
      const leads = await LeadModel.find({ _id: { $in: leadIds } })
        .select("name phone service status assignedTo")
        .lean();
      for (const l of leads || []) {
        leadMap.set(l._id.toString(), l);
      }
    } catch (_) {}
  }

  const formattedRecords = (rawFollowups || []).map((fu) => {
    const l = fu.leadId ? leadMap.get(fu.leadId.toString()) : null;
    let urgency = "Normal";
    if (!fu.done) {
      if (fu.date < todayStr) urgency = "Overdue";
      else if (fu.date === todayStr) urgency = "Due Today";
      else urgency = "Upcoming";
    } else {
      urgency = "Completed";
    }

    return {
      followupId: fu._id ? fu._id.toString() : "",
      leadId: fu.leadId ? fu.leadId.toString() : "",
      customerName: l?.name || "Customer",
      customerPhone: l?.phone || "Unknown",
      service: l?.service,
      leadStatus: l?.status,
      assignedRep: l?.assignedTo ? String(l.assignedTo) : "Unassigned",
      scheduledDateIST: fu.date,
      scheduledTimeIST: fu.time || "Not specified",
      priority: fu.priority || "Medium",
      urgency,
      completed: Boolean(fu.done),
      notesSnippet: fu.notes ? wrapUntrustedData(fu.notes.slice(0, 120)) : "No notes",
    };
  });

  const summary = {
    evaluatedForSalesperson: repResolution?.canonicalName || "All Sales Representatives",
    totalMatchingFollowups: totalMatching,
    allPendingFollowups: allPendingTotal,
    overdueCount: overdueTotal,
    pendingTodayCount: todayTotal,
    upcomingCount: upcomingTotal,
    completedCount: completedTotal,
    priorityBreakdown: (counts?.byPriority || []).reduce((acc, curr) => {
      acc[curr._id] = curr.count;
      return acc;
    }, {}),
  };

  return formatPaginatedResponse({
    totalCount: totalMatching,
    page,
    limit,
    records: formattedRecords,
    summary,
    filtersApplied: {
      salesperson: repResolution?.canonicalName || "All Salespeople",
      statusFilter: status,
      priority: priority || "All",
    },
  });
};
