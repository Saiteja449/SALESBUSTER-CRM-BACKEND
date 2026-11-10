import mongoose from "mongoose";
import TelecallerAnalytics from "../models/TelecallerAnalytics.js";
import AILimit from "../models/AILimit.js";
import Lead from "../models/Lead.js";
import Followup from "../models/Followup.js";
import User from "../models/User.js";
import CallRecord from "../models/CallRecord.js";
import { getIO } from "../socket/socket.js";
import { recordLeadCallAtomic } from "../services/leadCallService.js";

const canQueryModel = (model) => {
  if (!model) return false;
  if (model.prototype instanceof mongoose.Model || model.schema) {
    const readyState = model.db?.readyState ?? mongoose.connection?.readyState;
    return readyState === 1;
  }
  return true;
};

const getModels = (req) => ({
  AnalyticsModel: req.tenantModels?.TelecallerAnalytics || TelecallerAnalytics,
  AILimitModel: req.tenantModels?.AILimit || AILimit,
  LeadModel: req.tenantModels?.Lead || Lead,
  FollowupModel: req.tenantModels?.Followup || Followup,
  UserModel: req.tenantModels?.User || User,
  CallRecordModel: req.tenantModels?.CallRecord || (mongoose.models.CallRecord || CallRecord),
});

// Logs a single call and increments daily analytics
export const logCall = async (req, res) => {
  try {
    let {
      salesperson,
      salespersonId,
      date,
      timestamp,
      calledAt,
      duration,
      callType,
      status,
      leadId,
      phone,
      callEventId,
      eventId,
    } = req.body;

    // Strict identity enforcement: if caller is authenticated, bind to verified identity
    if (req.user?.role === "sales person") {
      salespersonId = (req.user._id || req.user.id).toString();
      salesperson = req.user.name || "Sales Representative";
    } else if (req.user) {
      if (!salespersonId) {
        salespersonId = (req.user._id || req.user.id)?.toString();
      }
      if (!salesperson) {
        salesperson = req.user.name || "Sales Representative";
      }
    }

    const repIdentifier = salespersonId || salesperson;

    if (!repIdentifier || !date) {
      return res.status(400).json({
        success: false,
        message: "Salesperson ID/Name and date are required.",
      });
    }

    const { AnalyticsModel, LeadModel } = getModels(req);

    // If leadId or phone is provided, atomically update lead call counters first
    let updatedLead = null;
    if (leadId || phone) {
      updatedLead = await recordLeadCallAtomic({
        LeadModel,
        leadId,
        phone,
        salespersonId,
        salespersonName: salesperson,
        callEventId: callEventId || eventId || null,
        callType,
        status,
        duration,
        calledAt: timestamp ? new Date(timestamp) : (calledAt ? new Date(calledAt) : new Date()),
      });

      // If an explicit leadId was provided without phone and no lead was found, abort and report 404
      if (leadId && !phone && !updatedLead) {
        return res.status(404).json({
          success: false,
          message: `Lead not found for leadId: ${leadId}. Call log aborted to preserve counter integrity.`,
        });
      }

      if (updatedLead) {
        const io = getIO();
        if (io) {
          const orgId = req.organization?._id || req.user?.organizationId;
          if (orgId) {
            const payload = {
              leadId: updatedLead._id.toString(),
              callCount: updatedLead.callCount,
              repCallCounts: updatedLead.repCallCounts,
              callHistory: updatedLead.callHistory,
              lastCallAt: updatedLead.lastCallAt,
            };
            io.to(`org_${orgId}`).emit("lead_call_updated", payload);
            io.to(`org_${orgId}`).emit("lead_updated", {
              leadId: updatedLead._id,
              lead: updatedLead,
            });
          }
        }
      }
    }

    const durationNum = parseInt(duration) || 0;

    const update = {
      $inc: {
        totalCalls: 1,
        talkTime: durationNum,
      },
      $max: {
        longestCall: durationNum,
      },
    };

    if (callType === "incoming") update.$inc.incoming = 1;
    if (callType === "outgoing") update.$inc.outgoing = 1;

    if (status === "missed") update.$inc.missed = 1;
    if (status === "connected") update.$inc.connected = 1;
    if (status === "rejected") update.$inc.rejected = 1;
    if (status === "not-connected") update.$inc.notConnected = 1;

    let queryFilter = {};
    if (salespersonId) {
      queryFilter = { salespersonId, date };
      update.$setOnInsert = { salesperson: salesperson || "" };
    } else if (mongoose.Types.ObjectId.isValid(repIdentifier)) {
      queryFilter = { salespersonId: repIdentifier, date };
      update.$setOnInsert = { salesperson: salesperson || "" };
    } else {
      queryFilter = { salesperson: repIdentifier, date };
    }

    // Use upsert to create the document if it doesn't exist
    const analytics = await AnalyticsModel.findOneAndUpdate(
      queryFilter,
      update,
      { new: true, upsert: true },
    );

    // Save individual call record if CallRecordModel is available
    const { CallRecordModel } = getModels(req);
    if (canQueryModel(CallRecordModel) && typeof CallRecordModel.create === "function") {
      try {
        const cleanCallEventId = callEventId || eventId || `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const callTime = timestamp ? new Date(timestamp) : (calledAt ? new Date(calledAt) : new Date());
        const orgId = req.organization?._id || req.user?.organizationId;
        await CallRecordModel.findOneAndUpdate(
          { callEventId: cleanCallEventId },
          {
            $set: {
              organizationId: orgId,
              leadId: updatedLead?._id || (leadId && mongoose.Types.ObjectId.isValid(leadId) ? leadId : null),
              salespersonId: salespersonId || null,
              salespersonName: salesperson || "Unassigned",
              customerName: updatedLead?.name || "",
              customerPhone: phone || updatedLead?.phone || "Unknown",
              callType: callType || "outgoing",
              callStatus: status || "connected",
              duration: durationNum,
              calledAt: callTime,
              source: "Call",
            },
          },
          { upsert: true, new: true }
        );
      } catch (crErr) {
        console.warn("[logCall] Note updating CallRecord:", crErr.message);
      }
    }

    res.status(200).json({
      success: true,
      data: analytics,
      lead: updatedLead
        ? {
            id: updatedLead._id,
            callCount: updatedLead.callCount,
            repCallCounts: updatedLead.repCallCounts,
            callHistory: updatedLead.callHistory,
            lastCallAt: updatedLead.lastCallAt,
          }
        : null,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Gets daily analytics for a salesperson
export const getAnalyticsBySalesperson = async (req, res) => {
  try {
    const { salesperson, id, salespersonId } = req.params;
    const target = id || salespersonId || salesperson;

    // Role check: sales reps can only view their own analytics
    if (req.user?.role === "sales person") {
      const repId = (req.user._id || req.user.id).toString();
      const repName = req.user.name ? req.user.name.toLowerCase() : "";
      const targetStr = String(target).toLowerCase();

      const isOwn =
        targetStr === repId.toLowerCase() ||
        (repName && targetStr === repName);

      if (!isOwn) {
        return res.status(403).json({
          success: false,
          message: "Access forbidden: You can only view your own analytics",
        });
      }
    }

    const { AnalyticsModel } = getModels(req);

    const orConditions = [{ salesperson: target }];
    if (mongoose.Types.ObjectId.isValid(target)) {
      orConditions.push({ salespersonId: target });
      orConditions.push({ salespersonId: new mongoose.Types.ObjectId(target) });
    }

    // Fetch last 7 days of records sorted by date descending
    const analytics = await AnalyticsModel.find({ $or: orConditions })
      .sort({ date: -1 })
      .limit(7);

    res.status(200).json({ success: true, data: analytics });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Gets today's analytics for all salespeople (restricted to managers and admins)
export const getTodayAnalyticsForAll = async (req, res) => {
  try {
    if (req.user?.role === "sales person") {
      return res.status(403).json({
        success: false,
        message: "Access forbidden: Team-wide analytics are restricted to managers and administrators",
      });
    }

    const today = new Date().toISOString().split("T")[0];
    const { AnalyticsModel } = getModels(req);
    const analytics = await AnalyticsModel.find({ date: today });
    res.status(200).json({ success: true, data: analytics });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Gets dedicated, high-performance aggregated summary for Dashboard view
export const getDashboardSummary = async (req, res) => {
  try {
    const { LeadModel, FollowupModel, UserModel, AnalyticsModel } = getModels(req);

    // Build role-based lead filtering
    let leadFilter = {};
    const isSalesPerson = req.user?.role === "sales person";
    let repIdStr = "";
    let repNameStr = "";

    if (isSalesPerson && req.user) {
      repIdStr = (req.user._id || req.user.id).toString();
      repNameStr = req.user.name || "";
      const matchConditions = [repIdStr];
      if (mongoose.Types.ObjectId.isValid(repIdStr)) {
        matchConditions.push(new mongoose.Types.ObjectId(repIdStr));
      }
      if (repNameStr) {
        matchConditions.push(new RegExp("^" + repNameStr + "$", "i"));
      }
      leadFilter.assignedTo = { $in: matchConditions };
    }

    const clientDate = req.query.clientDate || new Date().toISOString().split("T")[0];

    // Concurrently aggregate Lead KPIs and Followup KPIs directly inside MongoDB
    const [leadAggResult, followupAggResult, salesUsers, todayAnalytics] = await Promise.all([
      LeadModel.aggregate([
        { $match: leadFilter },
        {
          $facet: {
            overall: [
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  converted: {
                    $sum: { $cond: [{ $eq: ["$status", "Converted"] }, 1, 0] },
                  },
                  unassigned: {
                    $sum: {
                      $cond: [
                        {
                          $or: [
                            { $eq: ["$assignedTo", "Unassigned"] },
                            { $eq: ["$assignedTo", ""] },
                            { $eq: ["$assignedTo", null] },
                            { $not: ["$assignedTo"] },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  activePipeline: {
                    $sum: {
                      $cond: [
                        {
                          $not: {
                            $in: ["$status", ["Converted", "Lost", "Not Interested"]],
                          },
                        },
                        1,
                        0,
                      ],
                    },
                  },
                },
              },
            ],
            byService: [
              {
                $group: {
                  _id: { $ifNull: ["$service", "General Enquiry"] },
                  count: { $sum: 1 },
                  won: {
                    $sum: { $cond: [{ $eq: ["$status", "Converted"] }, 1, 0] },
                  },
                },
              },
            ],
            bySource: [
              {
                $group: {
                  _id: { $ifNull: ["$source", "Manual Entry"] },
                  count: { $sum: 1 },
                },
              },
            ],
            byAssignedTo: [
              {
                $group: {
                  _id: "$assignedTo",
                  assigned: { $sum: 1 },
                  won: {
                    $sum: { $cond: [{ $eq: ["$status", "Converted"] }, 1, 0] },
                  },
                },
              },
            ],
          },
        },
      ]),
      FollowupModel ? FollowupModel.aggregate([
        {
          $facet: {
            todayPending: [
              { $match: { date: clientDate, done: false } },
              { $count: "count" },
            ],
            overdue: [
              { $match: { date: { $lt: clientDate }, done: false } },
              { $count: "count" },
            ],
            recentActivities: [
              { $match: { done: true } },
              { $sort: { updatedAt: -1, createdAt: -1 } },
              { $limit: 10 },
              {
                $project: {
                  id: "$_id",
                  leadId: 1,
                  leadName: 1,
                  type: 1,
                  date: 1,
                  time: 1,
                  priority: 1,
                  notes: 1,
                  author: 1,
                  done: 1,
                  updatedAt: 1,
                },
              },
            ],
          },
        },
      ]) : Promise.resolve([]),
      UserModel.find({
        role: { $in: ["sales person", "Sales Representative"] },
        status: { $ne: "inactive" },
      })
        .select("_id name email phone role")
        .lean(),
      AnalyticsModel.find({ date: clientDate }).lean(),
    ]);

    const leadFacet = leadAggResult?.[0] || {};
    const overall = leadFacet.overall?.[0] || {
      total: 0,
      converted: 0,
      unassigned: 0,
      activePipeline: 0,
    };

    const totalLeads = overall.total || 0;
    const totalWonCount = overall.converted || 0;
    const convertedCount = totalWonCount;
    const conversionRate = totalLeads > 0 ? Math.round((totalWonCount / totalLeads) * 100) : 0;
    const unassignedCount = overall.unassigned || 0;
    const activePipelineCount = overall.activePipeline || 0;

    // Service Breakdown formatting
    const leadsByServiceData = (leadFacet.byService || []).map((item) => ({
      name: item._id || "Other",
      value: item.count || 0,
    }));

    const wonLeadsByServiceData = (leadFacet.byService || []).map((item) => ({
      name: item._id || "Other",
      pipeline: item.count || 0,
      won: item.won || 0,
    }));

    // Source Breakdown formatting
    const leadSourceData = (leadFacet.bySource || []).map((item) => ({
      name: item._id || "Other",
      value: item.count || 0,
    }));

    // Follow-up statistics
    const followupFacet = followupAggResult?.[0] || {};
    const todaysFollowupsCount = followupFacet.todayPending?.[0]?.count || 0;
    const overdueFollowupsCount = followupFacet.overdue?.[0]?.count || 0;
    const recentActivities = (followupFacet.recentActivities || []).map((a) => ({
      ...a,
      id: a._id ? a._id.toString() : a.id,
    }));

    // Build Performers Leaderboard
    const assignedMap = {};
    (leadFacet.byAssignedTo || []).forEach((item) => {
      if (item._id) {
        assignedMap[String(item._id)] = {
          assigned: item.assigned || 0,
          won: item.won || 0,
        };
      }
    });

    const performersList = (salesUsers || []).map((user) => {
      const uId = user._id.toString();
      const uName = (user.name || "").trim().toLowerCase();

      // Match metrics by user ID or user name
      let repAssigned = 0;
      let repWon = 0;
      for (const [key, val] of Object.entries(assignedMap)) {
        if (key === uId || (uName && key.trim().toLowerCase() === uName)) {
          repAssigned += val.assigned || 0;
          repWon += val.won || 0;
        }
      }

      const repAnalytics = (todayAnalytics || []).find(
        (a) =>
          (a.salespersonId && String(a.salespersonId) === uId) ||
          (a.salesperson && a.salesperson.trim().toLowerCase() === uName)
      );

      const convPct = repAssigned > 0 ? Math.round((repWon / repAssigned) * 100) : 0;
      const callsCount = repAnalytics?.totalCalls || 0;

      return {
        id: uId,
        name: user.name,
        email: user.email,
        phone: user.phone || "",
        role: "Sales Representative",
        assigned: repAssigned,
        won: repWon,
        callsMade: callsCount,
        conversionRate: convPct,
        activityScore: Math.min(100, Math.round(convPct * 0.7 + Math.min(callsCount * 2, 30))),
      };
    }).sort((a, b) => b.won - a.won);

    res.status(200).json({
      success: true,
      data: {
        totalLeads,
        totalWonCount,
        convertedCount,
        conversionRate,
        jobsAssignedCount: convertedCount,
        unassignedCount,
        activePipelineCount,
        leadsByServiceData,
        wonLeadsByServiceData,
        leadSourceData,
        todaysFollowupsCount,
        overdueFollowupsCount,
        recentActivities,
        performersList,
        todayAnalytics: todayAnalytics || [],
      },
    });
  } catch (error) {
    console.error("[getDashboardSummary] Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Gets current AI (Groq) rate limits from database
export const getAILimits = async (req, res) => {
  try {
    const { AILimitModel } = getModels(req);
    const limit = await AILimitModel.findOne().sort({ lastUpdated: -1 });
    if (!limit) {
      return res.status(200).json({
        success: true,
        data: {
          remainingRequests: "N/A",
          remainingTokens: "N/A",
          resetRequests: "N/A",
          resetTokens: "N/A",
        },
      });
    }
    res.status(200).json({ success: true, data: limit });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Fetches limits from API, saves to MongoDB, and returns them (restricted to managers and admins)
export const refreshAILimits = async (req, res) => {
  try {
    if (req.user?.role === "sales person") {
      return res.status(403).json({
        success: false,
        message: "Access forbidden: AI rate limit refresh is restricted to managers and administrators",
      });
    }

    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      return res
        .status(200)
        .json({ success: false, message: "No Groq API Key found" });
    }

    // Call the Groq API to get headers
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${groqApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
        }),
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      return res.status(500).json({
        success: false,
        message: `Failed to fetch limits: ${response.status} ${errText}`,
      });
    }

    const remainingRequests =
      response.headers.get("x-ratelimit-remaining-requests") || "N/A";
    const remainingTokens =
      response.headers.get("x-ratelimit-remaining-tokens") || "N/A";
    const resetRequests =
      response.headers.get("x-ratelimit-reset-requests") || "N/A";
    const resetTokens =
      response.headers.get("x-ratelimit-reset-tokens") || "N/A";

    const { AILimitModel } = getModels(req);
    let limit = await AILimitModel.findOne();
    if (!limit) {
      limit = new AILimitModel();
    }

    limit.remainingRequests = remainingRequests;
    limit.remainingTokens = remainingTokens;
    limit.resetRequests = resetRequests;
    limit.resetTokens = resetTokens;
    limit.lastUpdated = new Date();

    await limit.save();

    res.status(200).json({
      success: true,
      data: limit,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
