import mongoose from "mongoose";
import Lead from "../models/Lead.js";
import Message from "../models/Message.js";
import Conversation from "../models/Conversation.js";
import WhatsAppSession from "../models/WhatsAppSession.js";
import User from "../models/User.js";
import {
  connectWhatsApp,
  logoutWhatsApp,
  getWhatsAppStatus,
  sendMessageFromCRM,
  getSystemSettings,
  updateSystemSettings,
  DEFAULT_WELCOME_MESSAGE_TEMPLATE,
  clearAIPauseForLead,
  resolveSessionId,
} from "../whatsapp/whatsappService.js";
import { getMasterModels } from "../services/tenantManager.js";

const getModels = (req) => ({
  LeadModel: req.tenantModels?.Lead || Lead,
  MessageModel: req.tenantModels?.Message || Message,
  ConversationModel: req.tenantModels?.Conversation || Conversation,
  WhatsAppSessionModel: req.tenantModels?.WhatsAppSession || WhatsAppSession,
  UserModel: req.tenantModels?.User || User,
});

const isLeadAssignedToUser = (lead, user) => {
  if (!lead || !user) return false;
  const userIdStr = (user._id || user.id || "").toString();
  const userName = user.name || "";
  const assigned = lead.assignedTo;
  if (!assigned) return false;
  if (typeof assigned === "object") {
    const assignedId = (assigned._id || assigned.id || "").toString();
    const assignedName = assigned.name || "";
    return (userIdStr && assignedId === userIdStr) || (userName && assignedName === userName);
  }
  const assignedStr = assigned.toString();
  return (userIdStr && assignedStr === userIdStr) || (userName && assignedStr === userName);
};

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

    // ================================================================
    // SALES REP PERSONAL SESSION GATE
    // Sales reps always connect to their own personal session.
    // They cannot choose a device number or sessionId — it's auto-set.
    // ================================================================
    if (req.user?.role === "sales person") {
      const repUserId = req.user._id.toString();
      const lineNumber = Number(req.body.lineNumber || req.body.device || 1) === 2 ? 2 : 1;
      const targetSessionId = resolveSessionId(orgId, repUserId, lineNumber);
      try {
        const SessionModel = req.tenantModels?.WhatsAppSession || WhatsAppSession;
        await SessionModel.findOneAndUpdate(
          { sessionId: targetSessionId },
          { $set: { organizationId: orgId, userId: repUserId, lineNumber, errorMessage: "" } },
          { upsert: true, setDefaultsOnInsert: true },
        );
      } catch (e) {}

      connectWhatsApp({
        sessionId: targetSessionId,
        organizationId: orgId,
        tenantDbName,
        lineNumber,
      });
      return res.status(200).json({
        message: `WhatsApp Account ${lineNumber} connection started. Please scan the QR code when it appears.`,
        sessionId: targetSessionId,
        lineNumber,
      });
    }
    // ================================================================
    // END SALES REP GATE — falls through to existing admin logic below
    // ================================================================

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
    const { WhatsAppSessionModel, UserModel, ConversationModel, LeadModel } = getModels(req);
    const orgId = req.user?.organizationId
      ? req.user.organizationId.toString()
      : req.organization?._id
        ? req.organization._id.toString()
        : null;

    const tenantDbName = req.tenantDbName || req.user?.tenantDbName;

    // ================================================================
    // SALES REP: Return both independently authenticated line slots.
    // ================================================================
    if (req.user?.role === "sales person") {
      const repUserId = req.user._id.toString();
      const user = await UserModel.findById(repUserId).select("phone whatsappLine1Phone whatsappLine2Phone").lean();
      const sessionIds = [resolveSessionId(orgId, repUserId, 1), resolveSessionId(orgId, repUserId, 2)];
      const memStatuses = getWhatsAppStatus(orgId);
      const dbSessions = await WhatsAppSessionModel.find({ sessionId: { $in: sessionIds } }).lean();
      const assignedLeadIds = await LeadModel.find({
        $or: [
          { assignedTo: repUserId },
          { assignedTo: req.user._id },
          ...(req.user.name ? [{ assignedTo: new RegExp(`^${req.user.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") }] : []),
        ],
      }).distinct("_id");
      const unreadRows = await ConversationModel.aggregate([
        { $match: { leadId: { $in: assignedLeadIds } } },
        { $group: { _id: null,
          line1: { $sum: { $ifNull: ["$unreadCountByLine.line1", { $cond: [{ $eq: ["$lastInboundLine", 1] }, "$unreadCount", 0] }] } },
          line2: { $sum: { $ifNull: ["$unreadCountByLine.line2", { $cond: [{ $eq: ["$lastInboundLine", 2] }, "$unreadCount", 0] }] } },
        } },
      ]);
      const unreadCounts = { 1: unreadRows[0]?.line1 || 0, 2: unreadRows[0]?.line2 || 0 };
      const repSessions = sessionIds.map((sessionId, index) => {
        const lineNumber = index + 1;
        const memSession = memStatuses.find((session) => session.sessionId === sessionId) || {};
        const dbSession = dbSessions.find((session) => session.sessionId === sessionId);
        let status = memSession.status || "disconnected";
        if (!memSession.hasSocket && dbSession?.status === "connected" && status === "disconnected") {
          status = "connecting";
          connectWhatsApp({ sessionId, organizationId: orgId, tenantDbName, lineNumber }).catch(() => {});
        } else if (!memSession.status && ["connecting", "qr"].includes(dbSession?.status)) {
          WhatsAppSessionModel.updateOne({ sessionId }, { $set: { status: "disconnected", qrCode: "" } }).catch(() => {});
        }
        return {
          sessionId, organizationId: orgId, lineNumber, status,
          qrCode: status === "qr" ? memSession.qrCode || dbSession?.qrCode || "" : "",
          connectedPhone: memSession.connectedPhone || dbSession?.connectedPhone || "",
          connectedName: memSession.connectedName || dbSession?.connectedName || "",
          isPrimary: lineNumber === 1, isRepSession: true,
          label: `WhatsApp Account ${lineNumber}`,
          displayPhone: lineNumber === 1 ? user?.whatsappLine1Phone || user?.phone || "" : user?.whatsappLine2Phone || "",
          errorMessage: dbSession?.errorMessage || "",
        };
      });

      return res.status(200).json({
        sessions: repSessions,
        isRepSession: true,
        whatsappLineLimit: 2,
        unreadCountLine1: unreadCounts[1],
        unreadCountLine2: unreadCounts[2],
      });
    }
    // ================================================================
    // END SALES REP PATH — falls through to existing admin logic below
    // ================================================================

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
          lineNumber: index + 1,
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

    let primaryStatus = "disconnected";
    if (primaryMem?.status) {
      primaryStatus = primaryMem.status;
    } else if (primaryDb?.status === "connected") {
      primaryStatus = "connecting";
    } else {
      primaryStatus = "disconnected";
      if (primaryDb?.status === "connecting" || primaryDb?.status === "qr") {
        WhatsAppSessionModel.updateOne(
          { sessionId: primarySessionId },
          { $set: { status: "disconnected", qrCode: "" } }
        ).catch(() => {});
      }
    }

    result.push({
      sessionId: primarySessionId,
      organizationId: orgId,
      status: primaryStatus,
      qrCode: primaryStatus === "qr" ? primaryMem?.qrCode || primaryDb?.qrCode || "" : "",
      connectedPhone: primaryMem?.connectedPhone || primaryDb?.connectedPhone || "",
      connectedName: primaryMem?.connectedName || primaryDb?.connectedName || "",
      lineNumber: 1,
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

      let secondaryStatus = "disconnected";
      if (secondaryMem?.status) {
        secondaryStatus = secondaryMem.status;
      } else if (secondaryDb?.status === "connected") {
        secondaryStatus = "connecting";
      } else {
        secondaryStatus = "disconnected";
        if (secondaryDb?.status === "connecting" || secondaryDb?.status === "qr") {
          WhatsAppSessionModel.updateOne(
            { sessionId: secondarySessionId },
            { $set: { status: "disconnected", qrCode: "" } }
          ).catch(() => {});
        }
      }

      result.push({
        sessionId: secondarySessionId,
        organizationId: orgId,
        status: secondaryStatus,
        qrCode: secondaryStatus === "qr" ? secondaryMem?.qrCode || secondaryDb?.qrCode || "" : "",
        connectedPhone: secondaryMem?.connectedPhone || secondaryDb?.connectedPhone || "",
        connectedName: secondaryMem?.connectedName || secondaryDb?.connectedName || "",
        lineNumber: 2,
        isPrimary: false,
        label: "Device 2 (Secondary)",
      });
    }

    // Compute org-wide line unread counts for manager sidebar badges
    const unreadRows = await ConversationModel.aggregate([
      { $group: {
        _id: null,
        line1: { $sum: { $ifNull: ["$unreadCountByLine.line1",
          { $cond: [{ $eq: ["$lastInboundLine", 1] }, "$unreadCount", 0] }] } },
        line2: { $sum: { $ifNull: ["$unreadCountByLine.line2",
          { $cond: [{ $eq: ["$lastInboundLine", 2] }, "$unreadCount", 0] }] } },
      }},
    ]);

    // Include the line limit and unread counts in the response for frontend adaptation
    res.status(200).json({
      sessions: result,
      whatsappLineLimit: lineLimit,
      unreadCountLine1: unreadRows[0]?.line1 || 0,
      unreadCountLine2: unreadRows[0]?.line2 || 0,
    });
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

    // ================================================================
    // SALES REP: Only allow logout of their own personal session
    // ================================================================
    if (req.user?.role === "sales person") {
      const repUserId = req.user._id.toString();
      const targetLine = Number(req.body.lineNumber) === 2 || req.body.sessionId?.endsWith("_line_2") ? 2 : 1;
      const targetSessionId = resolveSessionId(orgId, repUserId, targetLine);
      await logoutWhatsApp(targetSessionId);
      return res.status(200).json({
        message: `WhatsApp Account ${targetLine} disconnected successfully.`,
        sessionId: targetSessionId,
        lineNumber: targetLine,
      });
    }
    // ================================================================

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
    if (orgId && mongoose.connection.readyState === 1) {
      try {
        const { Organization } = getMasterModels();
        const org = await Organization.findById(orgId).select("whatsappLineLimit").lean();
        if (org) lineLimit = org.whatsappLineLimit || 1;
      } catch (e) {}
    }

    let targetSessionId = req.query.sessionId;

    // ================================================================
    // QR SESSION OWNERSHIP ENFORCEMENT
    // Sales reps can only access their own session QR code.
    // Admins can only access organization line QR codes.
    // ================================================================
    if (req.user?.role === "sales person") {
      const lineNumber = Number(req.query.lineNumber || req.query.device) === 2 ? 2 : 1;
      const repSessionId = resolveSessionId(orgId, req.user._id.toString(), lineNumber);
      if (req.query.sessionId && req.query.sessionId !== repSessionId) {
        return res.status(403).json({
          message:
            "Access denied. Sales representatives can only access their own WhatsApp session QR code.",
          qrCode: "",
        });
      }
      targetSessionId = repSessionId;
    } else if (req.user?.role === "sales manager" || req.user?.role === "super_admin") {
      if (targetSessionId && targetSessionId.includes("_user_")) {
        return res.status(403).json({
          message:
            "Administrators can only generate QR codes for organization lines.",
          qrCode: "",
        });
      }
    }

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
    const statusData = statusDataList.find((s) => s.sessionId === targetSessionId) || {};
    let qrCode = statusData.qrCode || "";

    // Fallback to database persisted QR code if memory QR is not set
    if (!qrCode && targetSessionId) {
      try {
        const { WhatsAppSessionModel } = getModels(req);
        const dbSession = await WhatsAppSessionModel.findOne({ sessionId: targetSessionId })
          .select("qrCode status")
          .lean();
        if (dbSession?.status === "qr" && dbSession?.qrCode) {
          qrCode = dbSession.qrCode;
        }
      } catch (dbErr) {}
    }

    res.status(200).json({ qrCode, sessionId: targetSessionId });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all WhatsApp conversations
// @route   GET /api/whatsapp/conversations
// @access  Public
export const getConversations = async (req, res) => {
  try {
    const { ConversationModel, MessageModel } = getModels(req);
    const userRole = req.user?.role;
    const isSalesRep = userRole === "sales person";
    const lineNumber = Number(req.query.lineNumber);

    const populateOptions = { path: "leadId" };

    if (isSalesRep) {
      // Security: Strictly enforce authenticated user's ID/name. Ignore req.query overrides.
      const matchArray = [
        String(req.user._id),
        new mongoose.Types.ObjectId(req.user._id),
      ];
      if (req.user.name) {
        matchArray.push(new RegExp("^" + req.user.name.trim() + "$", "i"));
      }
      populateOptions.match = {
        assignedTo: { $in: matchArray },
      };
    } else if (req.query.userId || req.query.name) {
      // Admins and managers can filter by rep
      const matchArray = [];
      if (req.query.userId) {
        matchArray.push(String(req.query.userId));
        if (mongoose.Types.ObjectId.isValid(req.query.userId)) {
          matchArray.push(new mongoose.Types.ObjectId(req.query.userId));
        }
      }
      if (req.query.name) {
        matchArray.push(new RegExp("^" + req.query.name.trim() + "$", "i"));
      }
      populateOptions.match = {
        assignedTo: matchArray.length === 1 ? matchArray[0] : { $in: matchArray },
      };
    }

    let conversationFilter = {};
    if ([1, 2].includes(lineNumber)) {
      const orgId = req.user?.organizationId?.toString() || req.organization?._id?.toString();
      const orgSessionId = lineNumber === 1 ? `org_${orgId}` : `org_${orgId}_device_2`;
      const repPattern = orgId
        ? lineNumber === 1
          ? new RegExp(`^org_${orgId}_user_[a-fA-F0-9]{24}(?:_line_1)?$`)
          : new RegExp(`^org_${orgId}_user_[a-fA-F0-9]{24}_line_2$`)
        : new RegExp(`^user_[a-fA-F0-9]{24}_line_${lineNumber}$`);

      const matchingLeadIds = await MessageModel.distinct("leadId", {
        $or: [
          { sessionId: orgSessionId },
          { sessionId: repPattern },
          { lineNumber },
        ],
      });

      conversationFilter = {
        $or: [
          { activeLines: lineNumber },
          { lastInboundLine: lineNumber },
          { lastOutboundLine: lineNumber },
          { lastInboundSessionId: orgSessionId },
          { lastOutboundSessionId: orgSessionId },
          { lastInboundSessionId: repPattern },
          { lastOutboundSessionId: repPattern },
          { leadId: { $in: matchingLeadIds } },
        ],
      };
    }
    let conversations = await ConversationModel.find(conversationFilter)
      .populate(populateOptions)
      .sort({ lastMessageTime: -1 });

    // Filter out conversations where leadId is null (due to population match failure)
    if (isSalesRep || req.query.userId || req.query.name) {
      conversations = conversations.filter((c) => c.leadId != null);
    }

    if ([1, 2].includes(lineNumber)) {
      conversations.forEach((conversation) => {
        const lineUnread = conversation.unreadCountByLine?.[`line${lineNumber}`];
        conversation.unreadCount = lineUnread ?? (conversation.lastInboundLine === lineNumber ? conversation.unreadCount : 0);
      });
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
    const lineNumber = Number(req.query.lineNumber);
    if (!leadId) {
      return res.status(400).json({ message: "leadId is required." });
    }

    const { ConversationModel, MessageModel, LeadModel } = getModels(req);

    // Security: Check lead existence and sales rep assignment
    const lead = await LeadModel.findById(leadId).select("assignedTo").lean();
    if (!lead) {
      return res.status(404).json({ message: "Lead not found." });
    }

    if (req.user?.role === "sales person") {
      const repId = req.user._id.toString();
      const repName = req.user.name;
      const isAssigned =
        lead.assignedTo?.toString() === repId ||
        (repName && lead.assignedTo === repName);
      if (!isAssigned) {
        return res.status(403).json({
          message: "Access denied. You are not assigned to this conversation.",
        });
      }
    }

    // Clear only this line's unread count so the other account badge remains intact.
    if (req.user?.role === "sales person" && [1, 2].includes(lineNumber)) {
      const conversation = await ConversationModel.findOne({ leadId }).lean();
      const lineKey = `line${lineNumber}`;
      const previousLineUnread = conversation?.unreadCountByLine?.[lineKey] ??
        (conversation?.lastInboundLine === lineNumber ? conversation?.unreadCount || 0 : 0);
      await ConversationModel.findOneAndUpdate({ leadId }, {
        $set: {
          [`unreadCountByLine.${lineKey}`]: 0,
          unreadCount: Math.max(0, (conversation?.unreadCount || 0) - previousLineUnread),
        },
      });
    } else {
      await ConversationModel.findOneAndUpdate({ leadId }, { unreadCount: 0 });
    }

    const messageFilter = { leadId };
    if (req.query.strictLine === "true" && [1, 2].includes(lineNumber)) messageFilter.lineNumber = lineNumber;
    const messages = await MessageModel.find(messageFilter).sort({ timestamp: 1 });
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

    const { LeadModel, MessageModel, UserModel } = getModels(req);
    const lead = await LeadModel.findById(leadId).lean();
    if (!lead) {
      return res.status(404).json({ message: "Lead not found." });
    }

    const senderRole = req.user?.role;
    const orgId = req.user?.organizationId
      ? req.user.organizationId.toString()
      : req.organization?._id
        ? req.organization._id.toString()
        : null;

    // Check if conversation/lead belongs to a sales rep in the database
    let isRepOwned = false;
    if (lead.assignedTo && lead.assignedTo !== "Unassigned") {
      if (mongoose.Types.ObjectId.isValid(lead.assignedTo)) {
        const assignedUser = await UserModel.findById(lead.assignedTo).select("role").lean();
        if (assignedUser?.role === "sales person") isRepOwned = true;
      } else if (typeof lead.assignedTo === "string") {
        const assignedUser = await UserModel.findOne({ name: lead.assignedTo }).select("role").lean();
        if (assignedUser?.role === "sales person") isRepOwned = true;
      }
    }
    if (!isRepOwned) {
      const repMessage = await MessageModel.findOne({
        leadId,
        $or: [
          { salesRepId: { $ne: null } },
          { sessionId: { $regex: "_user_" } },
        ],
      }).select("_id").lean();
      if (repMessage) isRepOwned = true;
    }

    // ================================================================
    // ADMIN VIEW-ONLY ENFORCEMENT
    // Admins and Sales Managers have strictly VIEW-ONLY access to
    // sales representative conversations, regardless of request payload.
    // ================================================================
    if (senderRole === "sales manager" || senderRole === "super_admin") {
      if (isRepOwned) {
        return res.status(403).json({
          message:
            "Administrators have View-Only access to sales representative WhatsApp conversations. Only the assigned Sales Representative can send messages.",
        });
      }
    }

    // ================================================================
    // SALES REP ASSIGNMENT ENFORCEMENT
    // Sales reps can ONLY send messages to leads assigned to them.
    // ================================================================
    let targetSessionId = req.body.sessionId;
    if (senderRole === "sales person") {
      const repId = req.user._id.toString();
      const repName = req.user.name;
      const isAssigned =
        lead.assignedTo?.toString() === repId ||
        (repName && lead.assignedTo === repName);

      if (!isAssigned) {
        return res.status(403).json({
          message:
            "Access denied. You are only authorized to send messages to leads assigned to you.",
        });
      }

      const lineNumber = Number(req.body.lineNumber);
      if (![1, 2].includes(lineNumber)) {
        return res.status(400).json({ message: "lineNumber must be 1 or 2." });
      }
      targetSessionId = resolveSessionId(orgId, repId, lineNumber);
      const targetStatus = getWhatsAppStatus(orgId).find((session) => session.sessionId === targetSessionId);
      if (targetStatus?.status !== "connected") {
        return res.status(400).json({
          message: `WhatsApp Account ${lineNumber} is offline. Reconnect it or switch accounts.`,
          lineDisconnected: true,
          attemptedLine: lineNumber,
        });
      }
    } else if (orgId) {
      let lineLimit = 1;
      try {
        const { Organization } = getMasterModels();
        const org = await Organization.findById(orgId).select("whatsappLineLimit").lean();
        if (org) lineLimit = org.whatsappLineLimit || 1;
      } catch (e) {}

      const requestedLine = Number(req.body.lineNumber) || (req.body.device === 2 ? 2 : 1);
      if (!targetSessionId) {
        if (requestedLine === 2 && lineLimit >= 2) {
          targetSessionId = `org_${orgId}_device_2`;
        } else if (requestedLine === 2 && lineLimit < 2) {
          return res.status(403).json({
            message: "Your organization plan allows only 1 WhatsApp channel. Upgrade to send from Account 2.",
          });
        } else {
          targetSessionId = `org_${orgId}`;
        }
      } else if (targetSessionId.includes("device_2") && lineLimit < 2) {
        return res.status(403).json({
          message: "Your organization plan allows only 1 WhatsApp channel. Upgrade to send from Account 2.",
        });
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
        lineNumber: senderRole === "sales person" ? Number(req.body.lineNumber) : (targetSessionId?.includes("device_2") ? 2 : 1),
        salesRepId: senderRole === "sales person" ? req.user._id : null,
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

    const lead = await LeadModel.findById(leadId);
    if (!lead) {
      return res.status(404).json({ message: "Lead not found" });
    }

    // Role-based / lead assignment check: sales reps can only toggle AI for assigned leads
    if (req.user?.role === "sales person" && !req.user?.isOrgOwner) {
      if (!isLeadAssignedToUser(lead, req.user)) {
        return res.status(403).json({
          message: "Access denied: You are not assigned to this lead.",
        });
      }
    }

    lead.aiEnabled = aiEnabled;
    if (aiEnabled) {
      lead.aiPausedUntil = null;
    }
    await lead.save();

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
    // Role check: sales reps cannot access test AI or reset leads
    if (req.user?.role === "sales person" && !req.user?.isOrgOwner) {
      return res.status(403).json({
        message: "Access denied: Only managers and administrators can access AI testing.",
      });
    }

    const { message, leadId, reset } = req.body;
    const { LeadModel, MessageModel } = getModels(req);

    if (!message && !reset) {
      return res.status(400).json({ message: "message is required." });
    }

    let lead;
    if (leadId) {
      lead = await LeadModel.findById(leadId);
      if (!lead) {
        return res.status(404).json({ message: "Lead not found" });
      }

      // Check lead assignment/ownership if caller is sales rep
      if (req.user?.role === "sales person" && !req.user?.isOrgOwner) {
        if (!isLeadAssignedToUser(lead, req.user)) {
          return res.status(403).json({
            message: "Access denied: You are not assigned to this lead.",
          });
        }
        if (reset) {
          return res.status(403).json({
            message: "Access denied: Sales representatives cannot reset lead data.",
          });
        }
      }
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
    if (req.user?.role === "sales person" && !req.user?.isOrgOwner) {
      return res.status(403).json({
        message: "Access denied: Only managers and administrators can access AI testing.",
      });
    }

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
    if (req.user?.role === "sales person" && !req.user?.isOrgOwner) {
      return res.status(403).json({
        success: false,
        message: "Access denied: Only managers or administrators can update global WhatsApp settings.",
      });
    }

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

// @desc    AI Chat Summarization — analyze and summarize a lead's WhatsApp conversation
// @route   POST /api/whatsapp/conversation/:leadId/summarize
// @access  Protected
export const summarizeConversation = async (req, res) => {
  try {
    const { leadId } = req.params;
    const { forceRefresh } = req.body;

    if (!leadId) {
      return res.status(400).json({ success: false, message: "leadId is required." });
    }

    const { ConversationModel, LeadModel } = getModels(req);

    // Security: Check lead existence and sales rep assignment
    const lead = await LeadModel.findById(leadId).select("assignedTo").lean();
    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found." });
    }

    if (req.user?.role === "sales person") {
      const repId = req.user._id.toString();
      const repName = req.user.name;
      const isAssigned =
        lead.assignedTo?.toString() === repId ||
        (repName && lead.assignedTo === repName);
      if (!isAssigned) {
        return res.status(403).json({
          success: false,
          message: "Access denied. You are not authorized to summarize this conversation.",
        });
      }
    }

    // Force refresh: clear any existing cached summary so the service re-generates
    if (forceRefresh) {
      await ConversationModel.findOneAndUpdate(
        { leadId },
        { $unset: { chatSummary: 1 } }
      );
    }

    const { summarizeChatConversation } = await import("../ai/aiService.js");
    const summary = await summarizeChatConversation({
      leadId,
      tenantModels: req.tenantModels,
      organization: req.organization,
    });

    res.status(200).json({ success: true, data: summary });
  } catch (error) {
    console.error("[WhatsApp] summarizeConversation error:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get WhatsApp connection status for all sales reps (Admin/Manager overview)
// @route   GET /api/whatsapp/team-status
// @access  Protected (Admin / Sales Manager only)
export const getTeamWhatsAppStatuses = async (req, res) => {
  try {
    // Only admins and managers can access this
    if (req.user?.role === "sales person") {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    const orgId = req.user?.organizationId?.toString() || req.organization?._id?.toString();
    if (!orgId) {
      return res.status(400).json({ success: false, message: "Organization context is required." });
    }

    const { UserModel, WhatsAppSessionModel } = getModels(req);

    // Fetch all active sales reps
    const reps = await UserModel.find({ role: "sales person", status: "active" })
      .select("name phone email whatsappLine1Phone whatsappLine2Phone _id")
      .lean();

    const allMemSessions = getWhatsAppStatus(orgId);

    const result = await Promise.all(
      reps.map(async (rep) => {
        const lines = await Promise.all([1, 2].map(async (lineNumber) => {
          const repSessionId = resolveSessionId(orgId, rep._id.toString(), lineNumber);
          const memSession = allMemSessions.find((session) => session.sessionId === repSessionId) || {};
          const dbSession = await WhatsAppSessionModel.findOne({ sessionId: repSessionId })
            .select("status connectedPhone connectedName updatedAt errorMessage lineNumber")
            .lean();
          return {
            lineNumber, sessionId: repSessionId,
            status: memSession.status || dbSession?.status || "disconnected",
            connectedPhone: memSession.connectedPhone || dbSession?.connectedPhone || "",
            connectedName: memSession.connectedName || dbSession?.connectedName || "",
            displayPhone: lineNumber === 1 ? rep.whatsappLine1Phone || rep.phone || "" : rep.whatsappLine2Phone || "",
            lastSeen: dbSession?.updatedAt || null,
            errorMessage: dbSession?.errorMessage || "",
          };
        }));
        const primary = lines[0];

        return {
          userId: rep._id,
          name: rep.name || "Unknown",
          email: rep.email || "",
          profilePhone: rep.phone || "",
          sessionId: primary.sessionId,
          status: primary.status,
          connectedPhone: primary.connectedPhone,
          connectedName: primary.connectedName,
          lastSeen: primary.lastSeen,
          errorMessage: primary.errorMessage,
          lines,
        };
      })
    );

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[WhatsApp] getTeamWhatsAppStatuses error:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Request WhatsApp pairing code (phone-number linking — alternative to QR scan)
// @route   POST /api/whatsapp/pairing-code
// @access  Protected
export const requestPairingCode = async (req, res) => {
  try {
    const { phoneNumber, device, isSecondary, sessionId: bodySessionId } = req.body;

    // Validate phone: digits only with country code, 10–15 digits total
    if (!phoneNumber) {
      return res.status(400).json({
        message: "A phone number is required to generate a pairing code.",
      });
    }
    const cleanPhone = String(phoneNumber).replace(/\D/g, "");
    if (cleanPhone.length < 10 || cleanPhone.length > 15) {
      return res.status(400).json({
        message:
          "Please enter a valid phone number with country code (e.g. 919876543210). Must be 10–15 digits.",
      });
    }

    const orgId = req.user?.organizationId
      ? req.user.organizationId.toString()
      : req.organization?._id
        ? req.organization._id.toString()
        : null;
    const tenantDbName = req.tenantDbName || req.user?.tenantDbName;

    let targetSessionId;

    // ================================================================
    // SALES REP: Use personal session (line 1 or line 2)
    // ================================================================
    if (req.user?.role === "sales person") {
      const repUserId = req.user._id.toString();
      const repLineNumber = Number(req.body.lineNumber) === 2 ? 2 : 1;
      targetSessionId = resolveSessionId(orgId, repUserId, repLineNumber);

      // Clear any previous error messages for clean retry
      try {
        const SessionModel = req.tenantModels?.WhatsAppSession;
        if (SessionModel) {
          await SessionModel.updateOne(
            { sessionId: targetSessionId },
            { $set: { errorMessage: "", lineNumber: repLineNumber } }
          );
        }
      } catch (e) {}
    } else {
      // ================================================================
      // ADMIN / MANAGER: Use org session
      // ================================================================
      if (!orgId) {
        return res.status(400).json({ message: "Organization context is required." });
      }

      // Determine device: default to primary
      const isDevice2 = device === 2 || isSecondary === true;

      // Check line limit for secondary device
      if (isDevice2) {
        try {
          const { Organization } = getMasterModels();
          const org = await Organization.findById(orgId).select("whatsappLineLimit").lean();
          if (!org || (org.whatsappLineLimit || 1) < 2) {
            return res.status(403).json({
              message:
                "This organization is restricted to a Single WhatsApp Line. Upgrade to Dual Lines to connect a second device.",
            });
          }
        } catch (e) {}
      }

      if (bodySessionId) {
        const allowed = [`org_${orgId}`, `org_${orgId}_device_2`];
        targetSessionId = allowed.includes(bodySessionId)
          ? bodySessionId
          : `org_${orgId}`;
      } else {
        targetSessionId = isDevice2 ? `org_${orgId}_device_2` : `org_${orgId}`;
      }
    }

    // Fire connection in pairing code mode (non-blocking)
    connectWhatsApp({
      sessionId: targetSessionId,
      organizationId: orgId,
      tenantDbName,
      usePairingCode: true,
      pairingPhone: cleanPhone,
    });

    return res.status(200).json({
      message:
        "Pairing code is being generated. It will appear on-screen within a few seconds.",
      sessionId: targetSessionId,
    });
  } catch (error) {
    console.error("[WhatsApp] requestPairingCode error:", error.message);
    res.status(500).json({ message: error.message });
  }
};

