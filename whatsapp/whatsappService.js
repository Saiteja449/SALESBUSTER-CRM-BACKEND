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

// Timing constants for connection lifecycle and watchdog
const RECONNECT_DELAY_MS = 5000;    // Wait 5s before reconnecting after transient socket drop (gives socket/server time to settle)
const WATCHDOG_INTERVAL_MS = 60000; // Run watchdog health check every 60s
const KEEPALIVE_INTERVAL_MS = 20000;// Send ping every 20s to prevent VPS/NAT firewall from dropping idle socket

// Per-sessionId async mutex: ensures only one connectWhatsApp execution can run at a time per session
const connectionLocks = new Map(); // sessionId -> Promise

// Tracks active reconnect timeout handles per sessionId to coordinate between close handler and watchdog
const reconnectTimers = new Map(); // sessionId -> timeoutHandle

const sessions = {}; // map of sessionId -> { sock, status, qrCode, connectedPhone, connectedName, organizationId, tenantDbName }

/**
 * Schedules a delayed reconnect for a session, coordinating between the close handler and watchdog.
 * Clears any existing timer so duplicate reconnects are never queued for the same session.
 */
const scheduleReconnect = (sessionId, delayMs = RECONNECT_DELAY_MS) => {
  if (reconnectTimers.has(sessionId)) {
    clearTimeout(reconnectTimers.get(sessionId));
  }
  const timer = setTimeout(() => {
    reconnectTimers.delete(sessionId);
    connectWhatsApp({
      sessionId,
      organizationId: sessions[sessionId]?.organizationId,
      tenantDbName: sessions[sessionId]?.tenantDbName,
    });
  }, delayMs);
  reconnectTimers.set(sessionId, timer);
};

// AI Pause Management — tracks 5-minute snooze timers per lead
const aiPauseTimers = {}; // leadIdStr -> setTimeout handle
// Tracks lead IDs that have an ongoing automated send (AI reply, follow-up, welcome message)
// Used to distinguish automated outgoing messages from manual ones in messages.upsert handler
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
  if (!sessions[sessionId].organizationId && sessionId.startsWith("org_")) {
    const match = sessionId.match(/^org_([a-fA-F0-9]{24})/);
    if (match) sessions[sessionId].organizationId = match[1];
  }

  // For 'pairing' status, persist as 'connecting' in DB (it's an intermediate state)
  // but keep 'pairing' in memory so frontend can distinguish it
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
  let sessionId, organizationId, tenantDbName, usePairingCode, pairingPhone;
  if (typeof param1 === "object" && param1 !== null) {
    sessionId = param1.sessionId;
    organizationId = param1.organizationId;
    tenantDbName = param1.tenantDbName;
    usePairingCode = param1.usePairingCode || false;
    pairingPhone = param1.pairingPhone || "";
  } else {
    sessionId = param1;
    organizationId = param2;
    tenantDbName = param3;
    usePairingCode = false;
    pairingPhone = "";
  }

  if (!sessionId && organizationId) {
    sessionId = `org_${organizationId}`;
  }
  if (!sessionId) {
    sessionId = "device_1";
  }

  // Clear any pending delayed reconnect timer for this session since connectWhatsApp is now actively running
  if (reconnectTimers.has(sessionId)) {
    clearTimeout(reconnectTimers.get(sessionId));
    reconnectTimers.delete(sessionId);
  }

  if (!sessions[sessionId]) {
    sessions[sessionId] = { status: "disconnected" };
  }
  if (organizationId) sessions[sessionId].organizationId = organizationId;
  if (tenantDbName) sessions[sessionId].tenantDbName = tenantDbName;

  // Synchronous duplicate guard: if already connected or actively connecting, return immediately.
  // Setting status = "connecting" synchronously BEFORE any await closes the race window
  // where multiple concurrent callers pass the guard before auth state loads.
  if (
    sessions[sessionId].status === "connected" ||
    sessions[sessionId].status === "connecting"
  ) {
    console.log(
      `[DEBUG] WhatsApp session ${sessionId} is already active (${sessions[sessionId].status}). Skipping connect.`,
    );
    return;
  }

  // Set status to "connecting" synchronously BEFORE any await to close the race window
  sessions[sessionId].status = "connecting";

  // Per-session mutex lock: queue execution behind any pending operation for this sessionId
  const currentLock = connectionLocks.get(sessionId) || Promise.resolve();

  const executeConnect = async () => {
    // Re-verify status after acquiring lock in case session reached connected state while queued
    if (sessions[sessionId]?.status === "connected") {
      console.log(`[DEBUG] WhatsApp session ${sessionId} already connected before lock execution. Skipping.`);
      return;
    }

    // Clean up dangling socket before starting a new connection
    if (sessions[sessionId]?.sock) {
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

      // Note: printQRInTerminal is intentionally omitted as it is deprecated in modern Baileys
      const sock = makeWASocket({
        auth: state,
        version,
        logger: pino({ level: "silent" }),
        keepAliveIntervalMs: KEEPALIVE_INTERVAL_MS,
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
      });

      sessions[sessionId].sock = sock;

      // =========================================================
      // PAIRING CODE MODE
      // When usePairingCode=true, we request a pairing code from
      // Baileys right after socket init (before QR fires).
      // Baileys will not emit a QR in this mode.
      // =========================================================
      if (usePairingCode && pairingPhone && !state.creds.registered) {
        // Wait briefly for the socket internal state to be ready
        setTimeout(async () => {
          try {
            // Stale socket guard: only proceed if this socket is still the active one
            if (sessions[sessionId]?.sock !== sock) return;

            const code = await sock.requestPairingCode(pairingPhone);
            // Format as ABCD-1234
            const formatted = code?.match(/.{1,4}/g)?.join("-") || code || "";

            console.log(`[WhatsApp] Pairing code for ${sessionId}: ${formatted}`);
            logWhatsAppEvent(`Session: ${sessionId} | PAIRING CODE ISSUED | Phone: ${pairingPhone} | Code: ${formatted}`);

            if (sessions[sessionId]) {
              sessions[sessionId].pairingCode = formatted;
              sessions[sessionId].status = "pairing";
            }

            // Emit 'pairing' status update + dedicated pairing_code event
            updateSessionStatus(sessionId, "pairing");

            const io = getIO();
            if (io) {
              const pairingPayload = {
                sessionId,
                organizationId: sessions[sessionId]?.organizationId,
                pairingCode: formatted,
              };
              if (sessions[sessionId]?.organizationId) {
                io.to(`org_${sessions[sessionId].organizationId}`).emit("whatsapp_pairing_code", pairingPayload);
              } else {
                io.emit("whatsapp_pairing_code", pairingPayload);
              }
            }
          } catch (pairingErr) {
            console.error(`[WhatsApp] Failed to request pairing code for ${sessionId}:`, pairingErr.message);
            logWhatsAppEvent(`Session: ${sessionId} | PAIRING CODE FAILED | ${pairingErr.message}`);
            updateSessionStatus(sessionId, "disconnected");
          }
        }, 3000);
      }
      // =========================================================
      // END PAIRING CODE MODE
      // =========================================================

      sock.ev.on("connection.update", async (update) => {
        // Stale socket guard: ignore events from old/destroyed sockets if a newer socket has been assigned
        if (sessions[sessionId]?.sock !== sock) {
          console.log(`[WhatsApp] Ignoring connection.update event from stale socket for ${sessionId}.`);
          return;
        }

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
          console.log(`WhatsApp connection closed for ${sessionId}. Status code: ${statusCode}, Reason: ${errMsg}`);
          logWhatsAppEvent(`Session: ${sessionId} | CONNECTION DROPPED | Status: ${statusCode} | Reason: ${errMsg}`);
          
          const wasInQrState = sessions[sessionId]?.status === "qr";

          // Clean up socket reference in memory if it matches this socket
          if (sessions[sessionId]?.sock === sock) {
            sessions[sessionId].sock = null;
          }

          // Check if connection was closed because QR code expired (408 or "QR refs attempts ended")
          const isQrExpired =
            statusCode === 408 &&
            (errMsg.includes("QR refs") || wasInQrState);

          // Check if device was explicitly unlinked / logged out
          const isLoggedOut =
            statusCode === DisconnectReason.loggedOut ||
            statusCode === 401 ||
            statusCode === 403 ||
            statusCode === 405;

          // Update status to disconnected
          updateSessionStatus(sessionId, "disconnected");

          // Guard against QR generation loops:
          // If the session was waiting for a QR scan or the QR expired, DO NOT auto-reconnect.
          // Wait for the user to explicitly click "Connect / Show QR" in the frontend.
          if (isQrExpired || wasInQrState) {
            console.log(`[WhatsApp] QR code session closed for ${sessionId}. Stopping auto-reconnect loop until user requests new QR.`);
            return;
          }

          if (isLoggedOut) {
            console.log(
              `[WhatsApp] WhatsApp session ${sessionId} logged out on mobile device. Cleaning up credentials...`,
            );
            logoutWhatsApp(sessionId).catch((err) =>
              console.error("Error during logout:", err),
            );
            return;
          }

          // Only auto-reconnect if this session was already paired (has valid credentials in MongoDB).
          // Unpaired / initial sessions must never auto-reconnect or flap every 5 seconds.
          try {
            const models = await getModelsForSession(sessionId);
            const AuthModel = models?.WhatsAppAuthState || (await import("../models/WhatsAppAuthState.js")).default;
            const hasCreds = await AuthModel.findOne({ sessionId, type: "creds" });
            if (!hasCreds) {
              console.log(`[WhatsApp] Session ${sessionId} has no saved credentials. Skipping auto-reconnect to prevent QR generation loops.`);
              return;
            }
          } catch (credsErr) {
            console.error(`[WhatsApp] Error verifying credentials before reconnect for ${sessionId}:`, credsErr);
            return;
          }

          // Schedule delayed reconnect for already-paired sessions using the shared reconnect timer
          console.log(`[WhatsApp] Scheduling reconnect for paired session ${sessionId} in ${RECONNECT_DELAY_MS / 1000}s... (Status: ${statusCode})`);
          scheduleReconnect(sessionId, RECONNECT_DELAY_MS);
        } else if (connection === "open") {
          // Clear any scheduled reconnect timer upon successful connection
          if (reconnectTimers.has(sessionId)) {
            clearTimeout(reconnectTimers.get(sessionId));
            reconnectTimers.delete(sessionId);
          }

          const userJid = sock?.user?.id || "";
          const phone = normalizePhone(userJid);
          const name = sock?.user?.name || "WhatsApp Business Agent";

          // =========================================================
          // =========================================================
          // PHONE VERIFICATION GATE — Sales Rep sessions only
          // Ensures the scanned WhatsApp number strictly matches the rep's
          // registered profile phone. Fails closed on mismatch or error.
          // =========================================================
          if (sessionId.includes("_user_")) {
            const userMatch = sessionId.match(/_user_([a-fA-F0-9]{24})$/);
            if (!userMatch) {
              console.warn(`[WhatsApp] Invalid rep sessionId format: ${sessionId}`);
              try { sock.end(); } catch (e) {}
              return;
            }

            const repUserId = userMatch[1];

            // Helper to cleanly abort session, purge auth keys, update DB, and notify UI
            const abortRepSession = async (errorMessage, logReason) => {
              console.warn(`[WhatsApp] ABORTING ${sessionId}: ${logReason}`);
              logWhatsAppEvent(`Session: ${sessionId} | REJECTED | ${logReason}`);

              try { await sock.logout(); } catch (e) {}
              try { sock.end(); } catch (e) {}
              if (sessions[sessionId]) sessions[sessionId].sock = null;

              try {
                const models = await getModelsForSession(sessionId);
                const AuthModel =
                  models?.WhatsAppAuthState ||
                  (await import("../models/WhatsAppAuthState.js")).default;
                await AuthModel.deleteMany({ sessionId });

                const SessionModel = models?.WhatsAppSession || WhatsAppSession;
                await SessionModel.findOneAndUpdate(
                  { sessionId },
                  {
                    status: "disconnected",
                    errorMessage,
                    qrCode: "",
                    connectedPhone: "",
                    connectedName: "",
                  },
                  { upsert: true }
                );
              } catch (dbErr) {
                console.error(`[WhatsApp] Cleanup error for aborted session ${sessionId}:`, dbErr.message);
              }

              if (sessions[sessionId]) {
                sessions[sessionId].status = "disconnected";
                sessions[sessionId].qrCode = "";
              }

              const io = getIO();
              if (io && sessions[sessionId]?.organizationId) {
                io.to(`org_${sessions[sessionId].organizationId}`).emit("whatsapp_status", {
                  sessionId,
                  organizationId: sessions[sessionId].organizationId,
                  status: "disconnected",
                  error: "phone_mismatch",
                  errorMessage,
                  qrCode: "",
                  connectedPhone: "",
                  connectedName: "",
                });
              }
            };

            try {
              const models = await getModelsForSession(sessionId);
              const UserModel = models?.User || User;
              const repUser = await UserModel.findById(repUserId).select("phone name").lean();

              // Strict Requirement: Rep record and registered phone MUST exist
              if (!repUser || !repUser.phone || !repUser.phone.trim()) {
                await abortRepSession(
                  "Sales representative profile or registered phone number not found. Access denied.",
                  `Rep user ${repUserId} missing or has no phone in profile.`
                );
                return;
              }

              const profilePhone = repUser.phone.trim();
              const isMatch = verifyPhoneNumberMatch(userJid, profilePhone);

              if (!isMatch) {
                const scannedPhone = normalizePhone(userJid);
                const mismatchMsg = `Phone number mismatch: You scanned with +${scannedPhone}, but your administrator registered your profile with ${profilePhone.startsWith("+") ? profilePhone : `+${profilePhone}`}. Please connect your authorized number.`;
                await abortRepSession(
                  mismatchMsg,
                  `Phone mismatch: Scanned +${scannedPhone} does not match expected profile ${profilePhone}`
                );
                return;
              }

              // Match passed: persist userId & expectedPhone to session record
              try {
                const SessionModel = models?.WhatsAppSession || WhatsAppSession;
                await SessionModel.findOneAndUpdate(
                  { sessionId },
                  {
                    userId: repUserId,
                    expectedPhone: profilePhone.replace(/\D/g, ""),
                    errorMessage: "",
                  },
                  { upsert: true }
                );
                console.log(
                  `[WhatsApp] Phone verification PASSED for ${sessionId}. Rep: ${repUser.name}, Phone: ${profilePhone}`
                );
              } catch (persistErr) {
                console.error(
                  `[WhatsApp] Failed to persist userId to session record for ${sessionId}:`,
                  persistErr
                );
              }
            } catch (verifyErr) {
              // Critical: FAIL CLOSED on error to prevent account sharing
              console.error(
                `[WhatsApp] Critical error during phone verification for ${sessionId} (FAILING CLOSED):`,
                verifyErr
              );
              await abortRepSession(
                "Phone verification failed due to internal error. Connection rejected for security.",
                `Verification exception: ${verifyErr.message}`
              );
              return;
            }
          }
          // =========================================================
          // END PHONE VERIFICATION GATE
          // =========================================================

          console.log(
            `WhatsApp is fully connected for ${sessionId}. Active on: ${phone} (${name})`,
          );
          updateSessionStatus(sessionId, "connected", "", phone, name);
        }
      });


      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("messages.upsert", async (m) => {
        // Stale socket guard: ignore message events from old/closed sockets
        if (sessions[sessionId]?.sock !== sock) {
          return;
        }

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

            // Skip WhatsApp stub / system events (e.g. disappearing messages setting toggled, group changes, etc.)
            if (msg.messageStubType) {
              console.log(
                `Skipping system stub message (${msg.messageStubType}) on session ${sessionId}`,
              );
              continue;
            }

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

  const lockPromise = currentLock
    .then(executeConnect)
    .catch((err) => {
      console.error(`[WhatsApp] Error in connectWhatsApp lock execution for ${sessionId}:`, err);
    })
    .finally(() => {
      // Clean up lock if we are the last in the chain
      if (connectionLocks.get(sessionId) === lockPromise) {
        connectionLocks.delete(sessionId);
      }
    });

  connectionLocks.set(sessionId, lockPromise);
  return lockPromise;
};

export const logoutWhatsApp = async (sessionId) => {
  if (!sessionId) return;

  // Clear any pending reconnect timer
  if (reconnectTimers.has(sessionId)) {
    clearTimeout(reconnectTimers.get(sessionId));
    reconnectTimers.delete(sessionId);
  }

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

    if (msg.messageStubType) {
      console.log(`[DEBUG] Skipping stub message (${msg.messageStubType}) for ${sessionId}`);
      return;
    }

    let messageType = "text";
    let textContent = "";
    let mediaUrl = "";

    let msgContent = msg.message;
    if (!msgContent || Object.keys(msgContent).length === 0) return;

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

    if (!msgContent || Object.keys(msgContent).length === 0) return;

    // Ignore reactions, disappearing message setting protocols, and non-conversational system events
    if (
      msgContent.reactionMessage ||
      msgContent.protocolMessage ||
      msgContent.pollUpdateMessage ||
      msgContent.keepInChatMessage ||
      msgContent.senderKeyDistributionMessage ||
      msgContent.peerDataOperationRequestMessage ||
      msgContent.ephemeralSettingMessage
    ) {
      console.log(
        `[DEBUG] Ignoring non-conversational message event (${Object.keys(msgContent).join(", ")}) for ${sessionId}`,
      );
      return;
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
      console.log(
        `[DEBUG] Skipping unsupported message structure (${Object.keys(msgContent).join(", ")}) for ${sessionId}`,
      );
      return;
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

    // Detect if this is a rep's personal session — used for direct assignment and message tagging
    const repUserMatch = sessionId.match(/_user_([a-fA-F0-9]{24})$/);
    const isRepSession = !!repUserMatch;
    const repSessionUserId = repUserMatch ? repUserMatch[1] : null;

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

      let assignedRep = null;

      if (isRepSession && repSessionUserId) {
        // =====================================================
        // DIRECT ASSIGNMENT — bypass round-robin for rep sessions
        // Inbound messages on a rep's personal line go straight
        // to that rep without touching the round-robin counter.
        // =====================================================
        lead.assignedTo = repSessionUserId;
        const repUser = await UserModel.findById(repSessionUserId).select("name").lean();
        assignedRep = repUser;
        assignedRepName = repUser?.name || "Sales Representative";
        console.log(
          `[DEBUG] Rep-session lead: direct assignment to rep ${repSessionUserId} (${assignedRepName})`
        );
      } else {
        // Standard round-robin assignment for admin/org sessions
        console.log(`[DEBUG] Assigning lead via round-robin...`);
        const representatives = await UserModel.find({ role: "sales person" }).sort({
          _id: 1,
        });
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
          assignedRepName = assignedRep?.name || "Sales Representative";
        }
      }

      await lead.save();

      // Create Lead Notification in tenant DB
      const targetUsers = assignedRep ? [assignedRep._id] : [];
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

    // 3. Create message record — include session traceability fields
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
      // Multi-user session traceability
      sessionId: sessionId || null,
      salesRepId: isRepSession && repSessionUserId ? repSessionUserId : null,
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

      // Non-sensitive metadata ONLY to the general organization room (no message text, no contact details)
      const convMetaPayload = {
        leadId: lead._id,
        timestamp: timestamp || new Date(),
      };

      if (orgId) {
        io.to(`org_${orgId}`).emit("conversation_updated", convMetaPayload);
      } else {
        io.emit("conversation_updated", convMetaPayload);
      }

      const assignedUserId = lead.assignedTo
        ? (typeof lead.assignedTo === "object" ? lead.assignedTo._id || lead.assignedTo.id : lead.assignedTo).toString()
        : null;

      // Rich conversation details sent strictly to leadership and assigned representative
      const convRichPayload = {
        leadId: lead._id,
        unreadCount: conversation.unreadCount,
        lastMessage: textContent,
        lastMessageTime: timestamp,
        isNewLead,
        lead,
      };

      if (orgId) {
        io.to(`org_${orgId}_admins`).emit("conversation_updated_rich", convRichPayload);
      }
      if (assignedUserId) {
        io.to(`user_${assignedUserId}`).emit("conversation_updated_rich", convRichPayload);
      }

      // Broadcast new lead alert toast event (ONLY to leadership and assigned representative)
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
          io.to(`org_${orgId}_admins`).emit("whatsapp_new_lead", newLeadAlertPayload);
        }
        if (assignedUserId) {
          io.to(`user_${assignedUserId}`).emit("whatsapp_new_lead", newLeadAlertPayload);
        }
        console.log(`[DEBUG] Emitted whatsapp_new_lead alert for ${lead.phone} (${lead.name})`);
      }
    }

    console.log(
      `[DEBUG] Successfully processed and broadcasted message to lead ID: ${lead._id} (Session: ${sessionId})`,
    );

    // 5b. Detect manual outgoing messages and pause AI for 5 minutes
    //     Manual = sent from WhatsApp mobile/web by a human, NOT by AI/automation
    const leadIdStr = lead._id.toString();
    if (isFromMe && !automatedSendInProgress.has(leadIdStr)) {
      // Only pause if AI is currently enabled (don't interfere with permanent disable)
      if (lead.aiEnabled) {
        const orgId = sessions[sessionId]?.organizationId;
        await pauseAIForLead(lead._id, models, orgId);
        console.log(`[AI SNOOZE] Detected manual outgoing message for lead ${leadIdStr}. Pausing AI for 5 minutes.`);
      }
    }

    // 6. Asynchronously trigger AI agent response with 4-second debounce
    const settings = await getSystemSettings(models);
    const isAiPaused = lead.aiPausedUntil && new Date(lead.aiPausedUntil) > new Date();
    if (
      !isFromMe &&
      lead.aiEnabled &&
      !isAiPaused &&
      settings.globalAIEnabled &&
      textContent &&
      textContent.trim()
    ) {
      console.log(`[DEBUG] Queueing AI auto-reply for lead ID: ${lead._id} on session ${sessionId}`);
      triggerAIDebounced(lead, remoteJid, textContent, sessionId, models);
    } else if (!isFromMe && lead.aiEnabled && isAiPaused) {
      console.log(
        `[AI SNOOZE] AI auto-reply skipped for lead ID: ${lead._id}. AI is paused until ${lead.aiPausedUntil}.`,
      );
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

/**
 * Temporarily pause AI auto-replies for a lead for a given duration.
 * When a human agent sends a manual message (from mobile or CRM), AI is
 * snoozed so the agent can have a live conversation without AI interference.
 * After the duration elapses, AI auto-replies resume automatically.
 */
const pauseAIForLead = async (leadId, models, orgId, durationMs = 5 * 60 * 1000) => {
  const leadIdStr = leadId.toString();
  const LeadModel = models?.Lead || Lead;

  // 1. Cancel any pending AI debounce timer and accumulated text for this lead
  if (aiDebounceTimers[leadIdStr]) {
    clearTimeout(aiDebounceTimers[leadIdStr]);
    delete aiDebounceTimers[leadIdStr];
  }
  delete aiAccumulatedText[leadIdStr];

  // 2. Cancel any existing resume timer (reset behavior on subsequent manual messages)
  if (aiPauseTimers[leadIdStr]) {
    clearTimeout(aiPauseTimers[leadIdStr]);
    delete aiPauseTimers[leadIdStr];
  }

  // 3. Persist pause timestamp in DB (survives server restarts)
  const pauseUntil = new Date(Date.now() + durationMs);
  await LeadModel.findByIdAndUpdate(leadId, { aiPausedUntil: pauseUntil });

  console.log(`[AI SNOOZE] Pausing AI for lead ${leadIdStr} until ${pauseUntil.toISOString()}`);

  // 4. Notify connected frontends immediately
  const io = getIO();
  if (io) {
    const payload = { leadId: leadIdStr, aiPausedUntil: pauseUntil.toISOString() };
    io.to(leadIdStr).emit("ai_status_updated", payload);
    if (orgId) {
      io.to(`org_${orgId}`).emit("ai_status_updated", payload);
    } else {
      io.emit("ai_status_updated", payload);
    }
  }

  // 5. Set in-memory timer to auto-resume and notify frontends
  aiPauseTimers[leadIdStr] = setTimeout(async () => {
    try {
      delete aiPauseTimers[leadIdStr];
      // Re-fetch to check if still paused (could have been manually resumed via toggle)
      const freshLead = await LeadModel.findById(leadId);
      if (freshLead && freshLead.aiPausedUntil && new Date(freshLead.aiPausedUntil) <= new Date()) {
        await LeadModel.findByIdAndUpdate(leadId, { aiPausedUntil: null });
        console.log(`[AI SNOOZE] 5-minute manual pause expired for lead ${leadIdStr}. AI re-enabled.`);

        const ioNow = getIO();
        if (ioNow) {
          const resumePayload = { leadId: leadIdStr, aiPausedUntil: null };
          ioNow.to(leadIdStr).emit("ai_status_updated", resumePayload);
          if (orgId) {
            ioNow.to(`org_${orgId}`).emit("ai_status_updated", resumePayload);
          } else {
            ioNow.emit("ai_status_updated", resumePayload);
          }
        }
      }
    } catch (err) {
      console.error(`[AI SNOOZE] Error resuming AI for lead ${leadIdStr}:`, err);
    }
  }, durationMs);
};

/**
 * Immediately clear an active AI pause for a lead.
 * Called when a user manually toggles AI back on from the frontend.
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
    } else {
      io.emit("ai_status_updated", resumePayload);
    }
  }
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

    // Safety check: Abort if AI was paused while this request was queued
    const freshLead = await LeadModel.findById(lead._id);
    if (freshLead) {
      const isAiPaused = freshLead.aiPausedUntil && new Date(freshLead.aiPausedUntil) > new Date();
      if (isAiPaused || !freshLead.aiEnabled) {
        console.log(`[AI SNOOZE] AI response aborted for lead ${lead._id}. AI paused or disabled.`);
        return;
      }
    }

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
    if (!sock && orgId && (!sessionId || sessionId === `org_${orgId}`)) {
      const orgSession = sessions[`org_${orgId}`];
      if (orgSession && orgSession.status === "connected") {
        sock = orgSession.sock;
      }
    }
    if (!sock && !orgId && sessionId === "device_1") {
      sock = sessions["device_1"]?.sock;
    }
    if (sock) {
      // Mark this lead as having an automated send in progress
      // so messages.upsert handler doesn't mistake the AI reply for a manual message
      const leadIdStr = lead._id.toString();
      automatedSendInProgress.add(leadIdStr);
      try {
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
            io.to(`org_${orgId}`).emit("conversation_updated", updatePayload);
          } else {
            io.emit("conversation_updated", updatePayload);
          }
        }
      } finally {
        // Clear automated send flag after message is fully saved and broadcast
        automatedSendInProgress.delete(leadIdStr);
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

  // Cross-tenant validation: If organizationId is provided, validate sessionId strictly belongs to this organization
  if (sessionId && organizationId) {
    const orgPrefix = `org_${organizationId}`;
    const belongsToOrg = sessionId === orgPrefix || sessionId.startsWith(`${orgPrefix}_`);
    if (!belongsToOrg) {
      throw new Error(`Unauthorized: WhatsApp session ${sessionId} does not belong to organization ${organizationId}`);
    }
  }

  // Find socket strictly for this specific session
  let sock = null;
  if (sessionId) {
    const sessionObj = sessions[sessionId];
    if (sessionObj && (!organizationId || sessionObj.organizationId?.toString() === organizationId.toString())) {
      sock = sessionObj.sock;
    }
  }
  // Strictly prevent arbitrary cross-tenant or cross-rep session fallback
  if (!sock) {
    // Check if session has saved credentials in DB
    const targetSessionId = sessionId || (organizationId ? `org_${organizationId}` : null);
    if (targetSessionId) {
      try {
        const resolvedModels = tenantModels || (await getModelsForSession(targetSessionId));
        const AuthModel = resolvedModels?.WhatsAppAuthState;
        const hasCreds = AuthModel
          ? await AuthModel.findOne({ sessionId: targetSessionId, type: "creds" })
          : null;

        if (hasCreds) {
          console.log(`[WhatsApp] Auto-reconnecting session ${targetSessionId} triggered by CRM manual send...`);
          connectWhatsApp({
            sessionId: targetSessionId,
            organizationId,
          }).catch((e) => console.error("[WhatsApp] Auto-reconnect on send failed:", e));

          throw new Error("WhatsApp connection was sleeping and is reconnecting now. Please retry sending in 5-10 seconds.");
        }
      } catch (checkErr) {
        if (checkErr.message.includes("reconnecting now")) throw checkErr;
      }
    }
    throw new Error("WhatsApp client is not connected for this organization! Please connect your device in WhatsApp Settings.");
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

  // Pause AI for 5 minutes when an agent sends a manual CRM message
  if (lead.aiEnabled) {
    try {
      await pauseAIForLead(lead._id, models, organizationId);
      console.log(`[AI SNOOZE] CRM manual message detected for lead ${lead._id}. AI paused for 5 minutes.`);
    } catch (pauseErr) {
      console.error(`[AI SNOOZE] Error pausing AI for lead ${lead._id}:`, pauseErr);
    }
  }
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

/**
 * Send an automated follow-up with an image and caption.
 */
export const sendAutomatedFollowup = async (lead, imageUrl, text, context = {}) => {
  let { organizationId, tenantModels, sessionId } = context;
  if (!sessionId && organizationId) {
    sessionId = `org_${organizationId}`;
  }

  let sock = sessionId ? sessions[sessionId]?.sock : null;
  if (!sock && organizationId && (!sessionId || sessionId === `org_${organizationId}`)) {
    const orgSession = sessions[`org_${organizationId}`];
    if (orgSession && orgSession.status === "connected") {
      sock = orgSession.sock;
    }
  }
  if (!sock) {
    const targetSessionId = sessionId || (organizationId ? `org_${organizationId}` : null);
    if (targetSessionId) {
      try {
        const resolvedModels = tenantModels || (await getModelsForSession(targetSessionId));
        const AuthModel = resolvedModels?.WhatsAppAuthState;
        const hasCreds = AuthModel
          ? await AuthModel.findOne({ sessionId: targetSessionId, type: "creds" })
          : null;

        if (hasCreds) {
          console.log(`[WhatsApp] Auto-reconnecting session ${targetSessionId} triggered by automated follow-up...`);
          connectWhatsApp({
            sessionId: targetSessionId,
            organizationId,
          }).catch((e) => console.error("[WhatsApp] Auto-reconnect on followup failed:", e));
        }
      } catch (checkErr) {}
    }
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

  // Mark as automated send so messages.upsert handler doesn't trigger AI pause
  const leadIdStr = lead._id.toString();
  automatedSendInProgress.add(leadIdStr);

  try {
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
        io.to(`org_${organizationId}`).emit("conversation_updated", updatePayload);
      } else {
        io.emit("conversation_updated", updatePayload);
      }
    }

    return messageRecord;
  } finally {
    // Clear automated send flag
    automatedSendInProgress.delete(leadIdStr);
  }
};

export const DEFAULT_WELCOME_MESSAGE_TEMPLATE = `Hello {{name}}! 👋\n\nThank you for reaching out to {{company}} regarding *{{service}}*.\n\nWe have received your enquiry and our specialist will connect with you shortly.\n\nFeel free to reply with any specific requirements or questions you may have!`;

/**
 * Compiles a welcome message template by substituting dynamic variables.
 * Supported variables: {{name}}, {{firstName}}, {{service}}, {{company}}, {{city}}, {{phone}}, {{email}}, {{source}}
 * Supports both {{tag}} and {tag} notations.
 */
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

  // Replace {{tag}} or {tag} case-insensitively
  return rawTemplate.replace(
    /\{\{?\s*([a-zA-Z0-9_]+)\s*\}?\}/g,
    (match, tag) => {
      const key = tag.toLowerCase();
      return replacements[key] !== undefined ? replacements[key] : match;
    },
  );
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

    // Find active connected WhatsApp socket for this organization line
    let sock = sessionId ? sessions[sessionId]?.sock : null;
    if (!sock && organizationId && (!sessionId || sessionId === `org_${organizationId}`)) {
      const orgSession = sessions[`org_${organizationId}`];
      if (orgSession && orgSession.status === "connected") {
        sock = orgSession.sock;
      }
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

    // Fetch organization info from master DB if organizationId is available
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
        console.error(
          "[WhatsApp Welcome] Error fetching organization details:",
          orgErr.message,
        );
      }
    }

    const welcomeText = formatWelcomeMessage(
      settings.welcomeMessageTemplate,
      lead,
      orgInfo,
      settings.welcomeMessageFallbackService,
    );

    // Mark as automated send so messages.upsert handler doesn't trigger AI pause
    const leadIdStr = lead._id.toString();
    automatedSendInProgress.add(leadIdStr);

    try {
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
          io.to(`org_${organizationId}`).emit("conversation_updated", updatePayload);
        } else {
          io.emit("conversation_updated", updatePayload);
        }
      }

      console.log(
        `[WhatsApp Welcome] Successfully sent welcome message to ${lead.phone} (${lead.name})`,
      );

      return messageRecord;
    } finally {
      // Clear automated send flag
      automatedSendInProgress.delete(leadIdStr);
    }
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

  // Sync to master Organization model if organizationId is present
  if (organizationId) {
    try {
      const { Organization } = getMasterModels();
      const org = await Organization.findById(organizationId);
      if (org) {
        if (!org.aiSettings) org.aiSettings = {};
        if (updates.welcomeMessageTemplate !== undefined) {
          org.aiSettings.welcomeMessageTemplate = updates.welcomeMessageTemplate;
        }
        if (updates.welcomeMessageFallbackService !== undefined) {
          org.aiSettings.welcomeMessageFallbackService = updates.welcomeMessageFallbackService;
        }
        await org.save();
      }
    } catch (syncErr) {
      console.error("[WhatsApp Settings] Error syncing settings to organization:", syncErr.message);
    }
  }

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
        const tenantDbName = org.tenantDbName;
        if (!tenantDbName) {
          console.log(`[WhatsApp] Organization "${org.name}" has no tenantDbName. Skipping auto-connect.`);
          continue;
        }

        const models = getTenantModels(tenantDbName);
        const lineLimit = org.whatsappLineLimit || 1;
        const primarySessionId = `org_${orgId}`;
        const secondarySessionId = `org_${orgId}_device_2`;
        const allowedSessions = lineLimit >= 2
          ? [primarySessionId, secondarySessionId]
          : [primarySessionId];

        // Find saved credentials for this organization (respecting line limit)
        const validCreds = await models.WhatsAppAuthState.find({
          sessionId: { $in: allowedSessions },
          type: "creds",
        });

        if (validCreds && validCreds.length > 0) {
          for (const cred of validCreds) {
            console.log(
              `[WhatsApp] Found existing credentials for organization "${org.name}" (${cred.sessionId}). Auto-connecting...`
            );
            connectWhatsApp({
              sessionId: cred.sessionId,
              organizationId: orgId,
              tenantDbName,
            }).catch((err) =>
              console.error(`[WhatsApp] Failed to auto-connect ${cred.sessionId} for org ${org.name}:`, err)
            );
          }
        } else {
          console.log(`[WhatsApp] No saved session credentials for organization "${org.name}". Ready for linking.`);
        }

        // ================================================================
        // MULTI-USER: Also reconnect all saved sales rep personal sessions
        // Regex matches: org_<orgId>_user_<24-char-hex-userId>
        // ================================================================
        try {
          const userSessionCreds = await models.WhatsAppAuthState.find({
            sessionId: { $regex: `^org_${orgId}_user_[a-fA-F0-9]{24}$` },
            type: "creds",
          });
          if (userSessionCreds && userSessionCreds.length > 0) {
            console.log(
              `[WhatsApp] Found ${userSessionCreds.length} rep session credential(s) for org "${org.name}". Auto-connecting...`
            );
            for (const cred of userSessionCreds) {
              connectWhatsApp({
                sessionId: cred.sessionId,
                organizationId: orgId,
                tenantDbName,
              }).catch((err) =>
                console.error(`[WhatsApp] Failed to auto-connect rep session ${cred.sessionId}:`, err)
              );
            }
          }
        } catch (repSessionErr) {
          console.error(`[WhatsApp] Error checking rep sessions for org ${org.name}:`, repSessionErr);
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
        connectWhatsApp("device_1").catch((err) =>
          console.error("[WhatsApp] Failed to auto-connect legacy device_1:", err)
        );
      }
    } catch (legacyErr) {
      console.error("[WhatsApp] Error checking legacy session:", legacyErr);
    }
  } catch (err) {
    console.error("[WhatsApp] Failed to initialize organization WhatsApp connections:", err);
  }
};

/**
 * Background Watchdog: runs every 60 seconds to auto-heal disconnected WhatsApp sessions
 * that have valid saved credentials in their tenant database.
 */
export const startWhatsAppWatchdog = () => {
  console.log(`[WhatsApp Watchdog] Starting WhatsApp connection watchdog service (${WATCHDOG_INTERVAL_MS / 1000}s interval)...`);
  
  setInterval(async () => {
    try {
      const { Organization } = getMasterModels();
      const organizations = await Organization.find({ status: { $ne: "suspended" } });

      for (const org of organizations) {
        try {
          const orgId = org._id.toString();
          const tenantDbName = org.tenantDbName;
          if (!tenantDbName) continue;

          const lineLimit = org.whatsappLineLimit || 1;
          const primarySessionId = `org_${orgId}`;
          const secondarySessionId = `org_${orgId}_device_2`;
          const allowedSessions = lineLimit >= 2
            ? [primarySessionId, secondarySessionId]
            : [primarySessionId];

          const models = getTenantModels(tenantDbName);
          const validCreds = await models.WhatsAppAuthState.find({
            sessionId: { $in: allowedSessions },
            type: "creds",
          });

          if (validCreds && validCreds.length > 0) {
            for (const cred of validCreds) {
              const sId = cred.sessionId;
              const current = sessions[sId];
              const isLive = current?.sock && current?.status === "connected";
              const isConnecting = current?.status === "connecting";
              const hasPendingReconnect = reconnectTimers.has(sId);

              // Only auto-reconnect if socket is not live, not actively connecting,
              // and does not already have a pending reconnect timer scheduled by the close handler
              if (!isLive && !isConnecting && !hasPendingReconnect) {
                console.log(
                  `[WhatsApp Watchdog] Session ${sId} ("${org.name}") has saved credentials but is currently ${current?.status || "unloaded"}. Auto-reconnecting...`
                );
                connectWhatsApp({
                  sessionId: sId,
                  organizationId: orgId,
                  tenantDbName,
                }).catch((err) =>
                  console.error(`[WhatsApp Watchdog] Reconnect failed for ${sId}:`, err)
                );
              }
            }
          }

          // ================================================================
          // MULTI-USER WATCHDOG: Also heal disconnected rep personal sessions
          // ================================================================
          try {
            const userSessionCreds = await models.WhatsAppAuthState.find({
              sessionId: { $regex: `^org_${orgId}_user_[a-fA-F0-9]{24}$` },
              type: "creds",
            });
            for (const cred of userSessionCreds) {
              const sId = cred.sessionId;
              const current = sessions[sId];
              const isLive = current?.sock && current?.status === "connected";
              const isConnecting = current?.status === "connecting";
              const hasPendingReconnect = reconnectTimers.has(sId);
              if (!isLive && !isConnecting && !hasPendingReconnect) {
                console.log(
                  `[WhatsApp Watchdog] Rep session ${sId} ("${org.name}") is ${current?.status || "unloaded"}. Auto-reconnecting...`
                );
                connectWhatsApp({
                  sessionId: sId,
                  organizationId: orgId,
                  tenantDbName,
                }).catch((err) =>
                  console.error(`[WhatsApp Watchdog] Rep session reconnect failed for ${sId}:`, err)
                );
              }
            }
          } catch (repWatchErr) {
            // Silent catch — do not interrupt main watchdog loop
          }

        } catch (orgErr) {
          // Silent catch per organization to not interrupt the loop
        }
      }
    } catch (err) {
      console.error("[WhatsApp Watchdog] Error in watchdog cycle:", err);
    }
  }, WATCHDOG_INTERVAL_MS);
};




