import mongoose from "mongoose";
import { resolveSalesperson, listAllSalespeople } from "./salespersonResolver.js";
import { resolveAnalyticsDateRange } from "./dateRangeResolver.js";
import { validateAnalyticsQuery, formatPaginatedResponse } from "./analyticsQueryValidator.js";
import { formatDuration } from "../dateUtils.js";
import { composeMongoQuery } from "./queryComposer.js";
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
 * Call Recording & AI Speech Analysis tracking
 */
export const getRecordingAnalytics = async ({
  tenantModels = {},
  filters = {},
  pagination = {},
}) => {
  const {
    salespersonNameOrId,
    period = "all_time",
    startDate,
    endDate,
    analysisStatus, // "completed", "pending", "failed", "all"
    missingRecordingsOnly = false,
  } = filters;

  const { page, limit, skip } = validateAnalyticsQuery(pagination);
  const LeadModel = tenantModels.Lead;
  const CallRecordModel = tenantModels.CallRecord;

  if (!canQuery(LeadModel)) {
    return formatPaginatedResponse({
      success: false,
      coverage: "unavailable",
      errorCode: "LEAD_MODEL_UNAVAILABLE",
      message: "Lead model is not available in tenant database.",
      page,
      limit,
      totalCount: 0,
      records: [],
      filtersApplied: {
        period: dateRange.label,
        salesperson: salespersonNameOrId,
      },
    });
  }

  const dateRange = resolveAnalyticsDateRange({ period, startDate, endDate });

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
          totalRecordingsFound: 0,
          totalAnalyzed: 0,
          totalPending: 0,
          totalFailed: 0,
          salespersonBreakdown: {},
        },
        filtersApplied: {
          salesperson: salespersonNameOrId,
          salespersonNotFound: true,
          period: dateRange.label,
        },
        coverage: "complete",
        message: repResolution.message || `Salesperson "${salespersonNameOrId}" not found.`,
      });
    }
  }

  const allRecordings = [];

  // Extract from Lead.recordings safely
  const leadClauses = [{ "recordings.0": { $exists: true } }];
  if (repResolution?.leadAssignedFilter) {
    leadClauses.push(repResolution.leadAssignedFilter);
  }

  const leadMatch = composeMongoQuery(...leadClauses);

  const leadsWithRecordings = await LeadModel.find(leadMatch)
    .select("name company phone status assignedTo recordings")
    .lean();

  const ownerDir = await buildOwnerDirectory({ tenantModels });

  for (const lead of leadsWithRecordings || []) {
    for (const rec of lead.recordings || []) {
      const upDate = rec.uploadedAt ? new Date(rec.uploadedAt) : (lead.createdAt ? new Date(lead.createdAt) : new Date(0));
      if (!dateRange.isAllTime && (upDate < dateRange.start || upDate > dateRange.end)) {
        continue;
      }

      const owner = ownerDir.resolveOwner(rec.salespersonId || rec.salespersonName || lead.assignedTo);
      const aStatus = rec.analysisStatus || "pending";

      if (analysisStatus && analysisStatus !== "all" && aStatus !== analysisStatus) {
        continue;
      }

      const displayName = (lead.name && lead.name.trim()) || (lead.company && lead.company.trim()) || lead.phone || "Customer";

      allRecordings.push({
        leadId: lead._id ? lead._id.toString() : "",
        displayName,
        customerName: (lead.name && lead.name.trim()) || displayName,
        customerPhone: lead.phone,
        salesperson: owner.name,
        salespersonName: owner.name,
        salespersonId: owner.id || undefined,
        recordingName: rec.name || "Call Recording",
        recordingUrl: rec.url,
        duration: formatDuration(rec.duration || 0),
        rawDuration: rec.duration || 0,
        uploadedDateIST: upDate.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }),
        analysisStatus: aStatus,
        summarySnippet: rec.aiAnalysis?.summary ? rec.aiAnalysis.summary.slice(0, 150) : "No AI analysis",
        dealIntentScore: rec.aiAnalysis?.sentimentScore || rec.aiAnalysis?.interestLevel || "N/A",
      });
    }
  }

  // Extract recordings from CallRecord collection where recordingUrl exists
  if (!missingRecordingsOnly && canQuery(CallRecordModel)) {
    const crClauses = [
      { recordingUrl: { $exists: true, $ne: null } },
    ];
    if (!dateRange.isAllTime) {
      crClauses.push({ calledAt: { $gte: dateRange.start, $lte: dateRange.end } });
    }
    if (repResolution?.callSalespersonFilter) {
      crClauses.push(repResolution.callSalespersonFilter);
    }
    const crMatch = composeMongoQuery(...crClauses);
    try {
      const crWithRecordings = await CallRecordModel.find(crMatch)
        .sort({ calledAt: -1 })
        .limit(300)
        .lean();

      for (const cr of crWithRecordings || []) {
        const recUrl = cr.recordingUrl;
        if (recUrl && allRecordings.some((r) => r.recordingUrl === recUrl)) {
          continue;
        }

        const calledDate = cr.calledAt ? new Date(cr.calledAt) : new Date(0);
        const owner = ownerDir.resolveOwner(cr.salespersonId || cr.salespersonName);
        const displayName = (cr.customerName && cr.customerName.trim()) || cr.customerPhone || "Customer";

        allRecordings.push({
          leadId: cr.leadId ? cr.leadId.toString() : "",
          displayName,
          customerName: (cr.customerName && cr.customerName.trim()) || displayName,
          customerPhone: cr.customerPhone || "Unknown",
          salesperson: owner.name,
          salespersonName: owner.name,
          salespersonId: owner.id || undefined,
          recordingName: cr.callEventId ? `Call Recording (${cr.callEventId})` : "Call Recording",
          recordingUrl: recUrl,
          duration: formatDuration(cr.duration || 0),
          rawDuration: cr.duration || 0,
          uploadedDateIST: calledDate.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }),
          analysisStatus: "completed",
          summarySnippet: "Connected call audio recording.",
          dealIntentScore: "N/A",
        });
      }
    } catch (_) {}
  }

  // Missing recordings on connected calls (if requested)
  if (missingRecordingsOnly && canQuery(CallRecordModel)) {
    const missingClauses = [
      { callStatus: "connected" },
      { duration: { $gt: 15 } },
      { $or: [{ recordingUrl: null }, { recordingUrl: { $exists: false } }] },
    ];
    if (!dateRange.isAllTime) {
      missingClauses.push({ calledAt: { $gte: dateRange.start, $lte: dateRange.end } });
    }
    if (repResolution?.callSalespersonFilter) {
      missingClauses.push(repResolution.callSalespersonFilter);
    }

    const missingMatch = composeMongoQuery(...missingClauses);

    const callsWithoutRecording = await CallRecordModel.find(missingMatch)
      .sort({ calledAt: -1 })
      .limit(100)
      .lean();

    const missingItems = (callsWithoutRecording || []).map((c) => {
      const owner = ownerDir.resolveOwner(c.salespersonId || c.salespersonName);
      const displayName = (c.customerName && c.customerName.trim()) || c.customerPhone || "Customer";
      return {
        leadId: c.leadId ? c.leadId.toString() : "",
        displayName,
        customerName: (c.customerName && c.customerName.trim()) || displayName,
        customerPhone: c.customerPhone,
        salesperson: owner.name,
        salespersonName: owner.name,
        salespersonId: owner.id || undefined,
        recordingName: "MISSING_RECORDING",
        recordingUrl: undefined,
        duration: formatDuration(c.duration || 0),
        rawDuration: c.duration || 0,
        uploadedDateIST: new Date(c.calledAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }),
        analysisStatus: "unrecorded",
        summarySnippet: "Connected call exceeding 15 seconds without an attached recording.",
        dealIntentScore: "N/A",
      };
    });

    allRecordings.push(...missingItems);
  }

  // Summary calculated on the EXACT filtered population
  const repCounts = {};
  let totalAnalyzed = 0;
  let totalPending = 0;
  let totalFailed = 0;

  for (const r of allRecordings) {
    repCounts[r.salesperson] = (repCounts[r.salesperson] || 0) + 1;
    if (r.analysisStatus === "completed") totalAnalyzed++;
    else if (r.analysisStatus === "failed") totalFailed++;
    else if (r.analysisStatus === "pending") totalPending++;
  }

  allRecordings.sort((a, b) => b.rawDuration - a.rawDuration);
  const pagedRecords = allRecordings.slice(skip, skip + limit);

  const summary = {
    periodEvaluated: dateRange.label,
    salespersonEvaluated: repResolution?.canonicalName || "All Sales Representatives",
    totalRecordingsFound: allRecordings.length,
    totalAnalyzed,
    totalPending,
    totalFailed,
    salespersonBreakdown: repCounts,
  };

  return formatPaginatedResponse({
    totalCount: allRecordings.length,
    page,
    limit,
    records: pagedRecords,
    summary,
    filtersApplied: {
      salesperson: repResolution?.canonicalName || "All Salespeople",
      analysisStatus: analysisStatus || "All",
      missingRecordingsOnly,
      period: dateRange.label,
    },
  });
};
