import mongoose from "mongoose";
import { resolveSalesperson } from "./salespersonResolver.js";
import { resolveAnalyticsDateRange } from "./dateRangeResolver.js";
import { validateAnalyticsQuery, formatPaginatedResponse } from "./analyticsQueryValidator.js";
import { formatDuration, getISTDateBoundaries, getISTDateString } from "../dateUtils.js";
import { escapeRegex } from "../securityUtils.js";
import { composeMongoQuery } from "./queryComposer.js";

const canQuery = (model) => {
  if (!model) return false;
  if (model.prototype instanceof mongoose.Model || model.schema) {
    const readyState = model.db?.readyState ?? mongoose.connection?.readyState;
    return readyState === 1;
  }
  return true;
};

const matchesSalesperson = (repRes, repId, repName) => {
  if (!repRes || repRes.all) return true;
  if (repRes.isUnassigned) {
    return !repId || repName === "Unassigned" || repName === "" || !repName;
  }
  const idMatch = repRes.canonicalId && String(repId) === repRes.canonicalId;
  const nameMatch = repRes.canonicalName && (
    (repName && repName.toLowerCase() === repRes.canonicalName.toLowerCase()) ||
    (repId && String(repId).toLowerCase() === repRes.canonicalName.toLowerCase())
  );
  return Boolean(idMatch || nameMatch);
};

const matchesCustomerPhone = (filterPhone, recordPhone) => {
  if (!filterPhone) return true;
  const digits = String(filterPhone).replace(/\D/g, "");
  const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
  const pDigits = String(recordPhone || "").replace(/\D/g, "");
  return pDigits.endsWith(last10);
};

/**
 * Searches call records with multi-dimensional filtering across CallRecord and Lead.callHistory.
 * Safe query composition, deduplication, and partial failure detection.
 */
export const searchCallRecords = async ({
  tenantModels = {},
  filters = {},
  pagination = {},
}) => {
  const {
    salespersonNameOrId,
    customerPhone,
    customerName,
    callType,
    callStatus,
    period = "all_time",
    startDate,
    endDate,
    leadId,
    recordingAvailable,
    source,
  } = filters;

  const { page, limit, skip } = validateAnalyticsQuery(pagination);
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
          totalCalls: 0,
          totalDuration: 0,
          formattedTotalDuration: "0s",
          uniqueCustomers: 0,
          byType: {},
          byStatus: {},
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

  const CallRecordModel = tenantModels.CallRecord;
  const LeadModel = tenantModels.Lead;

  // Build filter clauses safely
  const crClauses = [];
  const leadClauses = [];

  // Date boundary
  if (!dateRange.isAllTime) {
    crClauses.push({ calledAt: { $gte: dateRange.start, $lte: dateRange.end } });
  }

  // Salesperson filter
  if (repResolution?.callSalespersonFilter) {
    crClauses.push(repResolution.callSalespersonFilter);
  }
  if (repResolution?.leadAssignedFilter) {
    leadClauses.push(repResolution.leadAssignedFilter);
  }

  // Call type & status
  if (callType && callType !== "all") {
    crClauses.push({ callType: callType.toLowerCase().trim() });
  }
  if (callStatus && callStatus !== "all") {
    crClauses.push({ callStatus: callStatus.toLowerCase().trim() });
  }

  // Customer phone / name
  if (customerPhone) {
    const digits = String(customerPhone).replace(/\D/g, "");
    const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
    const phoneRegex = new RegExp(escapeRegex(last10) + "$");
    crClauses.push({ customerPhone: phoneRegex });
    leadClauses.push({ phone: phoneRegex });
  }
  if (customerName) {
    const nameRegex = new RegExp(escapeRegex(customerName.trim()), "i");
    crClauses.push({ customerName: nameRegex });
    leadClauses.push({ name: nameRegex });
  }

  // Lead ID
  if (leadId && mongoose.Types.ObjectId.isValid(leadId)) {
    const lidObj = new mongoose.Types.ObjectId(leadId);
    crClauses.push({ leadId: lidObj });
    leadClauses.push({ _id: lidObj });
  }

  // Recording availability
  if (recordingAvailable === true) {
    crClauses.push({ recordingUrl: { $exists: true, $ne: null } });
  } else if (recordingAvailable === false) {
    crClauses.push({ $or: [{ recordingUrl: null }, { recordingUrl: { $exists: false } }] });
  }

  // Source
  if (source) {
    crClauses.push({ source: new RegExp(`^${escapeRegex(source.trim())}$`, "i") });
  }

  const callRecordMatch = composeMongoQuery(...crClauses);
  const coverageWarnings = [];
  let isPartialCoverage = false;

  const deduplicatedCalls = new Map();
  const seenCallEventIds = new Set();

  // Query CallRecord collection
  let callRecordSuccess = false;
  if (canQuery(CallRecordModel)) {
    try {
      let q = CallRecordModel.find(callRecordMatch);
      if (typeof q.sort === "function") q = q.sort({ calledAt: -1 });
      if (typeof q.limit === "function") q = q.limit(500); // bounded safe retrieval
      const records = typeof q.lean === "function" ? await q.lean() : await q;
      for (const rec of records || []) {
        if (!matchesSalesperson(repResolution, rec.salespersonId, rec.salespersonName)) continue;
        if (!matchesCustomerPhone(customerPhone, rec.customerPhone)) continue;
        const eventId = rec.callEventId || `cr_${rec._id}`;
        seenCallEventIds.add(eventId);
        deduplicatedCalls.set(eventId, {
          callEventId: rec.callEventId || eventId,
          leadId: rec.leadId,
          salespersonId: rec.salespersonId,
          salespersonName: rec.salespersonName || "Unassigned",
          customerName: rec.customerName,
          customerPhone: rec.customerPhone,
          callType: rec.callType,
          callStatus: rec.callStatus,
          duration: rec.duration || 0,
          calledAt: rec.calledAt,
          recordingUrl: rec.recordingUrl || null,
          source: rec.source || "Call",
        });
      }
      callRecordSuccess = true;
    } catch (err) {
      isPartialCoverage = true;
      coverageWarnings.push(`CallRecord query error: ${err.message}`);
      console.warn("[CallAnalytics] CallRecord query error:", err.message);
    }
  }

  // Query Lead.callHistory fallback & complement
  let leadQuerySuccess = false;
  if (canQuery(LeadModel)) {
    try {
      const leadMatch = composeMongoQuery(...leadClauses, { "callHistory.0": { $exists: true } });
      let lq = LeadModel.find(leadMatch);
      if (typeof lq.select === "function") lq = lq.select("name phone status assignedTo callHistory createdAt");
      if (typeof lq.limit === "function") lq = lq.limit(200);
      const leadsWithCalls = typeof lq.lean === "function" ? await lq.lean() : await lq;

      for (const lead of leadsWithCalls || []) {
        for (const ch of lead.callHistory || []) {
          const calledAtDate = ch.calledAt ? new Date(ch.calledAt) : new Date(lead.createdAt);
          if (!dateRange.isAllTime && (calledAtDate < dateRange.start || calledAtDate > dateRange.end)) {
            continue;
          }
          const repId = ch.salespersonId || lead.assignedTo;
          const repName = ch.salespersonName || (lead.assignedTo ? String(lead.assignedTo) : "Unassigned");
          if (!matchesSalesperson(repResolution, repId, repName)) continue;
          if (!matchesCustomerPhone(customerPhone, lead.phone)) continue;
          if (callType && callType !== "all" && ch.callType?.toLowerCase() !== callType.toLowerCase()) {
            continue;
          }
          if (callStatus && callStatus !== "all" && ch.status?.toLowerCase() !== callStatus.toLowerCase()) {
            continue;
          }
          if (recordingAvailable === true && !ch.recordingUrl) continue;
          if (recordingAvailable === false && ch.recordingUrl) continue;

          // Stable deduplication key
          const eventId = ch.callEventId || `lead_${lead._id}_${calledAtDate.getTime()}`;
          if (seenCallEventIds.has(eventId)) continue;

          // Check if an identical call from the same lead was already registered
          const compositeKey = `${lead._id}_${calledAtDate.getTime()}`;
          let alreadySeen = false;
          for (const existing of deduplicatedCalls.values()) {
            if (
              existing.leadId &&
              existing.leadId.toString() === lead._id.toString() &&
              Math.abs(new Date(existing.calledAt).getTime() - calledAtDate.getTime()) < 3000
            ) {
              alreadySeen = true;
              break;
            }
          }
          if (alreadySeen) continue;

          seenCallEventIds.add(eventId);
          deduplicatedCalls.set(eventId, {
            callEventId: ch.callEventId || eventId,
            leadId: lead._id,
            salespersonId: ch.salespersonId || lead.assignedTo,
            salespersonName: ch.salespersonName || (lead.assignedTo ? String(lead.assignedTo) : "Unassigned"),
            customerName: lead.name,
            customerPhone: lead.phone,
            callType: ch.callType || "outgoing",
            callStatus: ch.status || "connected",
            duration: ch.duration || 0,
            calledAt: calledAtDate,
            recordingUrl: ch.recordingUrl || null,
            source: "Call",
          });
        }
      }
      leadQuerySuccess = true;
    } catch (fallbackErr) {
      isPartialCoverage = true;
      coverageWarnings.push(`Lead query error: ${fallbackErr.message}`);
      console.warn("[CallAnalytics] Fallback query error:", fallbackErr.message);
    }
  }

  if (!callRecordSuccess && !leadQuerySuccess && (canQuery(CallRecordModel) || canQuery(LeadModel))) {
    return {
      success: false,
      error_code: "DATABASE_UNAVAILABLE",
      message: "Unable to retrieve call records from database.",
      details: coverageWarnings,
    };
  }

  const allCalls = Array.from(deduplicatedCalls.values());
  allCalls.sort((a, b) => new Date(b.calledAt) - new Date(a.calledAt));

  const totalCount = allCalls.length;
  const pagedCalls = allCalls.slice(skip, skip + limit);

  // Populate associated Lead status and Followup info
  const leadIds = pagedCalls.map((r) => r.leadId).filter(Boolean);
  const leadInfoMap = new Map();
  if (canQuery(LeadModel) && leadIds.length > 0) {
    try {
      const leadDocs = await LeadModel.find({ _id: { $in: leadIds } })
        .select("name phone status assignedTo nextFollowUp followupTime")
        .lean();
      for (const ld of leadDocs) {
        leadInfoMap.set(ld._id.toString(), ld);
      }
    } catch (_) {}
  }

  const formattedRecords = pagedCalls.map((rec) => {
    const lInfo = rec.leadId ? leadInfoMap.get(rec.leadId.toString()) : null;
    return {
      callEventId: rec.callEventId || undefined,
      customerName: rec.customerName || lInfo?.name || "Unknown Customer",
      customerPhone: rec.customerPhone || lInfo?.phone || "Unknown",
      salesperson: rec.salespersonName || (lInfo?.assignedTo ? String(lInfo.assignedTo) : "Unassigned"),
      callDateIST: rec.calledAt
        ? new Date(rec.calledAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })
        : "Unknown Date",
      callTimeIST: rec.calledAt
        ? new Date(rec.calledAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" })
        : "Unknown Time",
      callType: rec.callType,
      callStatus: rec.callStatus,
      duration: formatDuration(rec.duration || 0),
      rawDurationSeconds: rec.duration || 0,
      leadStatus: lInfo?.status || "Unknown",
      recordingAvailable: Boolean(rec.recordingUrl),
      recordingUrl: rec.recordingUrl || undefined,
      source: rec.source || "Call",
    };
  });

  // Calculate summary on the EXACT matching population
  const uniquePhones = new Set();
  const byType = {};
  const byStatus = {};
  const repCounts = {};
  let totalDurationSec = 0;

  for (const c of allCalls) {
    if (c.customerPhone) uniquePhones.add(c.customerPhone);
    const t = c.callType || "unknown";
    byType[t] = (byType[t] || 0) + 1;
    const s = c.callStatus || "unknown";
    byStatus[s] = (byStatus[s] || 0) + 1;
    const rep = c.salespersonName || "Unassigned";
    repCounts[rep] = (repCounts[rep] || 0) + 1;
    totalDurationSec += c.duration || 0;
  }

  const summary = {
    totalCalls: totalCount,
    totalDurationSeconds: totalDurationSec,
    formattedTotalDuration: formatDuration(totalDurationSec),
    uniqueCustomers: uniquePhones.size,
    byType,
    byStatus,
    salespersonBreakdown: repCounts,
  };

  return formatPaginatedResponse({
    totalCount,
    page,
    limit,
    records: formattedRecords,
    summary,
    coverage: isPartialCoverage ? "partial" : "complete",
    message: coverageWarnings.length > 0 ? coverageWarnings.join("; ") : "",
    filtersApplied: {
      period: dateRange.label,
      salesperson: repResolution?.canonicalName || "All Salespeople",
      callType: callType || "All",
      callStatus: callStatus || "All",
    },
  });
};

/**
 * Calculates in-depth Missed Call analytics, salesperson breakdowns, and follow-up coverage.
 * Accurately merges CallRecord and Lead.callHistory, prevents $or collisions,
 * and calculates all summary stats against the exact filtered population.
 */
export const getMissedCallAnalytics = async ({
  tenantModels = {},
  filters = {},
  pagination = {},
}) => {
  const {
    salespersonNameOrId,
    period = "all_time",
    startDate,
    endDate,
    customerPhone,
    followupStatus, // "all", "pending", "overdue", "completed", "none"
    leadStatus,
  } = filters;

  const { page, limit, skip } = validateAnalyticsQuery(pagination);
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
          totalMatchingMissedCalls: 0,
          uniqueCustomers: 0,
          unassignedMissedCalls: 0,
          pendingFollowups: 0,
          overdueFollowups: 0,
          completedFollowups: 0,
          noFollowupRecords: 0,
          salespersonBreakdown: {},
          dateBreakdown: {},
          leadStatusBreakdown: {},
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

  const CallRecordModel = tenantModels.CallRecord;
  const LeadModel = tenantModels.Lead;
  const FollowupModel = tenantModels.Followup;

  const boundaries = getISTDateBoundaries();
  const todayStr = boundaries.todayStr;

  // Compose CallRecord match query safely
  const crClauses = [
    { $or: [{ callStatus: "missed" }, { callType: "missed" }] },
  ];
  if (!dateRange.isAllTime) {
    crClauses.push({ calledAt: { $gte: dateRange.start, $lte: dateRange.end } });
  }
  if (repResolution?.callSalespersonFilter) {
    crClauses.push(repResolution.callSalespersonFilter);
  }
  if (customerPhone) {
    const digits = String(customerPhone).replace(/\D/g, "");
    const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
    crClauses.push({ customerPhone: new RegExp(escapeRegex(last10) + "$") });
  }

  const missedMatch = composeMongoQuery(...crClauses);

  const deduplicatedCalls = new Map();
  const seenCallEventIds = new Set();
  const coverageWarnings = [];
  let isPartialCoverage = false;

  // 2a. Query CallRecordModel
  let callRecordQueried = false;
  if (canQuery(CallRecordModel)) {
    try {
      let q = CallRecordModel.find(missedMatch);
      if (typeof q.sort === "function") q = q.sort({ calledAt: -1 });
      if (typeof q.limit === "function") q = q.limit(1000); // bounded retrieval
      const crRecords = typeof q.lean === "function" ? await q.lean() : await q;
      for (const rec of crRecords || []) {
        if (!matchesSalesperson(repResolution, rec.salespersonId, rec.salespersonName)) continue;
        if (!matchesCustomerPhone(customerPhone, rec.customerPhone)) continue;
        const eventId = rec.callEventId || `cr_${rec._id}`;
        seenCallEventIds.add(eventId);
        deduplicatedCalls.set(eventId, {
          callEventId: rec.callEventId || eventId,
          leadId: rec.leadId,
          salespersonId: rec.salespersonId,
          salespersonName: rec.salespersonName || "Unassigned",
          customerName: rec.customerName,
          customerPhone: rec.customerPhone,
          callType: "missed",
          callStatus: "missed",
          calledAt: rec.calledAt,
          leadStatus: null, // enriched later
        });
      }
      callRecordQueried = true;
    } catch (err) {
      isPartialCoverage = true;
      coverageWarnings.push(`CallRecord query error: ${err.message}`);
      console.warn("[MissedCallAnalytics] CallRecord query error:", err.message);
    }
  }

  // 2b. Query LeadModel callHistory & missed calls
  let leadQueried = false;
  if (canQuery(LeadModel)) {
    try {
      const leadClauses = [
        {
          $or: [
            { status: "Missed Call" },
            { "callHistory.status": "missed" },
            { "callHistory.callType": "missed" },
          ],
        },
      ];
      if (repResolution?.leadAssignedFilter) {
        leadClauses.push(repResolution.leadAssignedFilter);
      }
      if (customerPhone) {
        const digits = String(customerPhone).replace(/\D/g, "");
        const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
        leadClauses.push({ phone: new RegExp(escapeRegex(last10) + "$") });
      }

      const leadMatch = composeMongoQuery(...leadClauses);
      let lq = LeadModel.find(leadMatch);
      if (typeof lq.select === "function") lq = lq.select("name phone status assignedTo createdAt callHistory");
      if (typeof lq.limit === "function") lq = lq.limit(500);
      const matchingLeads = typeof lq.lean === "function" ? await lq.lean() : await lq;

      for (const ld of matchingLeads || []) {
        const missedEntries = (ld.callHistory || []).filter(
          (c) => c.status === "missed" || c.callType === "missed"
        );

        if (missedEntries.length > 0) {
          for (const me of missedEntries) {
            const cDate = me.calledAt ? new Date(me.calledAt) : new Date(ld.createdAt);
            if (!dateRange.isAllTime && (cDate < dateRange.start || cDate > dateRange.end)) continue;
            const repId = me.salespersonId || ld.assignedTo;
            const repName = me.salespersonName || (ld.assignedTo ? String(ld.assignedTo) : "Unassigned");
            if (!matchesSalesperson(repResolution, repId, repName)) continue;
            if (!matchesCustomerPhone(customerPhone, ld.phone)) continue;

            const eventId = me.callEventId || (me._id ? `lead_call_${me._id}` : `lead_${ld._id}_${cDate.getTime()}_missed`);
            if (seenCallEventIds.has(eventId)) continue;

            // Check if call already recorded from CallRecord for same lead & timestamp
            let alreadySeen = false;
            for (const existing of deduplicatedCalls.values()) {
              if (
                existing.leadId &&
                existing.leadId.toString() === ld._id.toString() &&
                Math.abs(new Date(existing.calledAt).getTime() - cDate.getTime()) < 3000
              ) {
                alreadySeen = true;
                break;
              }
            }
            if (alreadySeen) continue;

            seenCallEventIds.add(eventId);
            deduplicatedCalls.set(eventId, {
              callEventId: me.callEventId || eventId,
              leadId: ld._id,
              salespersonId: repId,
              salespersonName: repName,
              customerName: ld.name,
              customerPhone: ld.phone,
              callType: "missed",
              callStatus: "missed",
              calledAt: cDate,
              leadStatus: ld.status,
            });
          }
        } else if (ld.status === "Missed Call") {
          const cDate = new Date(ld.createdAt);
          if (dateRange.isAllTime || (cDate >= dateRange.start && cDate <= dateRange.end)) {
            const repId = ld.assignedTo;
            const repName = ld.assignedTo ? String(ld.assignedTo) : "Unassigned";
            if (!matchesSalesperson(repResolution, repId, repName)) continue;
            if (!matchesCustomerPhone(customerPhone, ld.phone)) continue;
            const eventId = `lead_missed_${ld._id}`;
            if (!seenCallEventIds.has(eventId)) {
              seenCallEventIds.add(eventId);
              deduplicatedCalls.set(eventId, {
                callEventId: eventId,
                leadId: ld._id,
                salespersonId: ld.assignedTo,
                salespersonName: ld.assignedTo ? String(ld.assignedTo) : "Unassigned",
                customerName: ld.name,
                customerPhone: ld.phone,
                callType: "missed",
                callStatus: "missed",
                calledAt: cDate,
                leadStatus: ld.status,
              });
            }
          }
        }
      }
      leadQueried = true;
    } catch (fbErr) {
      isPartialCoverage = true;
      coverageWarnings.push(`Lead query error: ${fbErr.message}`);
      console.warn("[MissedCallAnalytics] Fallback query error:", fbErr.message);
    }
  }

  if (!callRecordQueried && !leadQueried && (canQuery(CallRecordModel) || canQuery(LeadModel))) {
    return {
      success: false,
      error_code: "DATABASE_UNAVAILABLE",
      message: "Unable to retrieve missed calls from database.",
      details: coverageWarnings,
    };
  }

  const allMissedCalls = Array.from(deduplicatedCalls.values());

  // Cross-reference Leads & Follow-ups
  const leadIdList = allMissedCalls.map((c) => c.leadId).filter(Boolean);
  const leadDocMap = new Map();
  const followupMap = new Map();

  if (canQuery(LeadModel) && leadIdList.length > 0) {
    try {
      const leads = await LeadModel.find({ _id: { $in: leadIdList } })
        .select("name phone status assignedTo nextFollowUp")
        .lean();
      for (const l of leads || []) {
        leadDocMap.set(l._id.toString(), l);
      }
    } catch (_) {}
  }

  if (canQuery(FollowupModel) && leadIdList.length > 0) {
    try {
      const followups = await FollowupModel.find({ leadId: { $in: leadIdList } })
        .sort({ date: -1, createdAt: -1 })
        .lean();
      for (const fu of followups || []) {
        const lid = fu.leadId.toString();
        if (!followupMap.has(lid)) {
          followupMap.set(lid, []);
        }
        followupMap.get(lid).push(fu);
      }
    } catch (_) {}
  }

  // Filter and enrich
  const filteredCalls = [];

  for (const call of allMissedCalls) {
    const leadDoc = call.leadId ? leadDocMap.get(call.leadId.toString()) : null;
    const curLeadStatus = leadDoc?.status || call.leadStatus || "Unknown";

    // Follow-up evaluation
    const fus = call.leadId ? followupMap.get(call.leadId.toString()) || [] : [];
    let fuStatus = "No Follow-up Scheduled";
    let fuCategory = "no_followup";

    if (fus.length > 0) {
      const completed = fus.some((f) => f.done);
      const pendingOverdue = fus.some((f) => !f.done && f.date < todayStr);
      const pendingActive = fus.some((f) => !f.done && f.date >= todayStr);

      if (completed) {
        fuStatus = "Successfully Followed Up";
        fuCategory = "completed";
      } else if (pendingOverdue) {
        fuStatus = "Overdue Follow-up";
        fuCategory = "overdue";
      } else if (pendingActive) {
        fuStatus = "Pending Follow-up";
        fuCategory = "pending";
      }
    }

    // Filter by followupStatus if requested
    if (followupStatus && followupStatus !== "all") {
      const target = followupStatus.toLowerCase().trim();
      if (target === "overdue" && fuCategory !== "overdue") continue;
      if (target === "pending" && fuCategory !== "pending") continue;
      if (target === "completed" && fuCategory !== "completed") continue;
      if (target === "none" && fuCategory !== "no_followup") continue;
    }

    // Filter by leadStatus if requested
    if (leadStatus && leadStatus !== "all") {
      if (curLeadStatus.toLowerCase() !== leadStatus.toLowerCase().trim()) {
        continue;
      }
    }

    const repName = call.salespersonName || (leadDoc?.assignedTo ? String(leadDoc.assignedTo) : "Unassigned");
    const phone = call.customerPhone || leadDoc?.phone || "Unknown";

    filteredCalls.push({
      callEventId: call.callEventId,
      customerName: call.customerName || leadDoc?.name || "Caller",
      customerPhone: phone,
      salesperson: repName,
      salespersonId: call.salespersonId || leadDoc?.assignedTo || null,
      callDateIST: new Date(call.calledAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }),
      callTimeIST: new Date(call.calledAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" }),
      callStatus: "missed",
      leadStatus: curLeadStatus,
      followupStatus: fuStatus,
      followupCategory: fuCategory,
      rawCalledAt: call.calledAt,
    });
  }

  // Summary statistics calculated on the EXACT filtered population
  const uniqueCustomerPhones = new Set();
  const salespersonCounts = {};
  const dateCounts = {};
  const leadStatusCounts = {};
  let pendingCount = 0;
  let overdueCount = 0;
  let completedCount = 0;
  let noFollowupCount = 0;
  let unassignedCount = 0;

  for (const c of filteredCalls) {
    uniqueCustomerPhones.add(c.customerPhone);

    salespersonCounts[c.salesperson] = (salespersonCounts[c.salesperson] || 0) + 1;
    if (c.salesperson === "Unassigned" || !c.salespersonId) {
      unassignedCount++;
    }

    const dStr = getISTDateString(c.rawCalledAt);
    dateCounts[dStr] = (dateCounts[dStr] || 0) + 1;

    leadStatusCounts[c.leadStatus] = (leadStatusCounts[c.leadStatus] || 0) + 1;

    if (c.followupCategory === "completed") completedCount++;
    else if (c.followupCategory === "overdue") overdueCount++;
    else if (c.followupCategory === "pending") pendingCount++;
    else noFollowupCount++;
  }

  // Paginated records
  filteredCalls.sort((a, b) => new Date(b.rawCalledAt) - new Date(a.rawCalledAt));
  const pagedRecords = filteredCalls.slice(skip, skip + limit).map((r) => {
    const { rawCalledAt, followupCategory, salespersonId, ...rest } = r;
    return rest;
  });

  const summary = {
    periodEvaluated: dateRange.label,
    salespersonEvaluated: repResolution?.canonicalName || "All Sales Representatives",
    totalMatchingMissedCalls: filteredCalls.length,
    totalMissedCalls: filteredCalls.length, // dual-mapped for compatibility
    uniqueCustomers: uniqueCustomerPhones.size,
    uniqueCustomersCount: uniqueCustomerPhones.size,
    unassignedMissedCalls: unassignedCount,
    pendingFollowups: pendingCount,
    overdueFollowups: overdueCount,
    completedFollowups: completedCount,
    successfullyFollowedUp: completedCount,
    noFollowupRecords: noFollowupCount,
    noFollowupScheduled: noFollowupCount,
    salespersonBreakdown: salespersonCounts,
    dateBreakdown: dateCounts,
    leadStatusBreakdown: leadStatusCounts,
    followupStatusBreakdown: {
      pending: pendingCount,
      overdue: overdueCount,
      completed: completedCount,
      no_followup: noFollowupCount,
    },
    // Distinct org-wide count when filtered
    unfilteredTotalMissedCalls: allMissedCalls.length,
  };

  return formatPaginatedResponse({
    totalCount: filteredCalls.length,
    page,
    limit,
    records: pagedRecords,
    summary,
    coverage: isPartialCoverage ? "partial" : "complete",
    message: coverageWarnings.length > 0 ? coverageWarnings.join("; ") : "",
    filtersApplied: {
      period: dateRange.label,
      salesperson: repResolution?.canonicalName || "All Salespeople",
      followupFilter: followupStatus || "All",
      leadStatusFilter: leadStatus || "All",
    },
  });
};
