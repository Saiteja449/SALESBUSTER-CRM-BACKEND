import mongoose from "mongoose";
import { resolveSalesperson, listAllSalespeople } from "./salespersonResolver.js";
import { resolveAnalyticsDateRange } from "./dateRangeResolver.js";
import { validateAnalyticsQuery, formatPaginatedResponse } from "./analyticsQueryValidator.js";
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
 * Calculates conversion rates, pipeline value, won/lost ratios, and rep win-rates.
 */
export const getConversionAnalytics = async ({
  tenantModels = {},
  filters = {},
  pagination = {},
}) => {
  const {
    salespersonNameOrId,
    period = "all_time",
    startDate,
    endDate,
  } = filters;

  const { page, limit, skip } = validateAnalyticsQuery(pagination);
  const LeadModel = tenantModels.Lead;

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
          totalLeads: 0,
          convertedLeads: 0,
          conversionRatePercent: "0%",
          pipelineValueINR: "₹0",
          lostLeads: 0,
          unassignedLeads: 0,
          salespersonPerformance: [],
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

  const baseClauses = [];
  if (!dateRange.isAllTime) {
    if (filters.dateBasis === "conversion_date") {
      baseClauses.push({
        $or: [
          { updatedAt: { $gte: dateRange.start, $lte: dateRange.end } },
          { createdAt: { $gte: dateRange.start, $lte: dateRange.end } },
        ],
      });
    } else {
      baseClauses.push({ createdAt: { $gte: dateRange.start, $lte: dateRange.end } });
    }
  }
  if (repResolution?.leadAssignedFilter) {
    baseClauses.push(repResolution.leadAssignedFilter);
  }

  const baseMatch = composeMongoQuery(...baseClauses);

  const [facetResults] = await LeadModel.aggregate([
    { $match: baseMatch },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              totalLeads: { $sum: 1 },
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
              convertedRevenue: {
                $sum: { $cond: [{ $eq: ["$status", "Converted"] }, { $ifNull: ["$dealValue", 0] }, 0] },
              },
              activePipelineValue: {
                $sum: {
                  $cond: [
                    { $in: ["$status", ["New", "Follow Up", "Missed Call"]] },
                    { $ifNull: ["$dealValue", 0] },
                    0,
                  ],
                },
              },
              totalDealValue: { $sum: { $ifNull: ["$dealValue", 0] } },
            },
          },
        ],
        bySalesperson: [
          {
            $group: {
              _id: "$assignedTo",
              totalLeads: { $sum: 1 },
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
              convertedRevenue: {
                $sum: { $cond: [{ $eq: ["$status", "Converted"] }, { $ifNull: ["$dealValue", 0] }, 0] },
              },
              activePipelineValue: {
                $sum: {
                  $cond: [
                    { $in: ["$status", ["New", "Follow Up", "Missed Call"]] },
                    { $ifNull: ["$dealValue", 0] },
                    0,
                  ],
                },
              },
              dealValue: { $sum: { $ifNull: ["$dealValue", 0] } },
            },
          },
        ],
      },
    },
  ]);

  const totals = facetResults?.totals[0] || {
    totalLeads: 0,
    convertedLeads: 0,
    lostLeads: 0,
    totalDealValue: 0,
  };

  const totalLeads = totals.totalLeads;
  const convertedLeads = totals.convertedLeads;
  const lostLeads = totals.lostLeads;
  const totalDealValue = totals.totalDealValue;
  const conversionRate = totalLeads > 0 ? ((convertedLeads / totalLeads) * 100).toFixed(1) : "0.0";

  // Match Rep names via universal OwnerDirectory (covers sales reps, managers, admins, and deleted users)
  const ownerDir = await buildOwnerDirectory({ tenantModels });
  let unassignedCount = 0;
  const repMapMerged = new Map();

  for (const rep of facetResults?.bySalesperson || []) {
    const owner = ownerDir.resolveOwner(rep._id);
    const repName = owner.name;
    if (repName === "Unassigned") {
      unassignedCount += rep.totalLeads;
      continue;
    }

    if (repMapMerged.has(repName)) {
      const existing = repMapMerged.get(repName);
      existing.totalLeads += rep.totalLeads;
      existing.convertedLeads += rep.convertedLeads;
      existing.lostLeads += rep.lostLeads;
      existing.rawDealValue += (rep.dealValue || 0);
    } else {
      repMapMerged.set(repName, {
        salesperson: repName,
        salespersonId: owner.id || undefined,
        role: owner.role,
        totalLeads: rep.totalLeads,
        convertedLeads: rep.convertedLeads,
        lostLeads: rep.lostLeads,
        rawDealValue: rep.dealValue || 0,
      });
    }
  }

  const repList = Array.from(repMapMerged.values()).map((rep) => {
    const repRate = rep.totalLeads > 0 ? ((rep.convertedLeads / rep.totalLeads) * 100).toFixed(1) : "0.0";
    return {
      salesperson: rep.salesperson,
      salespersonId: rep.salespersonId,
      role: rep.role,
      totalLeads: rep.totalLeads,
      convertedLeads: rep.convertedLeads,
      lostLeads: rep.lostLeads,
      conversionRate: `${repRate}%`,
      revenueINR: `₹${(rep.rawDealValue || 0).toLocaleString("en-IN")}`,
      rawDealValue: rep.rawDealValue || 0,
    };
  });

  repList.sort((a, b) => b.convertedLeads - a.convertedLeads);

  const paginatedReps = repList.slice(skip, skip + limit);

  const summary = {
    periodEvaluated: dateRange.label,
    salespersonEvaluated: repResolution?.canonicalName || "All Sales Representatives",
    totalLeads,
    convertedLeads,
    conversionRatePercent: `${conversionRate}%`,
    convertedRevenueINR: `₹${(totals.convertedRevenue !== undefined ? totals.convertedRevenue : totalDealValue).toLocaleString("en-IN")}`,
    activePipelineValueINR: `₹${(totals.activePipelineValue || 0).toLocaleString("en-IN")}`,
    pipelineValueINR: `₹${(totals.activePipelineValue !== undefined ? totals.activePipelineValue : totalDealValue).toLocaleString("en-IN")}`,
    totalDealValueINR: `₹${totalDealValue.toLocaleString("en-IN")}`,
    lostLeads,
    unassignedLeads: unassignedCount,
    salespersonPerformance: paginatedReps,
  };

  return formatPaginatedResponse({
    totalCount: repList.length,
    page,
    limit,
    records: paginatedReps,
    summary,
    filtersApplied: {
      period: dateRange.label,
      salesperson: repResolution?.canonicalName || "All Sales Representatives",
    },
  });
};
