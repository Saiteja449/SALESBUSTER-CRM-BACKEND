import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mime from "mime-types";

import Lead from "../models/Lead.js";
import Message from "../models/Message.js";
import Conversation from "../models/Conversation.js";
import WhatsAppSession from "../models/WhatsAppSession.js";
import User from "../models/User.js";
import AssignmentState from "../models/AssignmentState.js";
import Notification from "../models/Notification.js";
import SystemSettings from "../models/SystemSettings.js";

import { getIO } from "../socket/socket.js";
import { generateAIResponse } from "../ai/aiService.js";
import { getTenantModels, getMasterModels } from "../services/tenantManager.js";
import { sendTextMessage } from "../services/whatsappCloudService.js";
import { decryptApiKey } from "../utils/encryption.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadDir = path.join(__dirname, "..", "uploads");
const logsDir = path.join(__dirname, "..", "logs");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logWhatsAppEvent = (message) => {
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const timestamp = now.toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  const logFileName = `whatsapp-${dateStr}.log`;

  fs.appendFile(path.join(logsDir, logFileName), logMessage, (err) => {
    if (err) console.error(`Failed to write to ${logFileName}:`, err);
  });
};

export const sessions = {}; // map of sessionId -> { sock, status, qrCode, connectedPhone, connectedName, organizationId, tenantDbName }

// AI Pause Management — tracks 5-minute snooze timers per lead
const aiPauseTimers = {}; // leadIdStr -> setTimeout handle
const automatedSendInProgress = new Set();

export const normalizePhone = (jid) => {
  if (!jid) return "";
  const clean = jid.split("@")[0].split(":")[0];
  return clean.replace(/\D/g, "");
};

/**
 * Strict Phone Number Matching for Sales Rep Verification
 * Prevents account sharing and cross-country code false matches.
 */
export const verifyPhoneNumberMatch = (scannedJidOrPhone, profilePhone) => {
  if (!scannedJidOrPhone || !profilePhone) return false;
  const scanned = normalizePhone(scannedJidOrPhone);
  const rawProfile = String(profilePhone).trim();
  const profileDigits = rawProfile.replace(/\D/g, "");
  if (!scanned || !profileDigits) return false;

  // If profile phone was provided with country code (+ or >10 digits): strict full match
  if (rawProfile.startsWith("+") || profileDigits.length > 10) {
    return scanned === profileDigits;
  }
  // If profile phone is 10 digits without country code, match default '91' prefix or exact digits
  if (profileDigits.length === 10) {
    return scanned === `91${profileDigits}` || scanned === profileDigits;
  }
  return scanned === profileDigits;
};

/**
 * Resolves tenant-specific models for a given sessionId
 */
export const getModelsForSession = async (sessionId) => {
  const sessionData = sessions[sessionId];
  if (sessionData?.tenantDbName) {
    return getTenantModels(sessionData.tenantDbName);
  }
  if (sessionData?.organizationId) {
    try {
      const { Organization } = getMasterModels();
      const org = await Organization.findById(sessionData.organizationId);
      if (org && org.tenantDbName) {
        sessionData.tenantDbName = org.tenantDbName;
        return getTenantModels(org.tenantDbName);
      }
    } catch (err) {
      console.error(`[WhatsApp] Failed to resolve tenantDbName for org ${sessionData.organizationId}:`, err);
    }
  }
  // Try to parse orgId from standard naming convention "org_<orgId>" (e.g. org_<orgId> or org_<orgId>_device_2)
  if (sessionId && sessionId.startsWith("org_")) {
    const match = sessionId.match(/^org_([a-fA-F0-9]{24})/);
    const orgId = match ? match[1] : sessionId.replace("org_", "");
    try {
      const { Organization } = getMasterModels();
      const org = await Organization.findById(orgId);
      if (org && org.tenantDbName) {
        if (!sessions[sessionId]) {
          sessions[sessionId] = { status: "disconnected" };
        }
        sessions[sessionId].organizationId = orgId;
        sessions[sessionId].tenantDbName = org.tenantDbName;
        return getTenantModels(org.tenantDbName);
      }
    } catch (err) {
      console.error(`[WhatsApp] Failed to resolve tenant models from sessionId ${sessionId}:`, err);
    }
  }
  // Fallback to base static models
  return {
    Lead,
    Message,
    Conversation,
    WhatsAppSession,
    User,
    AssignmentState,
    Notification,
    SystemSettings,
  };
};

export const updateSessionStatus = async (
  sessionId,
  status,
  qr = "",
  phone = "",
  name = "",
) => {
  if (!sessions[sessionId]) {
    sessions[sessionId] = { status: "disconnected" };
  }

  // Log the status change
  if (sessions[sessionId].status !== status) {
    logWhatsAppEvent(`Session: ${sessionId} | Status changed from '${sessions[sessionId].status}' to '${status}' | Phone: ${phone || "N/A"}`);
  }

  sessions[sessionId].status = status;
  sessions[sessionId].qrCode = qr;
  if (phone) sessions[sessionId].connectedPhone = phone;
  if (name) sessions[sessionId].connectedName = name;
  if (!sessions[sessionId].organizationId && sessionId.startsWith("org_")) {
    const match = sessionId.match(/^org_([a-fA-F0-9]{24})/);
    if (match) sessions[sessionId].organizationId = match[1];
  }

  const dbStatus = status === "pairing" ? "connecting" : status;

  try {
    const models = await getModelsForSession(sessionId);
    const SessionModel = models?.WhatsAppSession || WhatsAppSession;
    let session = await SessionModel.findOne({ sessionId });
    if (!session) {
      session = new SessionModel({ sessionId });
    }
    session.status = dbStatus;
    session.qrCode = qr;
    if (phone) session.connectedPhone = phone;
    if (name) session.connectedName = name;
    await session.save();

    const io = getIO();
    if (io) {
      let repUserId = null;
      if (sessionId && sessionId.includes("_user_")) {
        repUserId = sessionId.split("_user_")[1];
      }
      const orgId =
        sessions[sessionId]?.organizationId ||
        (sessionId.startsWith("org_")
          ? sessionId.match(/^org_([a-fA-F0-9]{24})/)?.[1]
          : null);

      const statusPayload = {
        sessionId,
        userId: repUserId,
        organizationId: orgId,
        status,
        qrCode: qr,
        connectedPhone: phone || session.connectedPhone,
        connectedName: name || session.connectedName,
      };

      if (orgId) {
        io.to(`org_${orgId}`).emit("whatsapp_status", statusPayload);
      } else {
        io.emit("whatsapp_status", statusPayload);
      }
      io.to(sessionId).emit("whatsapp_status", statusPayload);
    }
  } catch (err) {
    console.error("Failed to update WhatsAppSession in DB:", err);
  }
};

/**
 * Inert stub: Baileys connection engine is retired.
 */
export const connectWhatsApp = async () => {
  console.log("[WhatsApp] Baileys connection engine is retired. Official Meta WhatsApp Cloud API is active.");
};

export const logoutWhatsApp = async (sessionId) => {
  if (!sessionId) return;
  console.log(`[WhatsApp] Logout session ${sessionId}`);
  await updateSessionStatus(sessionId, "disconnected", "", "", "");
  if (sessions[sessionId]) {
    delete sessions[sessionId];
  }
};

/**
 * Checks whether AI auto-replies are enabled for a specific assigned sales rep.
 */
export const isRepAIAutoReplyEnabled = async (lead, sessionId, models) => {
  try {
    let repUserId = null;
    if (sessionId && sessionId.includes("_user_")) {
      repUserId = sessionId.split("_user_")[1];
    } else if (sessionId && sessionId.startsWith("user_")) {
      repUserId = sessionId.replace("user_", "");
    } else if (lead?.assignedTo && lead.assignedTo !== "Unassigned") {
      repUserId = typeof lead.assignedTo === "object"
        ? (lead.assignedTo._id || lead.assignedTo.id || "").toString()
        : lead.assignedTo.toString();
    }

    if (!repUserId || repUserId === "Unassigned") {
      return true;
    }

    const UserModel = models?.User || User;
    let repUser = null;
    if (UserModel) {
      if (typeof UserModel.findById === "function") {
        const q = UserModel.findById(repUserId);
        const withSelect = q?.select ? q.select("aiAutoReplyEnabled name") : q;
        repUser = typeof withSelect?.lean === "function" ? await withSelect.lean() : await withSelect;
      }
      if (!repUser && typeof UserModel.findOne === "function") {
        const q = UserModel.findOne({
          $or: [{ _id: repUserId }, { name: repUserId }],
        });
        const withSelect = q?.select ? q.select("aiAutoReplyEnabled name") : q;
        repUser = typeof withSelect?.lean === "function" ? await withSelect.lean() : await withSelect;
      }
    }

    if (repUser && repUser.aiAutoReplyEnabled === false) {
      return false;
    }
    return true;
  } catch (err) {
    console.error("[isRepAIAutoReplyEnabled] Error checking rep settings:", err.message);
    return true;
  }
};

/**
 * Pause AI automated responses for a lead (e.g. for 5 minutes after manual agent message)
 */
export const pauseAIForLead = async (leadId, models, orgId = null, durationMinutes = 5) => {
  const leadIdStr = leadId.toString();
  const pauseUntil = new Date(Date.now() + durationMinutes * 60 * 1000);

  if (aiPauseTimers[leadIdStr]) {
    clearTimeout(aiPauseTimers[leadIdStr]);
  }

  aiPauseTimers[leadIdStr] = setTimeout(async () => {
    delete aiPauseTimers[leadIdStr];
    try {
      const LeadModel = models?.Lead || Lead;
      await LeadModel.findByIdAndUpdate(leadId, { aiPausedUntil: null });
      console.log(`[AI SNOOZE] Auto-resumed AI for lead ${leadIdStr} after timeout.`);
      const io = getIO();
      if (io) {
        const resumePayload = { leadId: leadIdStr, aiPausedUntil: null };
        io.to(leadIdStr).emit("ai_status_updated", resumePayload);
        if (orgId) {
          io.to(`org_${orgId}`).emit("ai_status_updated", resumePayload);
        }
      }
    } catch (e) {
      console.error(`[AI SNOOZE] Error auto-resuming AI for lead ${leadIdStr}:`, e);
    }
  }, durationMinutes * 60 * 1000);

  const LeadModel = models?.Lead || Lead;
  await LeadModel.findByIdAndUpdate(leadId, { aiPausedUntil: pauseUntil });

  const io = getIO();
  if (io) {
    const pausePayload = { leadId: leadIdStr, aiPausedUntil: pauseUntil };
    io.to(leadIdStr).emit("ai_status_updated", pausePayload);
    if (orgId) {
      io.to(`org_${orgId}`).emit("ai_status_updated", pausePayload);
    }
  }
};

/**
 * Immediately clear an active AI pause for a lead.
 */
export const clearAIPauseForLead = async (leadId, models, orgId = null) => {
  const leadIdStr = leadId.toString();
  if (aiPauseTimers[leadIdStr]) {
    clearTimeout(aiPauseTimers[leadIdStr]);
    delete aiPauseTimers[leadIdStr];
  }
  const LeadModel = models?.Lead || Lead;
  await LeadModel.findByIdAndUpdate(leadId, { aiPausedUntil: null });
  console.log(`[AI SNOOZE] Manually cleared AI pause for lead ${leadIdStr}.`);

  const io = getIO();
  if (io) {
    const resumePayload = { leadId: leadIdStr, aiPausedUntil: null };
    io.to(leadIdStr).emit("ai_status_updated", resumePayload);
    if (orgId) {
      io.to(`org_${orgId}`).emit("ai_status_updated", resumePayload);
    }
  }
};

/**
 * Expose function to dispatch manual messages from the CRM UI via Meta Cloud API or mock session.
 */
export const sendMessageFromCRM = async (
  leadId,
  messageText,
  senderName = "Agent",
  context = {},
) => {
  let { organizationId, tenantModels, sessionId } = context;
  if (!sessionId && organizationId) {
    sessionId = `org_${organizationId}`;
  }

  const models = tenantModels || (sessionId ? await getModelsForSession(sessionId) : { Lead, Message, Conversation });
  const LeadModel = models?.Lead || Lead;
  const MessageModel = models?.Message || Message;
  const ConversationModel = models?.Conversation || Conversation;

  const lead = await LeadModel.findById(leadId);
  if (!lead) {
    throw new Error("Lead not found!");
  }

  const orgId = organizationId || (lead.organizationId ? lead.organizationId.toString() : null);

  let messageId = `msg_${Date.now()}`;
  let delivered = true;

  // Check if mock socket exists in test environment
  const mockSock = sessionId ? sessions[sessionId]?.sock : null;
  if (mockSock && typeof mockSock.sendMessage === "function") {
    let cleanPhone = String(lead.phone).replace(/\D/g, "");
    if (cleanPhone.length === 10) {
      cleanPhone = "91" + cleanPhone;
    }
    const targetJid = `${cleanPhone}@s.whatsapp.net`;
    const sendResult = await mockSock.sendMessage(targetJid, { text: messageText });
    if (sendResult?.key?.id) {
      messageId = sendResult.key.id;
    }
  } else if (orgId) {
    // Official Meta Cloud API dispatch
    try {
      const WAAccount = (await import("../models/WhatsAppAccount.js")).default;
      const waAccount = await WAAccount.findOne({
        organizationId: orgId,
        status: { $in: ["connected", "syncing"] },
      });

      if (!waAccount) {
        throw new Error("WhatsApp Cloud API is not connected for this organization! Please connect in WhatsApp Settings.");
      }

      const accessToken = decryptApiKey(waAccount.accessTokenEncrypted);
      const cloudRes = await sendTextMessage({
        phoneNumberId: waAccount.phoneNumberId,
        accessToken,
        toPhone: lead.phone,
        textBody: messageText,
      });

      if (cloudRes?.metaMessageId) {
        messageId = cloudRes.metaMessageId;
      }
    } catch (sendErr) {
      console.error("[sendMessageFromCRM] Meta Cloud API error:", sendErr.message);
      throw sendErr;
    }
  } else {
    throw new Error("WhatsApp client is not connected for this organization! Please connect in WhatsApp Settings.");
  }

  // Pause AI for 5 minutes when an agent sends a manual CRM message
  if (lead.aiEnabled) {
    try {
      await pauseAIForLead(lead._id, models, orgId);
      console.log(`[AI SNOOZE] CRM manual message detected for lead ${lead._id}. AI paused for 5 minutes.`);
    } catch (pauseErr) {
      console.error(`[AI SNOOZE] Error pausing AI for lead ${lead._id}:`, pauseErr);
    }
  }

  const timestamp = new Date();

  // Create message record
  const messageRecord = await MessageModel.create({
    messageId,
    leadId: lead._id,
    sender: "Sales Representative",
    senderName,
    direction: "outgoing",
    messageType: "text",
    text: messageText,
    timestamp,
    aiGenerated: false,
    delivered,
    read: false,
    status: "sent",
    source: "cloud_api",
  });

  // Update Conversation details
  await ConversationModel.findOneAndUpdate(
    { leadId: lead._id },
    {
      lastMessage: messageText,
      lastMessageTime: timestamp,
      unreadCount: 0,
    },
    { upsert: true }
  );

  // Emit socket updates
  const io = getIO();
  if (io) {
    io.to(lead._id.toString()).emit("new_message", messageRecord);
    const updatePayload = {
      leadId: lead._id,
      unreadCount: 0,
      lastMessage: messageText,
      lastMessageTime: timestamp,
    };
    const targetOrg = orgId || (sessionId ? sessions[sessionId]?.organizationId : null);
    if (targetOrg) {
      io.to(`org_${targetOrg}`).emit("conversation_updated", updatePayload);
    }
  }

  return messageRecord;
};

/**
 * Expose function to dispatch document (PDF/Word) messages with caption from the CRM UI or API.
 */
export const sendDocumentMessageFromCRM = async (
  recipientPhoneOrLeadId,
  documentData,
  captionText = "",
  senderName = "Agent",
  context = {}
) => {
  let { organizationId, tenantModels, sessionId, salesRepId } = context;
  const rawOrgId = organizationId
    ? organizationId.toString().startsWith("org_")
      ? organizationId.toString().slice(4)
      : organizationId.toString()
    : null;

  if (!sessionId && rawOrgId) {
    sessionId = `org_${rawOrgId}`;
  }

  if (sessionId && rawOrgId) {
    const orgPrefix = `org_${rawOrgId}`;
    const belongsToOrg = sessionId === orgPrefix || sessionId.startsWith(`${orgPrefix}_`);
    if (!belongsToOrg) {
      throw new Error(`Unauthorized: WhatsApp session ${sessionId} does not belong to organization ${organizationId}`);
    }
  }

  let sock = null;
  if (sessionId) {
    const sessionObj = sessions[sessionId];
    if (sessionObj && (!organizationId || sessionObj.organizationId?.toString() === organizationId.toString())) {
      sock = sessionObj.sock;
    }
  }

  if (!sock) {
    throw new Error("WhatsApp client is not connected for this organization! Please connect your device in WhatsApp Settings.");
  }

  const models = tenantModels || (sessionId ? await getModelsForSession(sessionId) : { Lead, Message, Conversation });
  const LeadModel = models?.Lead || Lead;
  const MessageModel = models?.Message || Message;
  const ConversationModel = models?.Conversation || Conversation;

  let lead = null;
  let rawPhone = "";
  if (mongoose.Types.ObjectId.isValid(recipientPhoneOrLeadId)) {
    lead = await LeadModel.findById(recipientPhoneOrLeadId);
    if (lead) rawPhone = lead.phone;
  }

  if (!lead) {
    rawPhone = String(recipientPhoneOrLeadId).replace(/\D/g, "");
    if (!rawPhone || rawPhone.length < 7) {
      throw new Error("A valid phone number (minimum 7 digits) or leadId is required.");
    }

    const last10 = rawPhone.slice(-10);
    lead = await LeadModel.findOne({
      $or: [
        { phone: rawPhone },
        { phone: last10 },
        { phone: `+91${last10}` },
        { phone: `91${last10}` },
      ],
    });

    if (!lead) {
      lead = await LeadModel.create({
        name: context.recipientName || `Contact ${last10}`,
        phone: rawPhone.length === 10 ? rawPhone : last10,
        status: "New",
        source: "WhatsApp Document",
        notes: "Initiated document message send from organization",
      });
    }
  }

  let cleanPhone = String(rawPhone || lead.phone).replace(/\D/g, "");
  if (cleanPhone.length === 10) {
    cleanPhone = "91" + cleanPhone;
  }
  const targetJid = `${cleanPhone}@s.whatsapp.net`;

  const originalFileName = documentData.fileName || documentData.originalName || path.basename(documentData.filePath || "document.pdf");
  const ext = path.extname(originalFileName).toLowerCase();
  const mimeMap = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
  };
  const mimetype = mimeMap[ext] || documentData.mimetype || "application/pdf";

  let documentSource;
  if (documentData.buffer) {
    documentSource = documentData.buffer;
  } else if (documentData.filePath && fs.existsSync(documentData.filePath)) {
    documentSource = fs.readFileSync(documentData.filePath);
  } else if (documentData.fileUrl) {
    documentSource = { url: documentData.fileUrl };
  } else {
    throw new Error("Invalid document source: file buffer or valid filePath is required.");
  }

  const leadIdStr = lead._id.toString();
  automatedSendInProgress.add(leadIdStr);

  let sendResult;
  try {
    sendResult = await sock.sendMessage(targetJid, {
      document: documentSource,
      mimetype,
      fileName: originalFileName,
      caption: captionText || "",
    });
  } finally {
    setTimeout(() => automatedSendInProgress.delete(leadIdStr), 3000);
  }

  if (lead.aiEnabled) {
    try {
      await pauseAIForLead(lead._id, models, organizationId);
      console.log(`[AI SNOOZE] Document send detected for lead ${lead._id}. AI paused for 5 minutes.`);
    } catch (pauseErr) {
      console.error(`[AI SNOOZE] Error pausing AI for lead ${lead._id}:`, pauseErr);
    }
  }

  const messageId = sendResult?.key?.id || `doc_${Date.now()}`;
  const timestamp = new Date();
  const mediaUrl = documentData.mediaUrl || (documentData.filePath ? `/uploads/documents/${path.basename(documentData.filePath)}` : "");

  const messageRecord = await MessageModel.create({
    messageId,
    leadId: lead._id,
    sender: senderName || "Organization",
    senderName: senderName || "Organization",
    direction: "outgoing",
    messageType: "document",
    mediaUrl,
    fileName: originalFileName,
    text: captionText || "",
    timestamp,
    aiGenerated: false,
    delivered: true,
    read: false,
    status: "sent",
    sessionId,
    salesRepId: salesRepId || null,
  });

  const lastMsgSnippet = captionText
    ? `[Document: ${originalFileName}] ${captionText}`
    : `[Document: ${originalFileName}]`;

  await ConversationModel.findOneAndUpdate(
    { leadId: lead._id },
    {
      lastMessage: lastMsgSnippet,
      lastMessageTime: timestamp,
      unreadCount: 0,
    },
    { upsert: true }
  );

  const io = getIO();
  if (io) {
    io.to(lead._id.toString()).emit("new_message", messageRecord);
    const updatePayload = {
      leadId: lead._id,
      unreadCount: 0,
      lastMessage: lastMsgSnippet,
      lastMessageTime: timestamp,
    };
    const targetOrg =
      organizationId ||
      lead.organizationId ||
      lead.organization ||
      (sessionId ? sessions[sessionId]?.organizationId : null);
    if (targetOrg) {
      io.to(`org_${targetOrg}`).emit("conversation_updated", updatePayload);
    }
  }

  return { messageRecord, lead };
};

/**
 * Expose connection status getter with optional organization filtering
 */
export const getWhatsAppStatus = (organizationId = null) => {
  let list = Object.keys(sessions).map((sessionId) => ({
    sessionId,
    organizationId: sessions[sessionId].organizationId,
    status: sessions[sessionId].status,
    qrCode: sessions[sessionId].qrCode,
    connectedPhone: sessions[sessionId].connectedPhone,
    connectedName: sessions[sessionId].connectedName,
  }));

  if (organizationId) {
    const orgStr = organizationId.toString();
    const orgPrefix = `org_${orgStr}`;
    list = list.filter((s) => {
      const sOrgId = s.organizationId ? s.organizationId.toString() : null;
      return (
        sOrgId === orgStr ||
        s.sessionId === orgPrefix ||
        s.sessionId.startsWith(`${orgPrefix}_`)
      );
    });
  }

  return list;
};

export const DEFAULT_WELCOME_MESSAGE_TEMPLATE = `Hello {{name}}! 👋\n\nThank you for reaching out to {{company}} regarding *{{service}}*.\n\nWe have received your enquiry and our specialist will connect with you shortly.\n\nFeel free to reply with any specific requirements or questions you may have!`;

export const formatWelcomeMessage = (
  template,
  lead = {},
  orgInfo = {},
  fallbackService = "",
) => {
  const rawTemplate =
    template && template.trim() ? template : DEFAULT_WELCOME_MESSAGE_TEMPLATE;

  const leadName =
    lead.name && lead.name.trim() ? lead.name.trim() : "there";
  const firstName =
    leadName !== "there" ? leadName.split(/\s+/)[0] : "there";
  const company =
    orgInfo.companyName && orgInfo.companyName.trim()
      ? orgInfo.companyName.trim()
      : orgInfo.name && orgInfo.name.trim()
        ? orgInfo.name.trim()
        : "our team";

  const resolvedFallbackService =
    fallbackService && fallbackService.trim()
      ? fallbackService.trim()
      : orgInfo.primaryService && orgInfo.primaryService.trim()
        ? orgInfo.primaryService.trim()
        : "our services";

  const leadService =
    lead.service &&
    lead.service.trim() &&
    lead.service.trim() !== "General Enquiry"
      ? lead.service.trim()
      : resolvedFallbackService;

  const phone = lead.phone || "";
  const email = lead.email || "";
  const city = lead.city || "";
  const source = lead.source || "your enquiry";

  const replacements = {
    name: leadName,
    firstname: firstName,
    service: leadService,
    company: company,
    companyname: company,
    phone: phone,
    email: email,
    city: city,
    source: source,
  };

  return rawTemplate.replace(
    /\{\{?\s*([a-zA-Z0-9_]+)\s*\}?\}/g,
    (match, tag) => {
      const key = tag.toLowerCase();
      return replacements[key] !== undefined ? replacements[key] : match;
    },
  );
};

export const sendWelcomeEnquiryMessage = async (lead, context = {}) => {
  try {
    if (!lead || !lead.phone) return null;

    let organizationId = context?.organizationId || lead.organizationId || lead.organization || null;
    if (organizationId && typeof organizationId === "object" && organizationId._id) {
      organizationId = organizationId._id.toString();
    } else if (organizationId) {
      organizationId = organizationId.toString();
    }

    const sessionId = organizationId ? `org_${organizationId}` : (context?.sessionId || null);
    const models = context?.tenantModels || (sessionId ? await getModelsForSession(sessionId) : { Message, Conversation, SystemSettings });
    const MessageModel = models?.Message || Message;
    const ConversationModel = models?.Conversation || Conversation;

    const settings = await getSystemSettings(models);
    if (!settings.welcomeMessageEnabled) {
      return null;
    }

    const normalizedSource = (lead.source || "").trim().toLowerCase();
    if (
      normalizedSource === "manual entry" ||
      normalizedSource === "call" ||
      normalizedSource.includes("call")
    ) {
      return null;
    }

    // Check if test mock socket exists
    let sock = sessionId ? sessions[sessionId]?.sock : null;
    let waAccount = null;

    if (!sock && organizationId) {
      try {
        const WAAccount = (await import("../models/WhatsAppAccount.js")).default;
        waAccount = await WAAccount.findOne({
          organizationId,
          status: { $in: ["connected", "syncing"] },
        });
      } catch (waErr) {
        console.warn("[WhatsApp Welcome] Could not query WAAccount:", waErr.message);
      }
    }

    if (!sock && !waAccount) {
      console.warn(
        `[WhatsApp Welcome] WhatsApp is not connected for organization ${organizationId || "default"}. Skipping welcome message for ${lead.phone}`,
      );
      return null;
    }

    const existingMessagesCount = await MessageModel.countDocuments({
      leadId: lead._id,
    });
    if (existingMessagesCount > 0) {
      return null;
    }

    const orgInfo = {
      name: "",
      companyName: "",
      primaryService: "",
    };
    if (organizationId) {
      try {
        const { Organization } = getMasterModels();
        const orgDoc = await Organization.findById(organizationId).lean();
        if (orgDoc) {
          orgInfo.name = orgDoc.name || "";
          orgInfo.companyName =
            orgDoc.aiSettings?.companyName || orgDoc.name || "";
          if (
            Array.isArray(orgDoc.aiSettings?.services) &&
            orgDoc.aiSettings.services.length > 0
          ) {
            orgInfo.primaryService = orgDoc.aiSettings.services[0].name || "";
          }
          if (
            !settings.welcomeMessageTemplate &&
            orgDoc.aiSettings?.welcomeMessageTemplate
          ) {
            settings.welcomeMessageTemplate =
              orgDoc.aiSettings.welcomeMessageTemplate;
          }
          if (
            !settings.welcomeMessageFallbackService &&
            orgDoc.aiSettings?.welcomeMessageFallbackService
          ) {
            settings.welcomeMessageFallbackService =
              orgDoc.aiSettings.welcomeMessageFallbackService;
          }
        }
      } catch (orgErr) {
        console.error("[WhatsApp Welcome] Error fetching organization details:", orgErr.message);
      }
    }

    const welcomeText = formatWelcomeMessage(
      settings.welcomeMessageTemplate,
      lead,
      orgInfo,
      settings.welcomeMessageFallbackService,
    );

    const leadIdStr = lead._id.toString();
    automatedSendInProgress.add(leadIdStr);

    let messageId = `msg_${Date.now()}`;
    try {
      if (sock) {
        let cleanPhone = String(lead.phone).replace(/\D/g, "");
        if (cleanPhone.length === 10) cleanPhone = "91" + cleanPhone;
        const targetJid = `${cleanPhone}@s.whatsapp.net`;
        const sendResult = await sock.sendMessage(targetJid, { text: welcomeText });
        if (sendResult?.key?.id) messageId = sendResult.key.id;
      } else if (waAccount) {
        const accessToken = decryptApiKey(waAccount.accessTokenEncrypted);
        const cloudRes = await sendTextMessage({
          phoneNumberId: waAccount.phoneNumberId,
          accessToken,
          toPhone: lead.phone,
          textBody: welcomeText,
        });
        if (cloudRes?.metaMessageId) messageId = cloudRes.metaMessageId;
      }

      const timestamp = new Date();
      const messageRecord = await MessageModel.create({
        messageId,
        leadId: lead._id,
        sender: "system",
        senderName: "Automated Welcome",
        direction: "outgoing",
        messageType: "text",
        text: welcomeText,
        timestamp,
        aiGenerated: true,
        delivered: true,
        read: false,
        status: "sent",
        source: "cloud_api",
      });

      await ConversationModel.findOneAndUpdate(
        { leadId: lead._id },
        {
          leadId: lead._id,
          lastMessage: welcomeText,
          lastMessageTime: timestamp,
          unreadCount: 0,
        },
        { upsert: true, new: true },
      );

      const io = getIO();
      if (io) {
        io.to(lead._id.toString()).emit("new_message", messageRecord);
        const updatePayload = {
          leadId: lead._id,
          lastMessage: welcomeText,
          lastMessageTime: timestamp,
        };
        const targetOrg =
          organizationId || lead.organizationId || lead.organization;
        if (targetOrg) {
          io.to(`org_${targetOrg}`).emit("conversation_updated", updatePayload);
        }
      }

      return messageRecord;
    } finally {
      automatedSendInProgress.delete(leadIdStr);
    }
  } catch (err) {
    console.error("[WhatsApp Welcome] Error sending welcome message:", err.message);
    return null;
  }
};

export const getSystemSettings = async (tenantModelsOrSessionId = null) => {
  try {
    let models = null;
    if (tenantModelsOrSessionId && typeof tenantModelsOrSessionId === "object" && tenantModelsOrSessionId.SystemSettings) {
      models = tenantModelsOrSessionId;
    } else if (typeof tenantModelsOrSessionId === "string") {
      models = await getModelsForSession(tenantModelsOrSessionId);
    }
    const SettingsModel = models?.SystemSettings || SystemSettings;

    let settings = await SettingsModel.findOne();
    if (!settings) {
      settings = await SettingsModel.create({
        globalAIEnabled: true,
        welcomeMessageEnabled: true,
        welcomeMessageTemplate: "",
        welcomeMessageFallbackService: "",
      });
    }
    return settings.toObject ? settings.toObject() : settings;
  } catch (err) {
    console.error("Error loading SystemSettings:", err.message);
    return {
      globalAIEnabled: true,
      welcomeMessageEnabled: true,
      welcomeMessageTemplate: "",
      welcomeMessageFallbackService: "",
    };
  }
};

export const updateSystemSettings = async (
  updates,
  updatedBy = "User",
  tenantModelsOrSessionId = null,
  organizationId = null,
) => {
  let models = null;
  if (tenantModelsOrSessionId && typeof tenantModelsOrSessionId === "object" && tenantModelsOrSessionId.SystemSettings) {
    models = tenantModelsOrSessionId;
  } else if (typeof tenantModelsOrSessionId === "string") {
    models = await getModelsForSession(tenantModelsOrSessionId);
    if (!organizationId && tenantModelsOrSessionId.startsWith("org_")) {
      organizationId = tenantModelsOrSessionId.replace("org_", "");
    }
  }
  const SettingsModel = models?.SystemSettings || SystemSettings;

  let settings = await SettingsModel.findOne();
  if (!settings) {
    settings = new SettingsModel();
  }
  if (updates.globalAIEnabled !== undefined) {
    settings.globalAIEnabled = updates.globalAIEnabled;
  }
  if (updates.welcomeMessageEnabled !== undefined) {
    settings.welcomeMessageEnabled = updates.welcomeMessageEnabled;
  }
  if (updates.welcomeMessageTemplate !== undefined) {
    settings.welcomeMessageTemplate = updates.welcomeMessageTemplate;
  }
  if (updates.welcomeMessageFallbackService !== undefined) {
    settings.welcomeMessageFallbackService = updates.welcomeMessageFallbackService;
  }
  settings.updatedBy = updatedBy;
  await settings.save();
  const saved = settings.toObject ? settings.toObject() : settings;

  if (organizationId) {
    try {
      const { Organization } = getMasterModels();
      const org = await Organization.findById(organizationId);
      if (org) {
        if (!org.aiSettings) org.aiSettings = {};
        if (updates.welcomeMessageEnabled !== undefined) {
          org.aiSettings.welcomeMessageEnabled = updates.welcomeMessageEnabled;
        }
        if (updates.welcomeMessageTemplate !== undefined) {
          org.aiSettings.welcomeMessageTemplate = updates.welcomeMessageTemplate;
        }
        if (updates.welcomeMessageFallbackService !== undefined) {
          org.aiSettings.welcomeMessageFallbackService = updates.welcomeMessageFallbackService;
        }
        await org.save();
      }
    } catch (syncErr) {
      console.error("Failed to sync welcome message settings to Organization master model:", syncErr.message);
    }
  }
  return saved;
};

export const initAllOrganizationWhatsAppConnections = async () => {
  console.log("[WhatsApp] Baileys connection engine is retired. Official Meta WhatsApp Cloud API is active.");
};

export const startWhatsAppWatchdog = () => {
  // Watchdog retired: Meta Cloud API uses stateless webhooks instead of socket keepalives
};
