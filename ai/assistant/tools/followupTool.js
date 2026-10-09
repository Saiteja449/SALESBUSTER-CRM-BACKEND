import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getISTDateBoundaries } from "../dateUtils.js";

/**
 * Creates Follow-ups & Tasks tool bound to authenticated tenant context
 */
export const createFollowupTool = ({ tenantModels }) => {
  return tool(
    async ({ filter = "all_pending", priority, limit = 10 }) => {
      try {
        const { Followup: FollowupModel, Lead: LeadModel } = tenantModels;
        if (!FollowupModel) {
          return JSON.stringify({ error: "Followup model not found in tenant database" });
        }

        const boundaries = getISTDateBoundaries();
        const todayStr = boundaries.todayStr; // "YYYY-MM-DD"

        const query = { done: false };

        if (filter === "overdue") {
          query.date = { $lt: todayStr };
        } else if (filter === "pending_today") {
          query.date = todayStr;
        } else if (filter === "upcoming") {
          query.date = { $gt: todayStr };
        } else if (filter === "completed") {
          query.done = true;
        }
        // if "all_pending", query.done is false and any date applies

        if (priority) {
          query.priority = priority;
        }

        // 1. Overall counts summary
        const [counts] = await FollowupModel.aggregate([
          {
            $facet: {
              overdueCount: [{ $match: { done: false, date: { $lt: todayStr } } }, { $count: "c" }],
              todayCount: [{ $match: { done: false, date: todayStr } }, { $count: "c" }],
              upcomingCount: [{ $match: { done: false, date: { $gt: todayStr } } }, { $count: "c" }],
              completedTotal: [{ $match: { done: true } }, { $count: "c" }],
              byPriorityPending: [
                { $match: { done: false } },
                { $group: { _id: "$priority", count: { $sum: 1 } } },
              ],
            },
          },
        ]);

        const overdueTotal = counts.overdueCount[0]?.c || 0;
        const todayTotal = counts.todayCount[0]?.c || 0;
        const upcomingTotal = counts.upcomingCount[0]?.c || 0;
        const allPendingTotal = overdueTotal + todayTotal + upcomingTotal;

        const priorityBreakdown = {};
        for (const p of counts.byPriorityPending || []) {
          priorityBreakdown[p._id || "Medium"] = p.count;
        }

        // 2. Fetch specific matching follow-ups
        const safeLimit = Math.min(Math.max(1, limit), 25);
        const matchingFollowups = await FollowupModel.find(query)
          .sort({ date: 1, time: 1 })
          .limit(safeLimit)
          .lean();

        // Populate lead phones/services if available
        const leadIds = matchingFollowups.map((f) => f.leadId).filter(Boolean);
        let leadMap = new Map();
        if (LeadModel && leadIds.length > 0) {
          const leads = await LeadModel.find({ _id: { $in: leadIds } })
            .select("name phone service assignedTo")
            .lean();
          for (const l of leads) {
            leadMap.set(l._id.toString(), l);
          }
        }

        const sampleTasks = matchingFollowups.map((f) => {
          const lead = leadMap.get(String(f.leadId));
          const isOverdue = f.date < todayStr && !f.done;
          return {
            id: f._id.toString(),
            leadName: f.leadName || lead?.name || "Unnamed Lead",
            leadPhone: lead?.phone || undefined,
            assignedRep: lead?.assignedTo ? String(lead.assignedTo) : undefined,
            scheduledDate: f.date,
            scheduledTime: f.time || undefined,
            type: f.type || "Call",
            priority: f.priority || "Medium",
            isOverdue,
            notes: f.notes ? (f.notes.length > 90 ? f.notes.slice(0, 90) + "..." : f.notes) : undefined,
          };
        });

        return JSON.stringify({
          summary: {
            todayIST: todayStr,
            overduePendingCount: overdueTotal,
            scheduledTodayCount: todayTotal,
            upcomingFutureCount: upcomingTotal,
            totalAllPending: allPendingTotal,
            pendingByPriority: priorityBreakdown,
          },
          matchingFilter: filter,
          showingItemsCount: sampleTasks.length,
          tasks: sampleTasks,
        });
      } catch (error) {
        return JSON.stringify({ error: `Follow-up query failed: ${error.message}` });
      }
    },
    {
      name: "get_followup_status",
      description:
        "Fetches follow-up and callback task counts, overdue tasks, today's schedule, and pending priorities. Answers: 'How many follow-ups are pending or overdue?' and 'What follow-ups do we have today?'.",
      schema: z.object({
        filter: z
          .enum(["all_pending", "overdue", "pending_today", "upcoming", "completed"])
          .default("all_pending")
          .describe("Category of follow-ups to query"),
        priority: z
          .enum(["High", "Medium", "Low"])
          .optional()
          .describe("Filter by priority"),
        limit: z
          .number()
          .min(1)
          .max(25)
          .default(10)
          .describe("Maximum task items to display in response (1-25)"),
      }),
    }
  );
};
