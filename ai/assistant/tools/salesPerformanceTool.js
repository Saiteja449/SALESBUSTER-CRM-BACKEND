import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { resolveDateRange, formatDuration, getISTDateBoundaries } from "../dateUtils.js";

/**
 * Creates Sales Performance & Leaderboard tool bound to authenticated tenant context
 */
export const createSalesPerformanceTool = ({ tenantModels }) => {
  return tool(
    async ({ period = "this_month", salespersonNameOrId }) => {
      try {
        const {
          Lead: LeadModel,
          User: UserModel,
          TelecallerAnalytics: AnalyticsModel,
        } = tenantModels;

        if (!LeadModel || !UserModel) {
          return JSON.stringify({ error: "Required models not found in tenant database" });
        }

        const range = resolveDateRange(period);
        const { start, end, label, startStr, endStr } = range;

        // 1. Fetch active sales reps
        const activeUsers = await UserModel.find({
          status: "active",
          role: { $in: ["sales person", "sales manager", "sales representative"] },
        })
          .select("name email role phone")
          .lean();

        const userMap = new Map();
        for (const u of activeUsers) {
          userMap.set(u._id.toString(), u.name || u.email);
          if (u.name) userMap.set(u.name.toLowerCase(), u.name);
        }

        // 2. Aggregate Leads grouped by assignedTo within period
        const leadPipeline = [
          ...(range.isAllTime ? [] : [{ $match: { createdAt: { $gte: start, $lte: end } } }]),
          {
            $group: {
              _id: "$assignedTo",
              totalLeads: { $sum: 1 },
              convertedLeads: {
                $sum: { $cond: [{ $eq: ["$status", "Converted"] }, 1, 0] },
              },
              followUps: {
                $sum: { $cond: [{ $eq: ["$status", "Follow Up"] }, 1, 0] },
              },
              totalDealValue: {
                $sum: { $cond: [{ $gt: ["$dealValue", 0] }, "$dealValue", 0] },
              },
            },
          },
        ];

        const leadStats = await LeadModel.aggregate(leadPipeline);

        // 3. Aggregate Telecaller Analytics (calls & talk time) within period
        // Date in TelecallerAnalytics is "YYYY-MM-DD" string
        let callStats = [];
        if (AnalyticsModel) {
          const boundaries = getISTDateBoundaries();
          const qStartStr = period === "today" ? boundaries.todayStr : startStr;
          const qEndStr = period === "today" ? boundaries.todayStr : endStr;

          const matchCallStage = range.isAllTime
            ? {}
            : { date: { $gte: qStartStr, $lte: qEndStr } };

          callStats = await AnalyticsModel.aggregate([
            ...(Object.keys(matchCallStage).length > 0 ? [{ $match: matchCallStage }] : []),
            {
              $group: {
                _id: { $ifNull: ["$salespersonId", "$salesperson"] },
                salespersonName: { $first: "$salesperson" },
                totalCalls: { $sum: "$totalCalls" },
                talkTimeSeconds: { $sum: "$talkTime" },
                connectedCalls: { $sum: "$connected" },
                missedCalls: { $sum: "$missed" },
              },
            },
          ]);
        }

        // Map call stats by identifier
        const callStatsMap = new Map();
        for (const c of callStats) {
          const key = c._id ? String(c._id).toLowerCase() : "";
          if (key) callStatsMap.set(key, c);
          if (c.salespersonName) callStatsMap.set(c.salespersonName.toLowerCase(), c);
        }

        // 4. Combine into rep performance cards
        const repPerformance = [];

        // Combine from activeUsers
        for (const u of activeUsers) {
          const uid = u._id.toString();
          const uname = u.name || u.email;
          const unameLower = uname.toLowerCase();

          // Lead stats
          const lStat = leadStats.find((l) => {
            const assigned = String(l._id || "");
            return assigned === uid || (uname && assigned.toLowerCase() === unameLower);
          });

          // Call stats
          const cStat = callStatsMap.get(uid.toLowerCase()) || callStatsMap.get(unameLower);

          const totalL = lStat ? lStat.totalLeads : 0;
          const convL = lStat ? lStat.convertedLeads : 0;
          const totalCalls = cStat ? cStat.totalCalls : 0;
          const talkSec = cStat ? cStat.talkTimeSeconds : 0;
          const connected = cStat ? cStat.connectedCalls : 0;

          const convRate = totalL > 0 ? Math.round((convL / totalL) * 100) : 0;

          repPerformance.push({
            repId: uid,
            name: uname,
            role: u.role,
            leadsGeneratedOrAssigned: totalL,
            convertedLeads: convL,
            conversionRate: `${convRate}%`,
            dealValue: lStat && lStat.totalDealValue > 0 ? `₹${lStat.totalDealValue.toLocaleString("en-IN")}` : "₹0",
            totalCallsLogged: totalCalls,
            connectedCalls: connected,
            totalTalkTime: formatDuration(talkSec),
            rawTalkTimeSeconds: talkSec,
          });
        }

        // Also check if any leads are Unassigned
        const unassignedStat = leadStats.find((l) => !l._id || String(l._id).toLowerCase() === "unassigned");
        const unassignedCount = unassignedStat ? unassignedStat.totalLeads : 0;

        // Sort by leads generated descending (leaderboard)
        repPerformance.sort((a, b) => b.leadsGeneratedOrAssigned - a.leadsGeneratedOrAssigned);

        // Filter if specific rep requested
        let results = repPerformance;
        if (salespersonNameOrId && salespersonNameOrId.trim()) {
          const search = salespersonNameOrId.trim().toLowerCase();
          results = repPerformance.filter(
            (r) => r.name.toLowerCase().includes(search) || r.repId.toLowerCase() === search
          );
        }

        const topPerformer = repPerformance.length > 0 ? repPerformance[0] : null;

        return JSON.stringify({
          periodEvaluated: label,
          topPerformerByLeads: topPerformer
            ? {
                name: topPerformer.name,
                leads: topPerformer.leadsGeneratedOrAssigned,
                converted: topPerformer.convertedLeads,
              }
            : null,
          unassignedLeadsCount: unassignedCount,
          teamLeaderboard: results,
        });
      } catch (error) {
        return JSON.stringify({ error: `Sales performance query failed: ${error.message}` });
      }
    },
    {
      name: "get_salesperson_performance",
      description:
        "Analyzes sales team performance, rep-wise lead generation, conversions, calls logged, and talk time. Supports periods: 'all_time' (complete/overall history), 'this_month', 'last_month', 'this_week', 'last_week', 'today', 'yesterday'. Answers: 'get complete my team reports', 'Which salesperson generated the most leads this month?', and 'Summarize our sales team performance'.",
      schema: z.object({
        period: z
          .enum([
            "all_time",
            "this_month",
            "last_month",
            "this_week",
            "last_week",
            "today",
            "yesterday",
            "last_7_days",
            "last_30_days",
            "custom",
          ])
          .default("all_time")
          .describe("Time period to evaluate sales performance for. Use 'all_time' when user asks for complete, overall, or total team reports; use 'this_month' for the current month."),
        salespersonNameOrId: z
          .string()
          .optional()
          .describe("Optional name or ID to filter down to a specific sales representative"),
      }),
    }
  );
};
