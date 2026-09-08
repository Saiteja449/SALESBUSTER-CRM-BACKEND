import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { useMongoDBAuthState } from "./useMongoDBAuthState.js";
import pino from "pino";
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
  const dateStr = now.toISOString().split("T")[0]; // Returns YYYY-MM-DD
  const timestamp = now.toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  const logFileName = `whatsapp-${dateStr}.log`;
  
  fs.appendFile(path.join(logsDir, logFileName), logMessage, (err) => {
    if (err) console.error(`Failed to write to ${logFileName}:`, err);
  });
};

const sessions = {}; // map of sessionId -> { sock, status, qrCode, connectedPhone, connectedName, organizationId, tenantDbName }

export const normalizePhone = (jid) => {
  if (!jid) return "";
  const clean = jid.split("@")[0].split(":")[0];
  return clean.replace(/\D/g, "");
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
  // Try to parse orgId from standard naming convention "org_<orgId>"
  if (sessionId && sessionId.startsWith("org_")) {
    const orgId = sessionId.replace("org_", "");
    try {
      const { Organization } = getMasterModels();
      const org = await Organization.findById(orgId);
      if (org && org.tenantDbName) {
        if (sessionData) {
          sessionData.organizationId = orgId;
          sessionData.tenantDbName = org.tenantDbName;
        }
        return getTenantModels(org.tenantDbName);
      }
    } catch (err) {
      console.error(`[WhatsApp] Failed to resolve tenant models from sessionId ${sessionId}:`, err);
    }
  }
  // Fallback to base static models
  const WhatsAppAuthStateModel = (await import("../models/WhatsAppAuthState.js")).default;
  return {
    Lead,
    Message,
    Conversation,
    WhatsAppSession,
    WhatsAppAuthState: WhatsAppAuthStateModel,
    User,
    AssignmentState,
    Notification,
    SystemSettings,
  };
};

const updateSessionStatus = async (
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

  try {
    const models = await getModelsForSession(sessionId);
    const SessionModel = models?.WhatsAppSession || WhatsAppSession;
    let session = await SessionModel.findOne({ sessionId });
    if (!session) {
      session = new SessionModel({ sessionId });
    }
    session.status = status;
    session.qrCode = qr;
    if (phone) session.connectedPhone = phone;
    if (name) session.connectedName = name;
    await session.save();

    const io = getIO();
    if (io) {
      const statusPayload = {
        sessionId,
        organizationId: sessions[sessionId]?.organizationId,
        status,
        qrCode: qr,
        connectedPhone: phone || session.connectedPhone,
        connectedName: name || session.connectedName,
      };

      // Emit strictly to organization room if org is known, else broadcast for legacy single-tenant
      if (sessions[sessionId]?.organizationId) {
        io.to(`org_${sessions[sessionId].organizationId}`).emit("whatsapp_status", statusPayload);
      } else {
        io.emit("whatsapp_status", statusPayload);
      }
    }
  } catch (err) {
    console.error("Failed to update WhatsAppSession in DB:", err);
  }
};

export const connectWhatsApp = async (param1, param2, param3) => {
  let sessionId, organizationId, tenantDbName;
  if (typeof param1 === "object" && param1 !== null) {
    sessionId = param1.sessionId;
    organizationId = param1.organizationId;
    tenantDbName = param1.tenantDbName;
  } else {
    sessionId = param1;
    organizationId = param2;
    tenantDbName = param3;
  }

  if (!sessionId && organizationId) {
    sessionId = `org_${organizationId}`;
  }
  if (!sessionId) {
    sessionId = "device_1";
  }

  if (!sessions[sessionId]) {
    sessions[sessionId] = { status: "disconnected" };
  }
  if (organizationId) sessions[sessionId].organizationId = organizationId;
  if (tenantDbName) sessions[sessionId].tenantDbName = tenantDbName;

  // Prevent duplicate connection attempts for the same active session
  if (
    sessions[sessionId].status === "connected" ||
    sessions[sessionId].status === "connecting"
  ) {
    console.log(
      `[DEBUG] WhatsApp session ${sessionId} is already active (${sessions[sessionId].status}). Skipping connect.`,
    );
    return;
  }
  // Clean up dangling socket before starting a new connection
  if (sessions[sessionId].sock) {
    try {
      sessions[sessionId].sock.end();
    } catch (e) {}
    sessions[sessionId].sock = null;
  }

  try {
    const models = await getModelsForSession(sessionId);
    const { state, saveCreds } = await useMongoDBAuthState(sessionId, models.WhatsAppAuthState);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    console.log(
      `Initializing WhatsApp connection for ${sessionId} (org: ${sessions[sessionId]?.organizationId || "default"}) via Baileys... (Version: ${version.join(".")})`,
    );
    updateSessionStatus(sessionId, "connecting");

    const sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: true,
      logger: pino({ level: "silent" }),
      keepAliveIntervalMs: 20000, // Send ping every 20s to prevent VPS firewall from dropping the idle socket connection
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000,
    });

    sessions[sessionId].sock = sock;

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      console.log(
        `Baileys connection.update [${sessionId}]:`,
        JSON.stringify({
          connection,
          qr: qr ? "[QR data present]" : undefined,
          lastDisconnect: lastDisconnect?.error?.message,
        }),
      );

      if (qr) {
        console.log(`New WhatsApp QR code generated for ${sessionId}. Please scan.`);
        updateSessionStatus(sessionId, "qr", qr);
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMsg = lastDisconnect?.error?.message || "Unknown error";
        console.log(`WhatsApp connection closed for ${sessionId}. Status code: ${statusCode}`);
        logWhatsAppEvent(`Session: ${sessionId} | CONNECTION DROPPED | Status: ${statusCode} | Reason: ${errMsg}`);
        
        // Update status to disconnected so reconnect doesn't abort
        updateSessionStatus(sessionId, "disconnected");

        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut && 
          statusCode !== 403 && 
          statusCode !== 405;
          
        if (shouldReconnect) {
          console.log(`Attempting to reconnect WhatsApp for ${sessionId} in 5 seconds...`);
          setTimeout(() => connectWhatsApp({
            sessionId,
            organizationId: sessions[sessionId]?.organizationId,
            tenantDbName: sessions[sessionId]?.tenantDbName,
          }), 5000);
        } else {
          console.log(
            `WhatsApp session ${sessionId} logged out. Cleaning up credentials...`,
          );
          logoutWhatsApp(sessionId)
            .then(() => {
              console.log(
                `Credentials cleaned for ${sessionId}. Reinitializing connection to generate new QR code...`,
              );
              setTimeout(() => connectWhatsApp({
                sessionId,
                organizationId: sessions[sessionId]?.organizationId,
                tenantDbName: sessions[sessionId]?.tenantDbName,
              }), 3000);
            })
            .catch((err) => console.error("Error during logout:", err));
        }
      } else if (connection === "open") {
        const userJid = sock?.user?.id || "";
        const phone = normalizePhone(userJid);
        const name = sock?.user?.name || "WhatsApp Business Agent";

        console.log(
          `WhatsApp is fully connected for ${sessionId}. Active on: ${phone} (${name})`,
        );
        updateSessionStatus(sessionId, "connected", "", phone, name);
      }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async (m) => {
      try {
        console.log(`=== messages.upsert event received for ${sessionId} ===`);
        console.log("Event type:", m.type);
        console.log("Number of messages:", m.messages?.length);

        const messagesList = m.messages || [];
        const eventType = m.type;

        for (const msg of messagesList) {
          console.log("Message key:", JSON.stringify(msg.key));
          console.log("Message fromMe:", msg.key.fromMe);
          console.log("Message type:", Object.keys(msg.message || {}));
          console.log("Push name:", msg.pushName);

          if (eventType === "notify" || eventType === "append") {
            console.log(
              `Processing message from: ${msg.key.remoteJid} (fromMe: ${msg.key.fromMe}) on session ${sessionId}`,
            );
            await handleIncomingOrOutgoingMessage(
              msg,
              sessionId,
              msg.key.fromMe,
            );
          } else {
            console.log(
              `Skipping message - fromMe: ${msg.key.fromMe}, type: ${eventType}`,
            );
          }
        }
      } catch (err) {
        console.error(`Error in messages.upsert handler for ${sessionId}:`, err);
      }
    });
  } catch (error) {
    console.error(`Fatal error during WhatsApp initialization for ${sessionId}:`, error);
    updateSessionStatus(sessionId, "disconnected");
  }
};

export const logoutWhatsApp = async (sessionId) => {
  if (!sessionId) return;

  const sock = sessions[sessionId]?.sock;

  if (sock) {
    try {
      await sock.logout();
    } catch (e) {
      // Socket might be already closed
    }
    sessions[sessionId].sock = null;
  }

  // Delete credentials and session record from tenant MongoDB
  try {
    const models = await getModelsForSession(sessionId);
    const AuthModel = models?.WhatsAppAuthState || (await import("../models/WhatsAppAuthState.js")).default;
    const SessionModel = models?.WhatsAppSession || WhatsAppSession;
    await AuthModel.deleteMany({ sessionId });
    await SessionModel.deleteOne({ sessionId });
  } catch (err) {
    console.error(`Failed to clear MongoDB auth state for ${sessionId}:`, err);
  }

  console.log(`WhatsApp session ${sessionId} terminated and auth files removed.`);
  updateSessionStatus(sessionId, "disconnected", "", "", "");
};

const handleIncomingOrOutgoingMessage = async (msg, sessionId, fromMe) => {
  try {
    const models = await getModelsForSession(sessionId);
    const MessageModel = models?.Message || Message;
    const LeadModel = models?.Lead || Lead;
    const ConversationModel = models?.Conversation || Conversation;
    const UserModel = models?.User || User;
    const AssignmentStateModel = models?.AssignmentState || AssignmentState;
    const NotificationModel = models?.Notification || Notification;

    const messageId = msg.key.id;

    // 1. Check if message already exists in DB to avoid duplicate processing
    const existingMsg = await MessageModel.findOne({ messageId });
    if (existingMsg) {
      console.log(
        `[DEBUG] Message ${messageId} already exists in DB for ${sessionId}. Skipping to avoid duplicates.`,
      );
      return;
    }

    const remoteJid = msg.key.remoteJid;
    const remoteJidAlt = msg.key.remoteJidAlt;

    const isIndividualChat =
      (remoteJid && remoteJid.endsWith("@s.whatsapp.net")) ||
      (remoteJid && remoteJid.endsWith("@lid"));

    if (!isIndividualChat) {
      console.log(`Skipping non-individual chat: ${remoteJid}`);
      return;
    }

    // Resolve phoneJid: Prefer the phone number JID (@s.whatsapp.net) over the LID (@lid)
    let phoneJid = remoteJid;
    if (remoteJidAlt && remoteJidAlt.endsWith("@s.whatsapp.net")) {
      phoneJid = remoteJidAlt;
    } else if (remoteJid && remoteJid.endsWith("@s.whatsapp.net")) {
      phoneJid = remoteJid;
    } else if (remoteJidAlt) {
      phoneJid = remoteJidAlt;
    }

    const phone = normalizePhone(phoneJid);
    const isLid = phoneJid && phoneJid.endsWith("@lid");

    // Skip messages sent to own number
    const sock = sessions[sessionId]?.sock;
    if (sock && sock.user && sock.user.id) {
      const myPhone = sock.user.id
        .split(":")[0]
        .split("@")[0]
        .replace(/\D/g, "");
      // Direct comparison, ignoring any extra characters
      if (
        phone === myPhone ||
        phone.endsWith(myPhone) ||
        myPhone.endsWith(phone)
      ) {
        console.log(`[DEBUG] Skipping message sent to own number: ${phone}`);
        return;
      }
    }

    const timestamp = new Date(
      (msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000,
    );
    const pushName = msg.pushName || "WhatsApp User";

    console.log(
      `Processing message - Session: ${sessionId}, Phone: ${phone}, Name: ${pushName}, JID: ${remoteJid}, AltJID: ${remoteJidAlt || "none"}, isLid: ${isLid}`,
    );

    let messageType = "text";
    let textContent = "";
    let mediaUrl = "";

    let msgContent = msg.message;
    if (!msgContent) return;

    // Unwrap nested/wrapped messages (e.g. deviceSentMessage, ephemeralMessage, etc.)
    while (msgContent) {
      if (msgContent.deviceSentMessage?.message) {
        msgContent = msgContent.deviceSentMessage.message;
      } else if (msgContent.ephemeralMessage?.message) {
        msgContent = msgContent.ephemeralMessage.message;
      } else if (msgContent.viewOnceMessage?.message) {
        msgContent = msgContent.viewOnceMessage.message;
      } else if (msgContent.viewOnceMessageV2?.message) {
        msgContent = msgContent.viewOnceMessageV2.message;
      } else if (msgContent.documentWithCaptionMessage?.message) {
        msgContent = msgContent.documentWithCaptionMessage.message;
      } else {
        break;
      }
    }

    if (msgContent.conversation) {
      messageType = "text";
      textContent = msgContent.conversation || "";
    } else if (msgContent.extendedTextMessage) {
      messageType = "text";
      textContent = msgContent.extendedTextMessage.text || "";
    } else if (msgContent.imageMessage || msgContent.videoMessage) {
      messageType = "text";
      const caption =
        msgContent.imageMessage?.caption || msgContent.videoMessage?.caption;
      textContent = caption
        ? `[Media with caption: ${caption}] (Images/Videos are disabled)`
        : "[Image/Video attachment disabled]";
      mediaUrl = "";
    } else if (msgContent.audioMessage) {
      messageType = "audio";
      textContent = "Voice message";
      mediaUrl = await downloadAndSaveMedia(msg, "audio");
    } else if (msgContent.documentMessage) {
      messageType = "document";
      textContent = msgContent.documentMessage.title || "Document";
      mediaUrl = await downloadAndSaveMedia(msg, "document");
    } else if (msgContent.locationMessage) {
      messageType = "location";
      const loc = msgContent.locationMessage;
      textContent = `Location Shared - Lat: ${loc.degreesLatitude}, Lng: ${loc.degreesLongitude}`;
    } else if (msgContent.contactMessage || msgContent.contactsArrayMessage) {
      messageType = "contact";
      const contact = msgContent.contactMessage;
      textContent = `Contact Shared - Name: ${contact?.displayName || "Unknown"}`;
    } else {
      messageType = "text";
      textContent = "Unsupported message type";
    }

    textContent = textContent || "";
    console.log(
      `[DEBUG] Extracted content: ${messageType} - "${textContent.substring(0, 30)}..."`,
    );

    let detectedService = null;
    if (textContent && typeof textContent === "string") {
      const s = textContent.toLowerCase();
      if (
        s.includes("mrl") ||
        s.includes("machine room less") ||
        s.includes("no machine room")
      ) {
        detectedService = "MRL Lift";
      } else if (
        s.includes("hydraulic") ||
        s.includes("villa lift") ||
        s.includes("home lift") ||
        s.includes("warehouse lift") ||
        s.includes("cargo lift") ||
        s.includes("industrial lift")
      ) {
        detectedService = "Hydraulic Lift";
      } else if (
        s.includes("hospital") ||
        s.includes("bed lift") ||
        s.includes("stretcher") ||
        s.includes("medical lift") ||
        s.includes("clinic lift")
      ) {
        detectedService = "Hospital Bed Lift";
      } else if (
        s.includes("moderniz") ||
        s.includes("modernis") ||
        s.includes("upgrade lift") ||
        s.includes("upgrade elevator") ||
        s.includes("replace lift") ||
        s.includes("replacement")
      ) {
        detectedService = "Elevator Modernization";
      } else if (
        s.includes("maintenance") ||
        s.includes("amc") ||
        s.includes("servicing") ||
        s.includes("breakdown") ||
        s.includes("repair")
      ) {
        detectedService = "Elevator Maintenance & AMC";
      } else if (
        s.includes("passenger") ||
        s.includes("apartment lift") ||
        s.includes("office lift") ||
        s.includes("residential lift") ||
        s.includes("commercial lift") ||
        s.includes("elevator") ||
        s.includes("lift")
      ) {
        detectedService = "Passenger Lift";
      }
    }

    console.log(`[DEBUG] Finding lead in DB for phone: ${phone} (session: ${sessionId})`);
    let lead = await LeadModel.findOne({
      $or: [{ phone: phone }, { phone: new RegExp(phone.slice(-10) + "$") }],
    });

    let isNewLead = false;
    let assignedRepName = "Sales Representative";

    if (!lead) {
      // Do NOT create a lead if the identifier is a LID (not a real phone number)
      // or if the message is outgoing (sent by us/fromMe) to a non-existent lead
      if (isLid || msg.key.fromMe) {
        console.log(
          `[DEBUG] Skipping lead creation for LID or outgoing message. Phone/LID: ${phone}`,
        );
        return;
      }

      console.log(`[DEBUG] Lead not found, creating new lead for ${pushName} in tenant DB`);
      isNewLead = true;
      lead = new LeadModel({
        name: pushName,
        phone: phone,
        source: "WhatsApp",
        service: detectedService || "General Enquiry",
        status: "New",
        joinedAt: new Date(),
        notes: fromMe
          ? `Created via WhatsApp outgoing message: "${textContent.substring(0, 100)}"`
          : `Discovered via WhatsApp message: "${textContent.substring(0, 100)}"`,
      });

      // Round-robin assignment logic for sales agents within tenant DB
      console.log(`[DEBUG] Assigning lead via round-robin...`);
      const representatives = await UserModel.find({ role: "sales person" }).sort({
        _id: 1,
      });
      let assignedRep = null;
      if (representatives && representatives.length > 0) {
        let state = await AssignmentStateModel.findOne({ key: "leadAssignment" });
        if (!state) {
          state = await AssignmentStateModel.create({
            key: "leadAssignment",
            lastAssignedIndex: -1,
          });
        }

        let nextIndex = state.lastAssignedIndex + 1;
        if (nextIndex >= representatives.length) {
          nextIndex = 0;
        }

        assignedRep = representatives[nextIndex];
        lead.assignedTo = assignedRep._id.toString();
        state.lastAssignedIndex = nextIndex;
        await state.save();
      }

      await lead.save();

      // Create Lead Notification in tenant DB
      const targetUsers = assignedRep ? [assignedRep._id] : [];
      assignedRepName = assignedRep?.name || "Sales Representative";
      await NotificationModel.create({
        title: fromMe
          ? "New WhatsApp Outgoing Lead Capture"
          : "New WhatsApp Lead Capture",
        message: fromMe
          ? `New WhatsApp lead captured from outgoing message to ${lead.phone} and assigned to ${assignedRepName}.`
          : `New WhatsApp lead captured from ${lead.name} (${lead.phone}) and assigned to ${assignedRepName}.`,
        type: "new_lead",
        targetRoles: ["sales manager"],
        targetUsers: targetUsers,
      });
    } else {
      // Update existing lead timestamps and latest message
      const updatedFields = {
        lastMessage: textContent,
        lastActivity: timestamp,
      };

      if (detectedService && lead.service !== detectedService) {
        updatedFields.service = detectedService;
        lead.service = detectedService; // Sync memory instance
        console.log(
          `[DEBUG] Updating lead service to '${detectedService}' based on message content`,
        );
      }

      const isPlaceholderName =
        lead.name === lead.phone ||
        lead.name === "WhatsApp User" ||
        lead.name === "WhatsApp Contact" ||
        !lead.name;

      if (isPlaceholderName) {
        let betterName = null;
        if (
          !fromMe &&
          pushName &&
          pushName !== "WhatsApp User" &&
          pushName !== "WhatsApp Contact"
        ) {
          betterName = pushName;
        }
        if (betterName) {
          updatedFields.name = betterName;
          lead.name = betterName; // Sync memory instance for socket broadcast
          console.log(
            `[DEBUG] Updating lead name from placeholder to '${betterName}'`,
          );
        }
      }

      await LeadModel.findByIdAndUpdate(lead._id, {
        $set: updatedFields,
      });
    }

    // 3. Create message record
    const isFromMe = msg.key.fromMe;
    const messageRecord = await MessageModel.create({
      messageId,
      leadId: lead._id,
      sender: isFromMe ? "Sales Representative" : phone,
      direction: isFromMe ? "outgoing" : "incoming",
      messageType,
      text: textContent,
      mediaUrl,
      timestamp,
      aiGenerated: false,
      delivered: true,
      read: false,
      status: isFromMe ? "sent" : "received",
    });

    // 4. Update Conversation session meta
    let conversation = await ConversationModel.findOne({ leadId: lead._id });
    if (!conversation) {
      conversation = new ConversationModel({
        leadId: lead._id,
      });
    }

    if (fromMe) {
      conversation.unreadCount = 0;
    } else {
      conversation.unreadCount += 1;
    }
    conversation.lastMessage = textContent;
    conversation.lastMessageTime = timestamp;
    await conversation.save();

    // 5. Broadcast message to frontend clients with org room isolation
    const io = getIO();
    const orgId = sessions[sessionId]?.organizationId;
    if (io) {
      // Broadcast to specific lead chat room
      io.to(lead._id.toString()).emit("new_message", messageRecord);

      const convPayload = {
        leadId: lead._id,
        unreadCount: conversation.unreadCount,
        lastMessage: textContent,
        lastMessageTime: timestamp,
        isNewLead,
        lead,
      };

      if (orgId) {
        io.to(`org_${orgId}`).emit("new_message", messageRecord);
        io.to(`org_${orgId}`).emit("conversation_updated", convPayload);
      } else {
        io.emit("conversation_updated", convPayload);
      }

      // Broadcast new lead alert toast event (ONLY for newly discovered WhatsApp leads)
      if (isNewLead) {
        const newLeadAlertPayload = {
          lead: {
            _id: lead._id.toString(),
            id: lead._id.toString(),
            name: lead.name,
            phone: lead.phone,
            service: lead.service,
            source: lead.source || "WhatsApp",
            status: lead.status,
            assignedTo: lead.assignedTo,
            joinedAt: lead.joinedAt,
          },
          message: textContent,
          assignedRepName: assignedRepName || "Sales Representative",
          timestamp: timestamp || new Date(),
        };

        if (orgId) {
          io.to(`org_${orgId}`).emit("whatsapp_new_lead", newLeadAlertPayload);
        } else {
          io.emit("whatsapp_new_lead", newLeadAlertPayload);
        }
        console.log(`[DEBUG] Emitted whatsapp_new_lead alert for ${lead.phone} (${lead.name})`);
      }
    }

    console.log(
      `[DEBUG] Successfully processed and broadcasted message to lead ID: ${lead._id} (Session: ${sessionId})`,
    );

    // 6. Asynchronously trigger AI agent response with 4-second debounce
    const settings = await getSystemSettings(models);
    if (!isFromMe && lead.aiEnabled && settings.globalAIEnabled) {
      console.log(`[DEBUG] Queueing AI auto-reply for lead ID: ${lead._id} on session ${sessionId}`);
      triggerAIDebounced(lead, remoteJid, textContent, sessionId, models);
    } else if (!isFromMe && lead.aiEnabled && !settings.globalAIEnabled) {
      console.log(
        `[DEBUG] Global AI is paused. Skipping AI auto-reply for lead ID: ${lead._id}`,
      );
    }
  } catch (error) {
    console.error(
      `Error processing incoming/outgoing WhatsApp message for ${sessionId}:`,
      error,
    );
  }
};

/**
 * Handle Downloading and storing media messages locally.
 */
const downloadAndSaveMedia = async (msg, type) => {
  try {
    const buffer = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger: pino({ level: "silent" }) },
    );

    const msgContent = msg.message;
    const mediaMsg =
      msgContent.imageMessage ||
      msgContent.audioMessage ||
      msgContent.documentMessage;
    const mimeType = mediaMsg?.mimetype || "application/octet-stream";
    const ext = mime.extension(mimeType) || "bin";

    const fileName = `media_${msg.key.id}_${Date.now()}.${ext}`;
    const filePath = path.join(uploadDir, fileName);

    fs.writeFileSync(filePath, buffer);
    console.log(`Media message downloaded and saved to: ${filePath}`);

    return `/uploads/${fileName}`;
  } catch (err) {
    console.error("Error downloading media attachment:", err);
    return "";
  }
};

// Global Sequential Execution Queue for AI API Calls
const globalAIExecutionQueue = [];
let isGlobalQueueProcessing = false;

const processGlobalAIQueue = async () => {
  if (isGlobalQueueProcessing || globalAIExecutionQueue.length === 0) return;
  isGlobalQueueProcessing = true;

  while (globalAIExecutionQueue.length > 0) {
    const task = globalAIExecutionQueue.shift();
    try {
      await task();
    } catch (err) {
      console.error("Error executing global AI task:", err);
    }
  }

  isGlobalQueueProcessing = false;
};

// AI Message Debouncer for batching rapid messages
const aiDebounceTimers = {};
const aiAccumulatedText = {};
const aiIsProcessing = {};

const triggerAIDebounced = (lead, remoteJid, incomingText, sessionId, tenantModels = null) => {
  const leadId = lead._id.toString();

  if (incomingText) {
    if (aiAccumulatedText[leadId]) {
      aiAccumulatedText[leadId] += "\n" + incomingText;
    } else {
      aiAccumulatedText[leadId] = incomingText;
    }
  }

  if (aiDebounceTimers[leadId]) {
    clearTimeout(aiDebounceTimers[leadId]);
  }

  aiDebounceTimers[leadId] = setTimeout(() => {
    if (aiIsProcessing[leadId]) {
      // If AI is currently generating a response for this lead, wait and retry
      triggerAIDebounced(lead, remoteJid, "", sessionId, tenantModels);
      return;
    }

    const batchedText = aiAccumulatedText[leadId]
      ? aiAccumulatedText[leadId].trim()
      : "";
    if (!batchedText) return;

    aiIsProcessing[leadId] = true;
    delete aiAccumulatedText[leadId];
    delete aiDebounceTimers[leadId];

    // Push the processing task to the global sequential queue
    globalAIExecutionQueue.push(async () => {
      try {
        await processAIResponse(lead, remoteJid, batchedText, sessionId, tenantModels);
      } finally {
        aiIsProcessing[leadId] = false;
        // Process any messages that arrived while AI was thinking
        if (aiAccumulatedText[leadId]) {
          triggerAIDebounced(lead, remoteJid, "", sessionId, tenantModels);
        }
      }
    });

    // Start the global queue processor if it isn't already running
    processGlobalAIQueue();
  }, 4000); // Wait 4 seconds for user to finish typing
};

/**
 * Asynchronous worker to trigger the AI response generation and push back.
 */
const processAIResponse = async (lead, remoteJid, incomingText, sessionId, tenantModels = null) => {
  try {
    const models = tenantModels || await getModelsForSession(sessionId);
    const MessageModel = models?.Message || Message;
    const LeadModel = models?.Lead || Lead;
    const ConversationModel = models?.Conversation || Conversation;
    const NotificationModel = models?.Notification || Notification;

    // Emit typing status over socket.io
    const io = getIO();
    const orgId = sessions[sessionId]?.organizationId;
    if (io) {
      io.to(lead._id.toString()).emit("typing_status", {
        leadId: lead._id,
        isTyping: true,
      });
      if (orgId) {
        io.to(`org_${orgId}`).emit("typing_status", {
          leadId: lead._id,
          isTyping: true,
        });
      }
    }

    // Call Gemini Agent with tenant models and organization context
    const replyText = await generateAIResponse(lead._id, incomingText, models, orgId);

    // Disable AI mode if fallback message is returned
    const fallbackMessage =
      "I'm sorry, but I'm unable to assist with this request right now. I'll connect you with one of our team members, who will continue assisting you shortly.";
    if (replyText === fallbackMessage) {
      await LeadModel.findByIdAndUpdate(lead._id, { aiEnabled: false });
      if (io) {
        io.to(lead._id.toString()).emit("conversation_updated", {
          leadId: lead._id,
        });
        if (orgId) {
          io.to(`org_${orgId}`).emit("conversation_updated", {
            leadId: lead._id,
          });
        }
      }
      await NotificationModel.create({
        title: "AI Disabled - Fallback Triggered",
        message: `AI has been disabled for ${lead.name} (${lead.phone}) because it sent the fallback message.`,
        type: "lead_update",
        targetRoles: ["sales manager", "sales person"],
      });
    }

    // Send the reply message using Baileys socket for this session
    let sock = sessionId ? sessions[sessionId]?.sock : null;
    if (!sock && orgId) {
      sock = Object.values(sessions).find(
        (s) => s.organizationId === orgId && s.status === "connected",
      )?.sock;
    }
    if (!sock && !orgId && sessionId === "device_1") {
      sock = sessions["device_1"]?.sock;
    }
    if (sock) {
      const sendResult = await sock.sendMessage(remoteJid, { text: replyText });

      const outgoingId = sendResult.key.id;
      const outboundTimestamp = new Date();

      // Save outgoing message to tenant DB
      const replyRecord = await MessageModel.create({
        messageId: outgoingId,
        leadId: lead._id,
        sender: "system",
        direction: "outgoing",
        messageType: "text",
        text: replyText,
        timestamp: outboundTimestamp,
        aiGenerated: true,
        delivered: true,
        read: false,
        status: "sent",
      });

      // Update Conversation meta
      await ConversationModel.findOneAndUpdate(
        { leadId: lead._id },
        {
          lastMessage: replyText,
          lastMessageTime: outboundTimestamp,
        },
        { upsert: true }
      );

      // Emit new outbound message over Socket
      if (io) {
        io.to(lead._id.toString()).emit("new_message", replyRecord);
        const updatePayload = {
          leadId: lead._id,
          lastMessage: replyText,
          lastMessageTime: outboundTimestamp,
        };
        if (orgId) {
          io.to(`org_${orgId}`).emit("new_message", replyRecord);
          io.to(`org_${orgId}`).emit("conversation_updated", updatePayload);
        } else {
          io.emit("conversation_updated", updatePayload);
        }
      }
    } else {
      console.warn(`[WhatsApp AI] No active WhatsApp socket found for session ${sessionId} (org: ${orgId || "default"}). Could not send AI reply.`);
    }

    // Turn off typing indicator
    if (io) {
      io.to(lead._id.toString()).emit("typing_status", {
        leadId: lead._id,
        isTyping: false,
      });
      if (orgId) {
        io.to(`org_${orgId}`).emit("typing_status", {
          leadId: lead._id,
          isTyping: false,
        });
      }
    }
  } catch (err) {
    console.error("Failed to generate/send AI response:", err);
    const io = getIO();
    if (io) {
      io.to(lead._id.toString()).emit("typing_status", {
        leadId: lead._id,
        isTyping: false,
      });
    }
  }
};

/**
 * Expose function to dispatch manual messages from the CRM UI.
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

  // Find socket for this specific session or organization
  let sock = sessionId ? sessions[sessionId]?.sock : null;
  if (!sock && organizationId) {
    sock = Object.values(sessions).find(
      (s) => s.organizationId === organizationId && s.status === "connected",
    )?.sock;
  }
  if (!sock && !organizationId) {
    sock = Object.values(sessions).find(
      (s) => s.status === "connected",
    )?.sock;
  }
  if (!sock) {
    throw new Error("WhatsApp client is not connected for this organization!");
  }

  const models = tenantModels || (sessionId ? await getModelsForSession(sessionId) : { Lead, Message, Conversation });
  const LeadModel = models?.Lead || Lead;
  const MessageModel = models?.Message || Message;
  const ConversationModel = models?.Conversation || Conversation;

  const lead = await LeadModel.findById(leadId);
  if (!lead) {
    throw new Error("Lead not found!");
  }

  // Format destination jid
  let cleanPhone = String(lead.phone).replace(/\D/g, "");
  if (cleanPhone.length === 10) {
    cleanPhone = "91" + cleanPhone;
  }
  const targetJid = `${cleanPhone}@s.whatsapp.net`;

  const sendResult = await sock.sendMessage(targetJid, { text: messageText });
  const messageId = sendResult.key.id;
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
    delivered: true,
    read: false,
    status: "sent",
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
    if (organizationId) {
      io.to(`org_${organizationId}`).emit("new_message", messageRecord);
      io.to(`org_${organizationId}`).emit("conversation_updated", updatePayload);
    } else {
      io.emit("conversation_updated", updatePayload);
    }
  }

  return messageRecord;
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
    list = list.filter(
      (s) => s.organizationId === orgStr || s.sessionId === `org_${orgStr}`,
    );
  }

  return list;
};

/**
 * Send an automated follow-up with an image and caption.
 */
export const sendAutomatedFollowup = async (lead, imageUrl, text, context = {}) => {
  let { organizationId, tenantModels, sessionId } = context;
  if (!sessionId && organizationId) {
    sessionId = `org_${organizationId}`;
  }

  let sock = sessionId ? sessions[sessionId]?.sock : null;
  if (!sock && organizationId) {
    sock = Object.values(sessions).find(
      (s) => s.organizationId === organizationId && s.status === "connected",
    )?.sock;
  }
  if (!sock && !organizationId) {
    sock = Object.values(sessions).find(
      (s) => s.status === "connected",
    )?.sock;
  }
  if (!sock) {
    throw new Error("WhatsApp client is not connected for this organization!");
  }

  const models = tenantModels || (sessionId ? await getModelsForSession(sessionId) : { Lead, Message, Conversation });
  const MessageModel = models?.Message || Message;
  const ConversationModel = models?.Conversation || Conversation;

  let cleanPhone = lead.phone.replace(/\D/g, "");
  if (cleanPhone.length === 10) {
    cleanPhone = "91" + cleanPhone;
  }
  const targetJid = `${cleanPhone}@s.whatsapp.net`;

  // Baileys downloads the image from the URL and sends it as media
  const sendResult = await sock.sendMessage(targetJid, {
    image: { url: imageUrl },
    caption: text,
  });

  const messageId = sendResult.key.id;
  const timestamp = new Date();

  // Create message record
  const messageRecord = await MessageModel.create({
    messageId,
    leadId: lead._id,
    sender: "system",
    senderName: "Automated Follow-up",
    direction: "outgoing",
    messageType: "image",
    mediaUrl: imageUrl,
    text: text,
    timestamp,
    aiGenerated: false,
    delivered: true,
    read: false,
    status: "sent",
  });

  // Update Conversation details
  await ConversationModel.findOneAndUpdate(
    { leadId: lead._id },
    {
      lastMessage: text,
      lastMessageTime: timestamp,
    },
    { upsert: true }
  );

  // Emit socket updates
  const io = getIO();
  if (io) {
    io.to(lead._id.toString()).emit("new_message", messageRecord);
    const updatePayload = {
      leadId: lead._id,
      lastMessage: text,
      lastMessageTime: timestamp,
    };
    if (organizationId) {
      io.to(`org_${organizationId}`).emit("new_message", messageRecord);
      io.to(`org_${organizationId}`).emit("conversation_updated", updatePayload);
    } else {
      io.emit("conversation_updated", updatePayload);
    }
  }

  return messageRecord;
};

/**
 * Send an automated WhatsApp welcome message for brand new enquiry leads.
 * Triggered only for external sources (Web Form, Call, Email, Meta Ads, Mobile App).
 * NOT sent for Manual Entry or if previous messages already exist for this lead.
 */
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

    // Check if Welcome Messages are enabled
    const settings = await getSystemSettings(models);
    if (!settings.welcomeMessageEnabled) {
      console.log(
        `[WhatsApp Welcome] Automated Welcome Messages are paused. Skipping welcome message for ${lead.phone}`,
      );
      return null;
    }

    // Exclude manual entry
    if (lead.source === "Manual Entry") {
      return null;
    }

    // Find active connected WhatsApp socket for this organization
    let sock = sessionId ? sessions[sessionId]?.sock : null;
    if (!sock && organizationId) {
      sock = Object.values(sessions).find(
        (s) => s.organizationId === organizationId && s.status === "connected",
      )?.sock;
    }
    if (!sock && !organizationId) {
      sock = Object.values(sessions).find(
        (s) => s.status === "connected",
      )?.sock;
    }

    if (!sock) {
      console.warn(
        `[WhatsApp Welcome] WhatsApp is not connected for organization ${organizationId || "default"}. Skipping welcome message for ${lead.phone}`,
      );
      return null;
    }

    // Duplicate check: Verify that no previous messages exist for this lead
    const existingMessagesCount = await MessageModel.countDocuments({
      leadId: lead._id,
    });
    if (existingMessagesCount > 0) {
      console.log(
        `[WhatsApp Welcome] Lead ${lead.phone} already has conversation history. Skipping welcome message.`,
      );
      return null;
    }

    // Format phone number to JID
    let cleanPhone = String(lead.phone).replace(/\D/g, "");
    if (cleanPhone.length === 10) {
      cleanPhone = "91" + cleanPhone;
    }
    if (!cleanPhone || cleanPhone.length < 10) {
      console.warn(
        `[WhatsApp Welcome] Invalid phone number format: ${lead.phone}`,
      );
      return null;
    }

    const targetJid = `${cleanPhone}@s.whatsapp.net`;
    const leadName = lead.name || "there";
    const leadService =
      lead.service && lead.service !== "General Enquiry"
        ? lead.service
        : "Elevator Solutions";

    const welcomeText = `Hello ${leadName}! 👋\n\nThank you for reaching out to us regarding *${leadService}*. 🏢🛗\n\nWe have received your enquiry and our specialist will connect with you shortly.\n\nFeel free to reply with your building type, number of floors, or specific requirements!`;

    const sendResult = await sock.sendMessage(targetJid, { text: welcomeText });
    const messageId = sendResult.key.id;
    const timestamp = new Date();

    // Create message record in tenant DB
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
    });

    // Update or Create Conversation
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

    // Emit socket updates
    const io = getIO();
    if (io) {
      io.to(lead._id.toString()).emit("new_message", messageRecord);
      const updatePayload = {
        leadId: lead._id,
        unreadCount: 0,
        lastMessage: welcomeText,
        lastMessageTime: timestamp,
      };
      if (organizationId) {
        io.to(`org_${organizationId}`).emit("new_message", messageRecord);
        io.to(`org_${organizationId}`).emit("conversation_updated", updatePayload);
      } else {
        io.emit("conversation_updated", updatePayload);
      }
    }

    console.log(
      `[WhatsApp Welcome] Successfully sent welcome message to ${lead.phone} (${lead.name})`,
    );
    return messageRecord;
  } catch (err) {
    console.error(
      `[WhatsApp Welcome] Error sending welcome message to ${lead?.phone}:`,
      err.message,
    );
    return null;
  }
};

// In-memory cache for settings
let cachedSettings = null;

export const getSystemSettings = async (tenantModelsOrSessionId = null) => {
  let models = null;
  if (tenantModelsOrSessionId && typeof tenantModelsOrSessionId === "object" && tenantModelsOrSessionId.SystemSettings) {
    models = tenantModelsOrSessionId;
  } else if (typeof tenantModelsOrSessionId === "string") {
    models = await getModelsForSession(tenantModelsOrSessionId);
  }
  const SettingsModel = models?.SystemSettings || SystemSettings;

  try {
    let settings = await SettingsModel.findOne();
    if (!settings) {
      settings = await SettingsModel.create({
        globalAIEnabled: true,
        welcomeMessageEnabled: true,
      });
    }
    return settings.toObject ? settings.toObject() : settings;
  } catch (err) {
    console.error("Error loading SystemSettings:", err.message);
    return { globalAIEnabled: true, welcomeMessageEnabled: true };
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
  settings.updatedBy = updatedBy;
  await settings.save();
  const saved = settings.toObject ? settings.toObject() : settings;

  const io = getIO();
  if (io) {
    if (organizationId) {
      io.to(`org_${organizationId}`).emit("global_settings_updated", saved);
    } else {
      io.emit("global_settings_updated", saved);
    }
  }
  return saved;
};

/**
 * Boot reconnection handler: iterates through all active organizations and re-connects
 * saved WhatsApp sessions from each tenant database.
 */
export const initAllOrganizationWhatsAppConnections = async () => {
  console.log("[WhatsApp] Initializing WhatsApp connections for organizations...");
  try {
    const { Organization } = getMasterModels();
    const organizations = await Organization.find({ status: { $ne: "suspended" } });
    console.log(`[WhatsApp] Found ${organizations.length} active organization(s).`);

    for (const org of organizations) {
      try {
        const orgId = org._id.toString();
        const sessionId = `org_${orgId}`;
        const tenantDbName = org.tenantDbName;
        const models = getTenantModels(tenantDbName);

        // Check if credentials exist for this org in its tenant DB
        const existingCreds = await models.WhatsAppAuthState.findOne({
          sessionId,
          type: "creds",
        });

        if (existingCreds) {
          console.log(`[WhatsApp] Found existing credentials for organization "${org.name}" (${sessionId}). Auto-connecting...`);
          await connectWhatsApp({
            sessionId,
            organizationId: orgId,
            tenantDbName,
          });
        } else {
          console.log(`[WhatsApp] No saved session credentials for organization "${org.name}". Ready for linking.`);
        }
      } catch (orgErr) {
        console.error(`[WhatsApp] Error initializing connection for org ${org.name}:`, orgErr);
      }
    }

    // Also check if legacy device_1 exists in base auth collection
    try {
      const WhatsAppAuthStateModel = (await import("../models/WhatsAppAuthState.js")).default;
      const legacyCreds = await WhatsAppAuthStateModel.findOne({ sessionId: "device_1", type: "creds" });
      if (legacyCreds && !sessions["device_1"]) {
        console.log("[WhatsApp] Found legacy credentials for device_1. Auto-connecting...");
        await connectWhatsApp("device_1");
      }
    } catch (legacyErr) {
      console.error("[WhatsApp] Error checking legacy session:", legacyErr);
    }
  } catch (err) {
    console.error("[WhatsApp] Failed to initialize organization WhatsApp connections:", err);
  }
};



