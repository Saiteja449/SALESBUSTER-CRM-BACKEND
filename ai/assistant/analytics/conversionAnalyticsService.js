import mongoose from "mongoose";
import { resolveSalesperson, listAllSalespeople } from "./salespersonResolver.js";
import { resolveAnalyticsDateRange } from "./dateRangeResolver.js";
import { validateAnalyticsQuery, formatPaginatedResponse } from "./analyticsQueryValidator.js";
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
    return { success: false, error: "Lead model not available" };
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
    baseClauses.push({ createdAt: { $gte: dateRange.start, $lte: dateRange.end } });
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
                    { $in: ["$status", ["Not Interested", "Price Issue", "Not Attended"]] },
                    1,
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
                    { $in: ["$status", ["Not Interested", "Price Issue", "Not Attended"]] },
                    1,
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

  // Match Rep names to UserModel
  const users = await listAllSalespeople({ tenantModels });
  const userMap = new Map();
  for (const u of users) {
    userMap.set(u._id ? u._id.toString() : u.id, u.name);
  }

  let unassignedCount = 0;
  const repList = (facetResults?.bySalesperson || []).map((rep) => {
    let repName = "Unassigned";
    if (rep._id) {
      const idStr = rep._id.toString();
      repName = userMap.get(idStr) || rep._id;
    } else {
      unassignedCount += rep.totalLeads;
    }

    const repRate = rep.totalLeads > 0 ? ((rep.convertedLeads / rep.totalLeads) * 100).toFixed(1) : "0.0";

    return {
      salesperson: repName,
      totalLeads: rep.totalLeads,
      convertedLeads: rep.convertedLeads,
      lostLeads: rep.lostLeads,
      conversionRate: `${repRate}%`,
      revenueINR: `₹${(rep.dealValue || 0).toLocaleString("en-IN")}`,
      rawDealValue: rep.dealValue || 0,
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
    pipelineValueINR: `₹${totalDealValue.toLocaleString("en-IN")}`,
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
