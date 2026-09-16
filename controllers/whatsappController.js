import mongoose from "mongoose";
import Lead from "../models/Lead.js";
import Message from "../models/Message.js";
import Conversation from "../models/Conversation.js";
import WhatsAppSession from "../models/WhatsAppSession.js";
import {
  connectWhatsApp,
  logoutWhatsApp,
  getWhatsAppStatus,
  sendMessageFromCRM,
  getSystemSettings,
  updateSystemSettings,
  DEFAULT_WELCOME_MESSAGE_TEMPLATE,
  clearAIPauseForLead,
} from "../whatsapp/whatsappService.js";
import { getMasterModels } from "../services/tenantManager.js";

const getModels = (req) => ({
  LeadModel: req.tenantModels?.Lead || Lead,
  MessageModel: req.tenantModels?.Message || Message,
  ConversationModel: req.tenantModels?.Conversation || Conversation,
  WhatsAppSessionModel: req.tenantModels?.WhatsAppSession || WhatsAppSession,
});

// @desc    Connect WhatsApp (starts Baileys client initialization)
// @route   POST /api/whatsapp/connect
// @access  Protected
export const connectClient = async (req, res) => {
  try {
    const orgId = req.user?.organizationId
      ? req.user.organizationId.toString()
      : req.organization?._id
        ? req.organization._id.toString()
        : req.body.organizationId || null;
    const tenantDbName = req.tenantDbName || req.user?.tenantDbName;

    // Determine organization's allowed WhatsApp line limit
    let lineLimit = 2; // default fallback
    if (orgId) {
      try {
        const { Organization } = getMasterModels();
        const org = await Organization.findById(orgId).select("whatsappLineLimit").lean();
        if (org) lineLimit = org.whatsappLineLimit || 1;
      } catch (e) {}
    }
    
    let targetSessionId;
    if (orgId) {
      const isDevice2 = req.body.device === 2 || req.body.deviceNumber === 2 || req.body.isSecondary;
      const allowedSessionIds = lineLimit >= 2
        ? [`org_${orgId}`, `org_${orgId}_device_2`]
        : [`org_${orgId}`];

      if (isDevice2 && lineLimit < 2) {
        return res.status(403).json({
          message: "This organization is restricted to a Single WhatsApp Line. Upgrade to Dual Lines to connect a second device.",
        });
      }

      if (req.body.sessionId && allowedSessionIds.includes(req.body.sessionId)) {
        targetSessionId = req.body.sessionId;
      } else if (isDevice2) {
        targetSessionId = `org_${orgId}_device_2`;
      } else {
        targetSessionId = `org_${orgId}`;
      }
    } else {
      targetSessionId = req.body.sessionId || (req.body.device === 2 ? "device_2" : "device_1");
    }

    connectWhatsApp({
      sessionId: targetSessionId,
      organizationId: orgId,
      tenantDbName,
    });
    res.status(200).json({ message: "WhatsApp connection worker started.", sessionId: targetSessionId });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get WhatsApp connection status
// @route   GET /api/whatsapp/status
// @access  Protected
export const getStatus = async (req, res) => {
  try {
    const { WhatsAppSessionModel } = getModels(req);
    const orgId = req.user?.organizationId
      ? req.user.organizationId.toString()
      : req.organization?._id
        ? req.organization._id.toString()
        : null;

    if (!orgId) {
      // Legacy single-tenant fallback (always return both device slots)
      const allowedSessionIds = ["device_1", "device_2"];
      const memoryStatuses = getWhatsAppStatus(null);
      const dbSessions = await WhatsAppSessionModel.find({
        sessionId: { $in: allowedSessionIds },
      });
      const result = allowedSessionIds.map((sId, index) => {
        const mem = memoryStatuses.find((m) => m.sessionId === sId);
        const db = dbSessions.find((d) => d.sessionId === sId);
        if (db?.status === "connected" && mem?.status !== "connected" && mem?.status !== "connecting") {
          connectWhatsApp(sId).catch((e) => console.error(`[WhatsApp] Legacy auto-connect failed for ${sId}:`, e));
        }
        const status =
          mem?.status ||
          (db?.status === "connected" ? "connecting" : db?.status || "disconnected");
        return {
          sessionId: sId,
          organizationId: null,
          status,
          qrCode: status === "qr" ? mem?.qrCode || db?.qrCode || "" : "",
          connectedPhone: mem?.connectedPhone || db?.connectedPhone || "",
          connectedName: mem?.connectedName || db?.connectedName || "",
          isPrimary: index === 0,
          label: index === 0 ? "Device 1 (Primary)" : "Device 2 (Secondary)",
        };
      });
      return res.status(200).json(result);
    }

    // Determine organization's allowed WhatsApp line limit
    let lineLimit = 1;
    try {
      const { Organization } = getMasterModels();
      const org = await Organization.findById(orgId).select("whatsappLineLimit").lean();
      if (org) lineLimit = org.whatsappLineLimit || 1;
    } catch (e) {}

    const primarySessionId = `org_${orgId}`;
    const secondarySessionId = `org_${orgId}_device_2`;
    const allowedSessionIds = lineLimit >= 2
      ? [primarySessionId, secondarySessionId]
      : [primarySessionId];

    const memoryStatuses = getWhatsAppStatus(orgId).filter((m) =>
      allowedSessionIds.includes(m.sessionId)
    );

    const dbSessions = await WhatsAppSessionModel.find({
      sessionId: { $in: allowedSessionIds },
    });

    const result = [];

    const tenantDbName = req.tenantDbName || req.user?.tenantDbName;

    // 1. Always include Primary Session
    const primaryMem = memoryStatuses.find((m) => m.sessionId === primarySessionId);
    const primaryDb = dbSessions.find((d) => d.sessionId === primarySessionId);

    // If DB says connected but in-memory socket is missing, auto-heal connection in background
    if (primaryDb?.status === "connected" && primaryMem?.status !== "connected" && primaryMem?.status !== "connecting") {
      console.log(`[WhatsApp] getStatus detected disconnected memory state for ${primarySessionId}. Triggering auto-heal...`);
      connectWhatsApp({
        sessionId: primarySessionId,
        organizationId: orgId,
        tenantDbName,
      }).catch((e) => console.error(`[WhatsApp] Auto-connect from getStatus failed for ${primarySessionId}:`, e));
    }

    const primaryStatus =
      primaryMem?.status ||
      (primaryDb?.status === "connected" ? "connecting" : primaryDb?.status || "disconnected");

    result.push({
      sessionId: primarySessionId,
      organizationId: orgId,
      status: primaryStatus,
      qrCode: primaryStatus === "qr" ? primaryMem?.qrCode || primaryDb?.qrCode || "" : "",
      connectedPhone: primaryMem?.connectedPhone || primaryDb?.connectedPhone || "",
      connectedName: primaryMem?.connectedName || primaryDb?.connectedName || "",
      isPrimary: true,
      label: "Device 1 (Primary)",
    });

    // 2. Include Secondary Session only if line limit allows
    if (lineLimit >= 2) {
      const secondaryMem = memoryStatuses.find((m) => m.sessionId === secondarySessionId);
      const secondaryDb = dbSessions.find((d) => d.sessionId === secondarySessionId);

      if (secondaryDb?.status === "connected" && secondaryMem?.status !== "connected" && secondaryMem?.status !== "connecting") {
        console.log(`[WhatsApp] getStatus detected disconnected memory state for ${secondarySessionId}. Triggering auto-heal...`);
        connectWhatsApp({
          sessionId: secondarySessionId,
          organizationId: orgId,
          tenantDbName,
        }).catch((e) => console.error(`[WhatsApp] Auto-connect from getStatus failed for ${secondarySessionId}:`, e));
      }

      const secondaryStatus =
        secondaryMem?.status ||
        (secondaryDb?.status === "connected" ? "connecting" : secondaryDb?.status || "disconnected");

      result.push({
        sessionId: secondarySessionId,
        organizationId: orgId,
        status: secondaryStatus,
        qrCode: secondaryStatus === "qr" ? secondaryMem?.qrCode || secondaryDb?.qrCode || "" : "",
        connectedPhone: secondaryMem?.connectedPhone || secondaryDb?.connectedPhone || "",
        connectedName: secondaryMem?.connectedName || secondaryDb?.connectedName || "",
        isPrimary: false,
        label: "Device 2 (Secondary)",
      });
    }

    // Include the line limit in the response for frontend adaptation
    res.status(200).json({ sessions: result, whatsappLineLimit: lineLimit });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Disconnect WhatsApp and delete credentials
// @route   POST /api/whatsapp/logout
// @access  Protected
export const logoutClient = async (req, res) => {
  try {
    const orgId = req.user?.organizationId
      ? req.user.organizationId.toString()
      : req.organization?._id
        ? req.organization._id.toString()
        : null;

    let targetSessionId;
    if (orgId) {
      const allowedSessionIds = [`org_${orgId}`, `org_${orgId}_device_2`];
      if (req.body.sessionId && allowedSessionIds.includes(req.body.sessionId)) {
        targetSessionId = req.body.sessionId;
      } else if (req.body.device === 2 || req.body.deviceNumber === 2 || req.body.isSecondary) {
        targetSessionId = `org_${orgId}_device_2`;
      } else {
        targetSessionId = `org_${orgId}`;
      }
    } else {
      targetSessionId = req.body.sessionId || (req.body.device === 2 ? "device_2" : "device_1");
    }

    await logoutWhatsApp(targetSessionId);
    res
      .status(200)
      .json({ message: "WhatsApp disconnected and logged out successfully.", sessionId: targetSessionId });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get current active QR code image string
// @route   GET /api/whatsapp/qr
// @access  Protected
export const getQR = async (req, res) => {
  try {
    const orgId = req.user?.organizationId
      ? req.user.organizationId.toString()
      : req.organization?._id
        ? req.organization._id.toString()
        : null;
    let lineLimit = 1;
    if (orgId) {
      try {
        const { Organization } = getMasterModels();
        const org = await Organization.findById(orgId).select("whatsappLineLimit").lean();
        if (org) lineLimit = org.whatsappLineLimit || 1;
      } catch (e) {}
    }

    let targetSessionId = req.query.sessionId;
    const isDevice2 =
      req.query.device === "2" ||
      req.query.deviceNumber === "2" ||
      targetSessionId?.includes("device_2");

    if (orgId && isDevice2 && lineLimit < 2) {
      return res.status(403).json({
        message:
          "This organization is configured for a Single WhatsApp Line. Upgrade to Dual Lines to access Line 2.",
        qrCode: "",
      });
    }

    const statusDataList = getWhatsAppStatus(orgId);
    if (!targetSessionId) {
      targetSessionId = isDevice2
        ? (orgId ? `org_${orgId}_device_2` : "device_2")
        : (orgId ? `org_${orgId}` : "device_1");
    }
    const statusData = statusDataList.find((s) => s.sessionId === targetSessionId) || statusDataList[0] || {};
    res.status(200).json({ qrCode: statusData.qrCode || "", sessionId: targetSessionId });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all WhatsApp conversations
// @route   GET /api/whatsapp/conversations
// @access  Public
export const getConversations = async (req, res) => {
  try {
    const { role, name, userId } = req.query;
    const { ConversationModel } = getModels(req);

    const isSalesRep =
      role === "Sales Representative" ||
      role === "sales person" ||
      req.user?.role === "sales person";
    const effectiveUserId = userId || req.user?._id || req.userTokenData?.id;

    const populateOptions = { path: "leadId" };

    if (isSalesRep && (effectiveUserId || name)) {
      const matchArray = [];
      if (effectiveUserId) {
        matchArray.push(String(effectiveUserId));
        if (mongoose.Types.ObjectId.isValid(effectiveUserId)) {
          matchArray.push(new mongoose.Types.ObjectId(effectiveUserId));
        }
      }
      if (name) {
        matchArray.push(new RegExp("^" + name + "$", "i"));
      }
      populateOptions.match = {
        assignedTo: matchArray.length === 1 ? matchArray[0] : { $in: matchArray },
      };
    }

    let conversations = await ConversationModel.find()
      .populate(populateOptions)
      .sort({ lastMessageTime: -1 });

    // Filter out conversations where leadId is null (due to population match failure)
    if (isSalesRep && (effectiveUserId || name)) {
      conversations = conversations.filter((c) => c.leadId != null);
    }

    res.status(200).json(conversations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get messages for a specific lead
// @route   GET /api/whatsapp/conversation/:leadId
// @access  Public
export const getMessages = async (req, res) => {
  try {
    const { leadId } = req.params;
    if (!leadId) {
      return res.status(400).json({ message: "leadId is required." });
    }

    const { ConversationModel, MessageModel } = getModels(req);

    // Reset unread count for this conversation since the agent is loading it
    await ConversationModel.findOneAndUpdate({ leadId }, { unreadCount: 0 });

    const messages = await MessageModel.find({ leadId }).sort({ timestamp: 1 });
    res.status(200).json(messages);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Send manual WhatsApp message
// @route   POST /api/whatsapp/message/send
// @access  Protected
export const sendMessage = async (req, res) => {
  try {
    const { leadId, text, senderName } = req.body;
    if (!leadId || !text) {
      return res
        .status(400)
        .json({ message: "leadId and text are required fields." });
    }

    const orgId = req.user?.organizationId
      ? req.user.organizationId.toString()
      : req.organization?._id
        ? req.organization._id.toString()
        : null;

    let targetSessionId = req.body.sessionId;
    if (orgId) {
      let lineLimit = 1;
      try {
        const { Organization } = getMasterModels();
        const org = await Organization.findById(orgId).select("whatsappLineLimit").lean();
        if (org) lineLimit = org.whatsappLineLimit || 1;
      } catch (e) {}

      if (!targetSessionId) {
        targetSessionId = req.body.device === 2 && lineLimit >= 2 ? `org_${orgId}_device_2` : `org_${orgId}`;
      } else if (targetSessionId.includes("device_2") && lineLimit < 2) {
        targetSessionId = `org_${orgId}`;
      }
    }

    const messageRecord = await sendMessageFromCRM(
      leadId,
      text,
      senderName || req.user?.name || "Agent",
      {
        organizationId: orgId,
        tenantModels: req.tenantModels,
        sessionId: targetSessionId,
      },
    );
    res.status(200).json(messageRecord);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Toggle AI status for a lead
// @route   POST /api/whatsapp/ai/toggle
// @access  Public
export const toggleAI = async (req, res) => {
  try {
    const { leadId, aiEnabled } = req.body;
    if (leadId === undefined || aiEnabled === undefined) {
      return res
        .status(400)
        .json({ message: "leadId and aiEnabled are required fields." });
    }

    const { LeadModel } = getModels(req);

    // Build update payload
    const updatePayload = { aiEnabled };
    // When enabling AI, also clear any active 5-minute pause
    if (aiEnabled) {
      updatePayload.aiPausedUntil = null;
    }

    const lead = await LeadModel.findByIdAndUpdate(
      leadId,
      updatePayload,
      { new: true },
    );

    if (!lead) {
      return res.status(404).json({ message: "Lead not found" });
    }

    // Cancel the in-memory pause timer if enabling AI
    if (aiEnabled) {
      try {
        const orgId = req.user?.organizationId || req.organization?._id;
        await clearAIPauseForLead(leadId, req.tenantModels, orgId);
      } catch (clearErr) {
        console.warn("Error clearing AI pause timer:", clearErr.message);
      }
    }

    res.status(200).json({
      message: `AI response state set to ${aiEnabled} for ${lead.name}`,
      lead,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Test AI Response without WhatsApp
// @route   POST /api/whatsapp/test-ai
// @access  Public
export const testAI = async (req, res) => {
  try {
    const { message, leadId, reset } = req.body;
    const { LeadModel, MessageModel } = getModels(req);

    if (!message && !reset) {
      return res.status(400).json({ message: "message is required." });
    }

    let lead;
    if (leadId) {
      lead = await LeadModel.findById(leadId);
    } else {
      // Find or create dummy lead
      lead = await LeadModel.findOne({ phone: "0000000000" });
      if (!lead) {
        lead = await LeadModel.create({
          name: "Test User",
          phone: "0000000000",
          service: "General Enquiry",
          source: "Manual Entry",
        });
      }
    }

    if (!lead) {
      return res.status(404).json({ message: "Lead not found" });
    }

    if (reset) {
      await MessageModel.deleteMany({ leadId: lead._id });
      const resetQual = {
        city: "",
        intent: "",
        urgency: "Medium",
        interestScore: 0,
        preferredCallDate: "",
        preferredCallTime: "",
      };
      const configuredFields = req.organization?.aiSettings?.qualificationFields;
      if (Array.isArray(configuredFields) && configuredFields.length > 0) {
        for (const f of configuredFields) {
          if (f.key) resetQual[f.key] = "";
        }
      }
      await LeadModel.findByIdAndUpdate(lead._id, {
        aiQualification: resetQual,
        aiEnabled: true,
        disableAI: false,
      });

      try {
        const FollowupModel =
          req.tenantModels?.Followup || (await import("../models/Followup.js")).default;
        await FollowupModel.deleteMany({ leadId: lead._id });
      } catch (err) {
        console.warn("Error cleaning up test lead followups:", err.message);
      }

      return res.status(200).json({ message: "Test lead reset successfully." });
    }

    const { generateAIResponse } = await import("../ai/aiService.js");

    // Save incoming
    const incoming = await MessageModel.create({
      messageId: `test-in-${Date.now()}`,
      sender: lead.phone,
      leadId: lead._id,
      text: message,
      direction: "incoming",
      timestamp: new Date(),
    });

    const aiResponseText = await generateAIResponse(
      lead._id,
      message,
      req.tenantModels,
      req.organization,
    );

    // Save outgoing
    const outgoing = await MessageModel.create({
      messageId: `test-out-${Date.now()}`,
      sender: "AI Agent",
      leadId: lead._id,
      text: aiResponseText,
      direction: "outgoing",
      timestamp: new Date(),
    });

    const updatedLead = await LeadModel.findById(lead._id);

    res.status(200).json({
      incoming,
      outgoing,
      aiQualification: updatedLead.aiQualification,
      qualificationFields: req.organization?.aiSettings?.qualificationFields || [],
      leadId: lead._id,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getTestAIHistory = async (req, res) => {
  try {
    const { LeadModel, MessageModel } = getModels(req);
    let lead = await LeadModel.findOne({ phone: "0000000000" });
    if (!lead) {
      lead = await LeadModel.create({
        name: "Test User",
        phone: "0000000000",
        service: "General Enquiry",
        source: "Manual Entry",
      });
    }

    const messages = await MessageModel.find({ leadId: lead._id }).sort({
      timestamp: 1,
    });

    res.status(200).json({
      leadId: lead._id,
      aiQualification: lead.aiQualification,
      qualificationFields: req.organization?.aiSettings?.qualificationFields || [],
      messages: messages.map((m) => ({
        text: m.text,
        role: m.direction === "incoming" ? "user" : "ai",
      })),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getGlobalSettings = async (req, res) => {
  try {
    const settings = await getSystemSettings(req.tenantModels);
    const orgId = req.user?.organizationId || req.organization?._id;
    let orgData = null;
    if (orgId) {
      const { Organization } = getMasterModels();
      orgData = await Organization.findById(orgId).select("name aiSettings").lean();
    }
    const companyName = orgData?.aiSettings?.companyName || orgData?.name || "";
    const primaryService = orgData?.aiSettings?.services?.[0]?.name || "";
    const effectiveTemplate =
      settings.welcomeMessageTemplate || orgData?.aiSettings?.welcomeMessageTemplate || "";
    const effectiveFallbackService =
      settings.welcomeMessageFallbackService || orgData?.aiSettings?.welcomeMessageFallbackService || "";

    res.status(200).json({
      success: true,
      data: {
        ...settings,
        welcomeMessageTemplate: effectiveTemplate,
        welcomeMessageFallbackService: effectiveFallbackService,
        companyName,
        primaryService,
        defaultTemplate: DEFAULT_WELCOME_MESSAGE_TEMPLATE,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const updateGlobalSettings = async (req, res) => {
  try {
    const updates = req.body || {};
    const updatedBy = req.user?.name || "Dashboard User";
    const orgId = req.user?.organizationId
      ? req.user.organizationId.toString()
      : req.organization?._id
        ? req.organization._id.toString()
        : null;
    const settings = await updateSystemSettings(updates, updatedBy, req.tenantModels, orgId);
    res.status(200).json({ success: true, data: settings });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
