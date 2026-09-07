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

const sessions = {}; // map of sessionId -> { sock, status, qrCode, connectedPhone, connectedName }
export const normalizePhone = (jid) => {
  if (!jid) return "";
  const clean = jid.split("@")[0].split(":")[0];
  return clean.replace(/\D/g, "");
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
    let session = await WhatsAppSession.findOne({ sessionId });
    if (!session) {
      session = new WhatsAppSession({ sessionId });
    }
    session.status = status;
    session.qrCode = qr;
    if (phone) session.connectedPhone = phone;
    if (name) session.connectedName = name;
    await session.save();

    const io = getIO();
    if (io) {
      io.emit("whatsapp_status", {
        sessionId,
        status,
        qrCode: qr,
        connectedPhone: phone || session.connectedPhone,
        connectedName: name || session.connectedName,
      });
    }
  } catch (err) {
    console.error("Failed to update WhatsAppSession in DB:", err);
  }
};
export const connectWhatsApp = async (sessionId) => {
  if (!sessionId) sessionId = "device_1";

  // Prevent duplicate connection attempts for the same active session
  if (sessions[sessionId]) {
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
  }

  try {
    const { state, saveCreds } = await useMongoDBAuthState(sessionId);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    console.log(
      `Initializing WhatsApp connection via Baileys... (Version: ${version.join(".")})`,
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

    if (!sessions[sessionId]) sessions[sessionId] = {};
    sessions[sessionId].sock = sock;

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      console.log(
        "Baileys connection.update event:",
        JSON.stringify({
          connection,
          qr: qr ? "[QR data present]" : undefined,
          lastDisconnect: lastDisconnect?.error?.message,
        }),
      );

      if (qr) {
        console.log("New WhatsApp QR code generated. Please scan.");
        updateSessionStatus(sessionId, "qr", qr);
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMsg = lastDisconnect?.error?.message || "Unknown error";
        console.log(`WhatsApp connection closed. Status code: ${statusCode}`);
        logWhatsAppEvent(`Session: ${sessionId} | CONNECTION DROPPED | Status: ${statusCode} | Reason: ${errMsg}`);
        
        // Critical Fix: Update status to disconnected so the reconnect attempt doesn't abort
        updateSessionStatus(sessionId, "disconnected");

        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut && 
          statusCode !== 403 && 
          statusCode !== 405;
          
        if (shouldReconnect) {
          console.log("Attempting to reconnect WhatsApp in 5 seconds...");
          setTimeout(() => connectWhatsApp(sessionId), 5000);
        } else {
          console.log(
            "WhatsApp session logged out. Cleaning up credentials...",
          );
          logoutWhatsApp(sessionId)
            .then(() => {
              console.log(
                "Credentials cleaned. Reinitializing connection to generate new QR code...",
              );
              setTimeout(() => connectWhatsApp(sessionId), 3000);
            })
            .catch((err) => console.error("Error during logout:", err));
        }
      } else if (connection === "open") {
        const userJid = sock?.user?.id || "";
        const phone = normalizePhone(userJid);
        const name = sock?.user?.name || "WhatsApp Business Agent";

        console.log(
          `WhatsApp is fully connected. Active on: ${phone} (${name})`,
        );
        updateSessionStatus(sessionId, "connected", "", phone, name);
      }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async (m) => {
      try {
        console.log("=== messages.upsert event received ===");
        console.log("Event type:", m.type);
        console.log("Number of messages:", m.messages?.length);

        const messages = m.messages || [];
        const eventType = m.type;

        for (const msg of messages) {
          console.log("Message key:", JSON.stringify(msg.key));
          console.log("Message fromMe:", msg.key.fromMe);
          console.log("Message type:", Object.keys(msg.message || {}));
          console.log("Push name:", msg.pushName);

          if (eventType === "notify" || eventType === "append") {
            console.log(
              `Processing message from: ${msg.key.remoteJid} (fromMe: ${msg.key.fromMe})`,
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
        console.error("Error in messages.upsert handler:", err);
      }
    });
  } catch (error) {
    console.error("Fatal error during WhatsApp initialization:", error);
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

  // Delete credentials from MongoDB
  try {
    const WhatsAppAuthState = (await import("../models/WhatsAppAuthState.js"))
      .default;
    await WhatsAppAuthState.deleteMany({ sessionId });
  } catch (err) {
    console.error("Failed to clear MongoDB auth state:", err);
  }

  console.log("WhatsApp session terminated and auth files removed.");
  updateSessionStatus(sessionId, "disconnected", "", "", "");
};

const handleIncomingOrOutgoingMessage = async (msg, sessionId, fromMe) => {
  try {
    const messageId = msg.key.id;

    // 1. Check if message already exists in DB to avoid duplicate processing
    const existingMsg = await Message.findOne({ messageId });
    if (existingMsg) {
      console.log(
        `[DEBUG] Message ${messageId} already exists in DB. Skipping to avoid duplicates.`,
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
      `Processing message - Phone: ${phone}, Name: ${pushName}, JID: ${remoteJid}, AltJID: ${remoteJidAlt || "none"}, isLid: ${isLid}`,
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

    console.log(`[DEBUG] Finding lead in DB for phone: ${phone}`);
    let lead = await Lead.findOne({
      $or: [{ phone: phone }, { phone: new RegExp(phone.slice(-10) + "$") }],
    });

    let isNewLead = false;

    if (!lead) {
      // Do NOT create a lead if the identifier is a LID (not a real phone number)
      // or if the message is outgoing (sent by us/fromMe) to a non-existent lead
      if (isLid || msg.key.fromMe) {
        console.log(
          `[DEBUG] Skipping lead creation for LID or outgoing message. Phone/LID: ${phone}`,
        );
        return;
      }

      console.log(`[DEBUG] Lead not found, creating new lead for ${pushName}`);
      isNewLead = true;
      lead = new Lead({
        name: pushName,
        phone: phone,
        source: "WhatsApp",
        service: detectedService || "General Enquiry", // Satisfies MongoDB required field
        status: "New",
        joinedAt: new Date(),
        notes: fromMe
          ? `Created via WhatsApp outgoing message: "${textContent.substring(0, 100)}"`
          : `Discovered via WhatsApp message: "${textContent.substring(0, 100)}"`,
      });

      // Round-robin assignment logic for sales agents
      console.log(`[DEBUG] Assigning lead via round-robin...`);
      const representatives = await User.find({ role: "sales person" }).sort({
        _id: 1,
      });
      if (representatives && representatives.length > 0) {
        let state = await AssignmentState.findOne({ key: "leadAssignment" });
        if (!state) {
          state = await AssignmentState.create({
            key: "leadAssignment",
            lastAssignedIndex: -1,
          });
        }

        let nextIndex = state.lastAssignedIndex + 1;
        if (nextIndex >= representatives.length) {
          nextIndex = 0;
        }

        lead.assignedTo = representatives[nextIndex].name;
        state.lastAssignedIndex = nextIndex;
        await state.save();
      }

      await lead.save();

      // Create Lead Notification
      const assignedAgent = await User.findOne({ name: lead.assignedTo });
      const targetUsers = assignedAgent ? [assignedAgent._id] : [];
      await Notification.create({
        title: fromMe
          ? "New WhatsApp Outgoing Lead Capture"
          : "New WhatsApp Lead Capture",
        message: fromMe
          ? `New WhatsApp lead captured from outgoing message to ${lead.phone} and assigned to ${lead.assignedTo}.`
          : `New WhatsApp lead captured from ${lead.name} (${lead.phone}) and assigned to ${lead.assignedTo}.`,
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

      await Lead.findByIdAndUpdate(lead._id, {
        $set: updatedFields,
      });
    }

    // 3. Create message record
    const isFromMe = msg.key.fromMe;
    const messageRecord = await Message.create({
      messageId,
      leadId: lead._id,
      sender: isFromMe ? "Kranthi Elevators user" : phone,
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
    let conversation = await Conversation.findOne({ leadId: lead._id });
    if (!conversation) {
      conversation = new Conversation({
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

    // 5. Broadcast message to frontend clients
    const io = getIO();
    if (io) {
      // Broadcast to room
      io.to(lead._id.toString()).emit("new_message", messageRecord);
      // General conversation list update broadcast
      io.emit("conversation_updated", {
        leadId: lead._id,
        unreadCount: conversation.unreadCount,
        lastMessage: textContent,
        lastMessageTime: timestamp,
        isNewLead,
        lead,
      });
    }

    console.log(
      `[DEBUG] Successfully processed and broadcasted message to lead ID: ${lead._id}`,
    );

    // 6. Asynchronously trigger AI agent response with 4-second debounce
    const settings = await getSystemSettings();
    if (!isFromMe && lead.aiEnabled && settings.globalAIEnabled) {
      console.log(`[DEBUG] Queueing AI auto-reply for lead ID: ${lead._id}`);
      triggerAIDebounced(lead, remoteJid, textContent, sessionId);
    } else if (!isFromMe && lead.aiEnabled && !settings.globalAIEnabled) {
      console.log(
        `[DEBUG] Global AI is paused. Skipping AI auto-reply for lead ID: ${lead._id}`,
      );
    }
  } catch (error) {
    console.error(
      "Error processing incoming/outgoing WhatsApp message:",
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

const triggerAIDebounced = (lead, remoteJid, incomingText, sessionId) => {
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
      triggerAIDebounced(lead, remoteJid, "", sessionId);
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
        await processAIResponse(lead, remoteJid, batchedText, sessionId);
      } finally {
        aiIsProcessing[leadId] = false;
        // Process any messages that arrived while AI was thinking
        if (aiAccumulatedText[leadId]) {
          triggerAIDebounced(lead, remoteJid, "", sessionId);
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
const processAIResponse = async (lead, remoteJid, incomingText, sessionId) => {
  try {
    // Emit typing status over socket.io
    const io = getIO();
    if (io) {
      io.to(lead._id.toString()).emit("typing_status", {
        leadId: lead._id,
        isTyping: true,
      });
    }

    // Call Gemini Agent
    const replyText = await generateAIResponse(lead._id, incomingText);

    // Disable AI mode if fallback message is returned
    const fallbackMessage =
      "I'm sorry, but I'm unable to assist with this request right now. I'll connect you with one of our team members, who will continue assisting you shortly.";
    if (replyText === fallbackMessage) {
      await Lead.findByIdAndUpdate(lead._id, { aiEnabled: false });
      const io = getIO();
      if (io) {
        io.to(lead._id.toString()).emit("conversation_updated", {
          leadId: lead._id,
        });
      }
      await Notification.create({
        title: "AI Disabled - Fallback Triggered",
        message: `AI has been disabled for ${lead.name} (${lead.phone}) because it sent the fallback message.`,
        type: "lead_update",
        targetRoles: ["sales manager", "sales person"],
      });
    }

    // Send the reply message using Baileys
    const sock =
      sessions[sessionId]?.sock ||
      Object.values(sessions).find((s) => s.status === "connected")?.sock;
    if (sock) {
      const sendResult = await sock.sendMessage(remoteJid, { text: replyText });

      const outgoingId = sendResult.key.id;
      const outboundTimestamp = new Date();

      // Save outgoing message to DB
      const replyRecord = await Message.create({
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
      await Conversation.findOneAndUpdate(
        { leadId: lead._id },
        {
          lastMessage: replyText,
          lastMessageTime: outboundTimestamp,
        },
      );

      // Emit new outbound message over Socket
      if (io) {
        io.to(lead._id.toString()).emit("new_message", replyRecord);
        io.emit("conversation_updated", {
          leadId: lead._id,
          lastMessage: replyText,
          lastMessageTime: outboundTimestamp,
        });
      }
    }

    // Turn off typing indicator
    if (io) {
      io.to(lead._id.toString()).emit("typing_status", {
        leadId: lead._id,
        isTyping: false,
      });
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
) => {
  const sock = Object.values(sessions).find(
    (s) => s.status === "connected",
  )?.sock;
  if (!sock) {
    throw new Error("WhatsApp client is not connected!");
  }

  const lead = await Lead.findById(leadId);
  if (!lead) {
    throw new Error("Lead not found!");
  }

  // Format destination jid
  const targetJid = `${lead.phone}@s.whatsapp.net`;

  const sendResult = await sock.sendMessage(targetJid, { text: messageText });
  const messageId = sendResult.key.id;
  const timestamp = new Date();

  // Create message record
  const messageRecord = await Message.create({
    messageId,
    leadId: lead._id,
    sender: "Kranthi Elevators user",
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
  await Conversation.findOneAndUpdate(
    { leadId: lead._id },
    {
      lastMessage: messageText,
      lastMessageTime: timestamp,
      unreadCount: 0, // Reset since agent is chatting active
    },
  );

  // Emit socket updates
  const io = getIO();
  if (io) {
    io.to(lead._id.toString()).emit("new_message", messageRecord);
    io.emit("conversation_updated", {
      leadId: lead._id,
      unreadCount: 0,
      lastMessage: messageText,
      lastMessageTime: timestamp,
    });
  }

  return messageRecord;
};

/**
 * Expose connection status getter
 */
export const getWhatsAppStatus = () => {
  return Object.keys(sessions).map((sessionId) => ({
    sessionId,
    status: sessions[sessionId].status,
    qrCode: sessions[sessionId].qrCode,
    connectedPhone: sessions[sessionId].connectedPhone,
    connectedName: sessions[sessionId].connectedName,
  }));
};

/**
 * Send an automated follow-up with an image and caption.
 */
export const sendAutomatedFollowup = async (lead, imageUrl, text) => {
  const sock = Object.values(sessions).find(
    (s) => s.status === "connected",
  )?.sock;
  if (!sock) {
    throw new Error("WhatsApp client is not connected!");
  }

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
  const messageRecord = await Message.create({
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
  await Conversation.findOneAndUpdate(
    { leadId: lead._id },
    {
      lastMessage: text, // Show caption as last message
      lastMessageTime: timestamp,
    },
  );

  // Emit socket updates
  const io = getIO();
  if (io) {
    io.to(lead._id.toString()).emit("new_message", messageRecord);
    io.emit("conversation_updated", {
      leadId: lead._id,
      lastMessage: text,
      lastMessageTime: timestamp,
    });
  }

  return messageRecord;
};

/**
 * Send an automated WhatsApp welcome message for brand new enquiry leads.
 * Triggered only for external sources (Web Form, Call, Email, Meta Ads, Mobile App).
 * NOT sent for Manual Entry or if previous messages already exist for this lead.
 */
export const sendWelcomeEnquiryMessage = async (lead) => {
  try {
    if (!lead || !lead.phone) return null;

    // Check if Welcome Messages are globally enabled
    const settings = await getSystemSettings();
    if (!settings.welcomeMessageEnabled) {
      console.log(
        `[WhatsApp Welcome] Automated Welcome Messages are globally paused. Skipping welcome message for ${lead.phone}`,
      );
      return null;
    }

    // Exclude manual entry
    if (lead.source === "Manual Entry") {
      return null;
    }

    // Find active connected WhatsApp socket
    const sock = Object.values(sessions).find(
      (s) => s.status === "connected",
    )?.sock;

    if (!sock) {
      console.warn(
        `[WhatsApp Welcome] WhatsApp is not connected. Skipping welcome message for ${lead.phone}`,
      );
      return null;
    }

    // Duplicate check: Verify that no previous messages exist for this lead
    const existingMessagesCount = await Message.countDocuments({
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

    const welcomeText = `Hello ${leadName}! 👋

Thank you for reaching out to *Kranthi Elevators* regarding *${leadService}*. 🏢🛗

We have received your enquiry and our specialist will connect with you shortly.

Feel free to reply with your building type, number of floors, or specific lift requirements!`;

    const sendResult = await sock.sendMessage(targetJid, { text: welcomeText });
    const messageId = sendResult.key.id;
    const timestamp = new Date();

    // Create message record
    const messageRecord = await Message.create({
      messageId,
      leadId: lead._id,
      sender: "system",
      senderName: "Kranthi Elevators Automated Welcome",
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
    await Conversation.findOneAndUpdate(
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
      io.emit("conversation_updated", {
        leadId: lead._id,
        unreadCount: 0,
        lastMessage: welcomeText,
        lastMessageTime: timestamp,
      });
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

// In-memory cache for global settings to avoid DB querying on every message
let cachedSettings = null;

export const getSystemSettings = async () => {
  if (cachedSettings) return cachedSettings;
  try {
    let settings = await SystemSettings.findOne();
    if (!settings) {
      settings = await SystemSettings.create({
        globalAIEnabled: true,
        welcomeMessageEnabled: true,
      });
    }
    cachedSettings = settings.toObject ? settings.toObject() : settings;
    return cachedSettings;
  } catch (err) {
    console.error("Error loading SystemSettings:", err.message);
    return { globalAIEnabled: true, welcomeMessageEnabled: true };
  }
};

export const updateSystemSettings = async (updates, updatedBy = "User") => {
  let settings = await SystemSettings.findOne();
  if (!settings) {
    settings = new SystemSettings();
  }
  if (updates.globalAIEnabled !== undefined) {
    settings.globalAIEnabled = updates.globalAIEnabled;
  }
  if (updates.welcomeMessageEnabled !== undefined) {
    settings.welcomeMessageEnabled = updates.welcomeMessageEnabled;
  }
  settings.updatedBy = updatedBy;
  await settings.save();
  cachedSettings = settings.toObject ? settings.toObject() : settings;

  const io = getIO();
  if (io) {
    io.emit("global_settings_updated", cachedSettings);
  }
  return cachedSettings;
};


