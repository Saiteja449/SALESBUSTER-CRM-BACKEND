import mongoose from "mongoose";
import TelecallerAnalytics from "../models/TelecallerAnalytics.js";
import AILimit from "../models/AILimit.js";
import Lead from "../models/Lead.js";
import { getIO } from "../socket/socket.js";
import { recordLeadCallAtomic } from "../services/leadCallService.js";

const getModels = (req) => ({
  AnalyticsModel: req.tenantModels?.TelecallerAnalytics || TelecallerAnalytics,
  AILimitModel: req.tenantModels?.AILimit || AILimit,
  LeadModel: req.tenantModels?.Lead || Lead,
});

// Logs a single call and increments daily analytics
export const logCall = async (req, res) => {
  try {
    let {
      salesperson,
      salespersonId,
      date,
      duration,
      callType,
      status,
      leadId,
      phone,
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

    res.status(200).json({
      success: true,
      data: analytics,
      lead: updatedLead
        ? {
            id: updatedLead._id,
            callCount: updatedLead.callCount,
            repCallCounts: updatedLead.repCallCounts,
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
