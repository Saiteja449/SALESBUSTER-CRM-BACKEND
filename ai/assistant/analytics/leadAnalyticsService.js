import mongoose from "mongoose";
import { resolveSalesperson } from "./salespersonResolver.js";
import { resolveAnalyticsDateRange } from "./dateRangeResolver.js";
import { validateAnalyticsQuery, formatPaginatedResponse } from "./analyticsQueryValidator.js";
import { escapeRegex, wrapUntrustedData } from "../securityUtils.js";
import { getISTDateBoundaries } from "../dateUtils.js";
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
 * Advanced lead search supporting combinations of salesperson, date, activity, status, service, call history, and follow-ups.
 */
export const searchLeadsAdvanced = async ({
  tenantModels = {},
  filters = {},
  pagination = {},
}) => {
  const {
    salespersonNameOrId,
    unassignedOnly = false,
    status,
    source,
    service,
    priority,
    searchTerm,
    period,
    startDate,
    endDate,
    lastActivityPeriod,
    callStatusFilter, // "has_calls", "has_missed_calls", "never_called"
    followupStatusFilter, // "overdue", "pending_today", "no_followup", "has_pending"
    inactiveDays, // not contacted in X days
  } = filters;

  const { page, limit, skip } = validateAnalyticsQuery(pagination);
  const LeadModel = tenantModels.Lead;
  const FollowupModel = tenantModels.Followup;

  if (!canQuery(LeadModel)) {
    return { success: false, error: "Lead model not available" };
  }

  const queryConditions = [];

  // 1. Salesperson filter
  if (unassignedOnly) {
    queryConditions.push({
      $or: [
        { assignedTo: "Unassigned" },
        { assignedTo: null },
        { assignedTo: "" },
        { assignedTo: { $exists: false } },
      ],
    });
  } else if (salespersonNameOrId) {
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
      // Nonexistent salesperson: return 0 results immediately, never organization-wide
      return formatPaginatedResponse({
        totalCount: 0,
        page,
        limit,
        records: [],
        summary: {
          totalMatchingLeads: 0,
          byStatus: {},
          bySalesperson: {},
        },
        filtersApplied: {
          salesperson: salespersonNameOrId,
          salespersonNotFound: true,
        },
        coverage: "complete",
        message: repRes.message || `Salesperson "${salespersonNameOrId}" not found.`,
      });
    }
    if (repRes.leadAssignedFilter) {
      queryConditions.push(repRes.leadAssignedFilter);
    }
  }

  // 2. CreatedAt Date Range
  if (period || startDate || endDate) {
    const dRange = resolveAnalyticsDateRange({ period: period || "all_time", startDate, endDate });
    if (!dRange.isAllTime) {
      queryConditions.push({ createdAt: { $gte: dRange.start, $lte: dRange.end } });
    }
  }

  // 3. Last Activity Date Range
  if (lastActivityPeriod) {
    const actRange = resolveAnalyticsDateRange({ period: lastActivityPeriod });
    if (!actRange.isAllTime) {
      queryConditions.push({ lastActivity: { $gte: actRange.start, $lte: actRange.end } });
    }
  }

  // 4. Inactive for X days (e.g. 7 days without contact)
  if (inactiveDays && parseInt(inactiveDays, 10) > 0) {
    const days = parseInt(inactiveDays, 10);
    const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    queryConditions.push({
      $or: [
        { lastCallAt: { $lt: cutoffDate } },
        { lastCallAt: null, createdAt: { $lt: cutoffDate } },
      ],
    });
  }

  // 5. Standard Lead Attributes
  if (status && status !== "all") {
    queryConditions.push({ status: new RegExp(`^${escapeRegex(status.trim())}$`, "i") });
  }
  if (source && source !== "all") {
    queryConditions.push({ source: new RegExp(`^${escapeRegex(source.trim())}$`, "i") });
  }
  if (service && service !== "all") {
    queryConditions.push({ service: new RegExp(`^${escapeRegex(service.trim())}$`, "i") });
  }
  if (priority && priority !== "all") {
    queryConditions.push({ priority: new RegExp(`^${escapeRegex(priority.trim())}$`, "i") });
  }

  // 6. Multi-field Search Term
  if (searchTerm && searchTerm.trim()) {
    const safeTerm = escapeRegex(searchTerm.trim());
    const digits = searchTerm.replace(/\D/g, "");
    const termOr = [
      { name: { $regex: safeTerm, $options: "i" } },
      { company: { $regex: safeTerm, $options: "i" } },
      { notes: { $regex: safeTerm, $options: "i" } },
      { city: { $regex: safeTerm, $options: "i" } },
      { phone: { $regex: safeTerm, $options: "i" } },
    ];
    if (digits.length >= 7) {
      termOr.push({ phoneNormalized: new RegExp(digits.slice(-10) + "$") });
    }
    queryConditions.push({ $or: termOr });
  }

  // 7. Call status filter
  if (callStatusFilter === "never_called") {
    queryConditions.push({
      $or: [{ callCount: 0 }, { callCount: { $exists: false } }, { callHistory: { $size: 0 } }],
    });
  } else if (callStatusFilter === "has_calls") {
    queryConditions.push({
      $or: [{ callCount: { $gt: 0 } }, { "callHistory.0": { $exists: true } }],
    });
  } else if (callStatusFilter === "has_missed_calls") {
    queryConditions.push({
      $or: [
        { status: "Missed Call" },
        { "callHistory.status": "missed" },
        { "callHistory.callType": "missed" },
      ],
    });
  }

  // 8. Follow-up status filter (if requiring Followup cross-reference)
  if (followupStatusFilter && canQuery(FollowupModel)) {
    const boundaries = getISTDateBoundaries();
    const todayStr = boundaries.todayStr;
    try {
      if (followupStatusFilter === "overdue") {
        const overdueLeadIds = await FollowupModel.distinct("leadId", {
          done: false,
          date: { $lt: todayStr },
        });
        queryConditions.push({ _id: { $in: overdueLeadIds } });
      } else if (followupStatusFilter === "pending_today") {
        const todayLeadIds = await FollowupModel.distinct("leadId", {
          done: false,
          date: todayStr,
        });
        queryConditions.push({ _id: { $in: todayLeadIds } });
      } else if (followupStatusFilter === "has_pending") {
        const pendingLeadIds = await FollowupModel.distinct("leadId", { done: false });
        queryConditions.push({ _id: { $in: pendingLeadIds } });
      } else if (followupStatusFilter === "no_followup") {
        const anyPendingIds = await FollowupModel.distinct("leadId", { done: false });
        queryConditions.push({ _id: { $nin: anyPendingIds } });
      }
    } catch (fuErr) {
      console.warn("[LeadAnalytics] Followup cross-ref error:", fuErr.message);
    }
  }

  const finalMatch = composeMongoQuery(...queryConditions);

  const totalCount = typeof LeadModel.countDocuments === "function"
    ? await LeadModel.countDocuments(finalMatch)
    : 0;

  let queryBuilder = LeadModel.find(finalMatch);
  if (typeof queryBuilder.sort === "function") {
    queryBuilder = queryBuilder.sort({ createdAt: -1 });
  }
  if (skip > 0 && typeof queryBuilder.skip === "function") {
    queryBuilder = queryBuilder.skip(skip);
  }
  if (typeof queryBuilder.limit === "function") {
    queryBuilder = queryBuilder.limit(limit);
  }
  if (typeof queryBuilder.select === "function") {
    queryBuilder = queryBuilder.select("name phone company service status source priority assignedTo dealValue createdAt lastActivity lastCallAt callCount notes");
  }

  const leads = typeof queryBuilder.lean === "function" ? await queryBuilder.lean() : await queryBuilder;

  const formatted = (leads || []).map((l) => ({
    id: l._id ? l._id.toString() : "",
    name: l.name || "Unnamed Customer",
    phone: l.phone,
    company: l.company || undefined,
    service: l.service,
    status: l.status,
    source: l.source,
    priority: l.priority,
    assignedTo: l.assignedTo ? String(l.assignedTo) : "Unassigned",
    dealValue: l.dealValue ? `₹${l.dealValue.toLocaleString("en-IN")}` : undefined,
    callCount: l.callCount || 0,
    lastCallDateIST: l.lastCallAt
      ? new Date(l.lastCallAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })
      : "Never Called",
    createdDateIST: new Date(l.createdAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }),
    notesSnippet: l.notes ? wrapUntrustedData(l.notes.slice(0, 100)) : undefined,
  }));

  return formatPaginatedResponse({
    totalCount,
    page,
    limit,
    records: formatted,
    filtersApplied: {
      salesperson: salespersonNameOrId || (unassignedOnly ? "Unassigned Only" : "All"),
      status: status || "All",
      service: service || "All",
      inactiveDays: inactiveDays ? `${inactiveDays} days` : "None",
      callStatus: callStatusFilter || "All",
    },
  });
};
