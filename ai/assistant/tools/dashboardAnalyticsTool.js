import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { resolveDateRange, getISTDateBoundaries } from "../dateUtils.js";

/**
 * Creates Dashboard Analytics & KPI calculation tool bound to authenticated tenant context
 */
export const createDashboardAnalyticsTool = ({ tenantModels }) => {
  return tool(
    async ({ period = "today", customStart, customEnd, compareToPrevious = false }) => {
      try {
        const { Lead: LeadModel } = tenantModels;
        if (!LeadModel) {
          return JSON.stringify({ error: "Lead model not found in tenant database" });
        }

        const range = resolveDateRange(period, customStart, customEnd);
        const { start, end, label } = range;

        // Run optimized faceted aggregation on Lead collection
        const facetPipeline = [
          {
            $facet: {
              totalLeads: [
                { $match: { createdAt: { $gte: start, $lte: end } } },
                { $count: "count" },
              ],
              convertedLeads: [
                { $match: { createdAt: { $gte: start, $lte: end }, status: "Converted" } },
                { $count: "count" },
              ],
              byStatus: [
                { $match: { createdAt: { $gte: start, $lte: end } } },
                { $group: { _id: "$status", count: { $sum: 1 } } },
                { $sort: { count: -1 } },
              ],
              bySource: [
                { $match: { createdAt: { $gte: start, $lte: end } } },
                { $group: { _id: { $ifNull: ["$source", "Unknown"] }, count: { $sum: 1 } } },
                { $sort: { count: -1 } },
              ],
              byService: [
                { $match: { createdAt: { $gte: start, $lte: end } } },
                { $group: { _id: { $ifNull: ["$service", "General Enquiry"] }, count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 5 },
              ],
              dealValue: [
                { $match: { createdAt: { $gte: start, $lte: end }, dealValue: { $gt: 0 } } },
                { $group: { _id: null, totalValue: { $sum: "$dealValue" } } },
              ],
            },
          },
        ];

        const [results] = await LeadModel.aggregate(facetPipeline);

        const total = results.totalLeads[0]?.count || 0;
        const converted = results.convertedLeads[0]?.count || 0;
        const conversionRatePercent = total > 0 ? Math.round((converted / total) * 100) : 0;
        const totalDealValue = results.dealValue[0]?.totalValue || 0;

        const statusMap = {};
        for (const item of results.byStatus || []) {
          statusMap[item._id] = item.count;
        }

        const sourceMap = {};
        for (const item of results.bySource || []) {
          sourceMap[item._id] = item.count;
        }

        const serviceBreakdown = (results.byService || []).map((s) => ({
          service: s._id,
          count: s.count,
        }));

        const output = {
          periodLabel: label,
          startIST: start.toISOString(),
          endIST: end.toISOString(),
          totalLeads: total,
          convertedLeads: converted,
          conversionRatePercent: `${conversionRatePercent}%`,
          totalDealValue: totalDealValue > 0 ? `₹${totalDealValue.toLocaleString("en-IN")}` : "₹0",
          breakdownByStatus: statusMap,
          breakdownBySource: sourceMap,
          topServices: serviceBreakdown,
        };

        // Comparison calculation if requested (e.g. today vs yesterday)
        if (compareToPrevious) {
          const boundaries = getISTDateBoundaries();
          let prevStart, prevEnd, prevLabel;

          if (period === "today") {
            prevStart = boundaries.yesterday.start;
            prevEnd = boundaries.yesterday.end;
            prevLabel = boundaries.yesterday.label;
          } else {
            const durationMs = end.getTime() - start.getTime();
            prevEnd = new Date(start.getTime() - 1);
            prevStart = new Date(prevEnd.getTime() - durationMs);
            prevLabel = "Preceding Equivalent Period";
          }

          const [prevResults] = await LeadModel.aggregate([
            {
              $facet: {
                totalLeads: [
                  { $match: { createdAt: { $gte: prevStart, $lte: prevEnd } } },
                  { $count: "count" },
                ],
                convertedLeads: [
                  { $match: { createdAt: { $gte: prevStart, $lte: prevEnd }, status: "Converted" } },
                  { $count: "count" },
                ],
              },
            },
          ]);

          const prevTotal = prevResults.totalLeads[0]?.count || 0;
          const prevConverted = prevResults.convertedLeads[0]?.count || 0;
          const deltaLeads = total - prevTotal;
          const deltaPercentage =
            prevTotal > 0 ? Math.round(((total - prevTotal) / prevTotal) * 100) : (total > 0 ? 100 : 0);

          output.comparison = {
            previousPeriodLabel: prevLabel,
            previousTotalLeads: prevTotal,
            previousConvertedLeads: prevConverted,
            leadDifference: deltaLeads > 0 ? `+${deltaLeads}` : String(deltaLeads),
            growthPercentage: `${deltaPercentage > 0 ? "+" : ""}${deltaPercentage}%`,
          };
        }

        return JSON.stringify(output);
      } catch (error) {
        return JSON.stringify({ error: `Dashboard analytics query failed: ${error.message}` });
      }
    },
    {
      name: "get_dashboard_kpis",
      description:
        "Calculates accurate, real-time CRM dashboard metrics, lead volumes, conversion rates, and period-over-period comparisons. Use this when the user asks: 'How many new leads came this morning?', 'How many leads did we receive today compared to yesterday?', 'What is our conversion rate this month?', or general lead counts by source/status.",
      schema: z.object({
        period: z
          .enum(["today", "yesterday", "this_morning", "this_week", "this_month", "last_month", "custom"])
          .default("today")
          .describe("Target time window to evaluate. Use 'this_morning' for morning enquiries."),
        customStart: z
          .string()
          .optional()
          .describe("YYYY-MM-DD start date if period is custom"),
        customEnd: z
          .string()
          .optional()
          .describe("YYYY-MM-DD end date if period is custom"),
        compareToPrevious: z
          .boolean()
          .default(false)
          .describe("Set to true if user asks to compare with yesterday or previous period."),
      }),
    }
  );
};
