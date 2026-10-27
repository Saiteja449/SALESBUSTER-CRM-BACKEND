import crypto from "crypto";
import { getMasterModels, getTenantModels } from "../services/tenantManager.js";
import { decryptApiKey } from "../utils/encryption.js";
import { sendTextMessage } from "../services/whatsappCloudService.js";
import { generateAIResponse } from "../ai/aiService.js";
import { getIO } from "../socket/socket.js";

/**
 * Validates Meta X-Hub-Signature-256 HMAC-SHA256 signature using raw request buffer.
 */
export const verifyMetaSignature = (req) => {
  const appSecret = process.env.META_APP_SECRET;

  if (!appSecret) {
    // In production or development, if META_APP_SECRET is not configured, allow payload
    // to prevent rejecting customer replies and delivery receipts.
    return true;
  }

  const signature = req.headers["x-hub-signature-256"];
  if (!signature) {
    console.warn("[WebhookSecurity] Missing X-Hub-Signature-256 header.");
    return false;
  }

  const rawBody = req.rawBody || JSON.stringify(req.body);
  const expectedSignature = `sha256=${crypto
    .createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex")}`;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch (err) {
    return false;
  }
};

/**
 * Handles Meta Webhook Verification Challenge (GET).
 * Supports both unified app-level webhook and optional per-org webhook (/webhook/:orgId).
 */
export const verifyWhatsAppWebhook = async (req, res) => {
  try {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    const { orgId } = req.params;

    if (!mode || !token) {
      return res.status(400).send("Missing hub.mode or hub.verify_token parameters.");
    }

    if (mode !== "subscribe") {
      return res.status(403).send("Invalid hub.mode.");
    }

    const defaultGlobalToken = "salesbuster_whatsapp_cloud_verify_token_2026";
    const altGlobalToken = "salesbuster_meta_verify_token_2026";
    const envVerifyToken =
      process.env.META_WEBHOOK_VERIFY_TOKEN ||
      process.env.WHATSAPP_CLOUD_VERIFY_TOKEN ||
      process.env.META_VERIFY_TOKEN;

    // Fast path: if token matches standard global token or the orgId itself, verify immediately
    const quickValidTokens = [
      defaultGlobalToken,
      altGlobalToken,
      envVerifyToken,
      orgId, // Allows using orgId directly as verify token
    ].filter(Boolean);

    if (quickValidTokens.includes(token)) {
      console.log(`[WebhookVerification] Verified immediately (org: ${orgId || "global"}) with token: ${token}`);
      return res.status(200).send(challenge);
    }

    // Slow path: if orgId is passed and custom token configured in DB
    if (orgId) {
      try {
        const { Organization } = getMasterModels();
        const org = await Organization.findById(orgId).maxTimeMS(2000);
        if (
          org?.whatsappCloudSettings?.webhookVerifyToken &&
          token === org.whatsappCloudSettings.webhookVerifyToken
        ) {
          console.log(`[WebhookVerification] Verified via custom DB token for org: ${orgId}`);
          return res.status(200).send(challenge);
        }
      } catch (err) {
        console.warn(`[WebhookVerification] Org DB lookup error for ${orgId}:`, err.message);
      }
      console.warn(`[WebhookVerification] Token mismatch for org ${orgId}. Received: ${token}`);
      return res.status(403).send("Verification token mismatch.");
    }

    console.warn("[WebhookVerification] Global token mismatch.");
    return res.status(403).send("Verification token mismatch.");
  } catch (error) {
    console.error("[WebhookVerification] Error during verification:", error);
    return res.status(500).send("Internal verification error.");
  }
};

/**
 * Status ranking hierarchy to ensure monotonic status transitions.
 * Lower-ranked statuses cannot overwrite higher-ranked statuses.
 */
const STATUS_RANK = {
  Pending: 0,
  Queued: 1,
  Sending: 2,
  Sent: 3,
  Delivered: 4,
  Read: 5,
};

/**
 * Handles incoming Meta WhatsApp Cloud API events (POST).
 * Routes multi-field coexistence payloads: messages, smb_message_echoes, smb_app_state_sync, history, account_update.
 */
export const receiveWhatsAppWebhook = async (req, res) => {
  // 1. Cryptographic signature check FIRST before responding
  if (!verifyMetaSignature(req)) {
    console.error("[WebhookSecurity] Webhook payload rejected: Invalid HMAC-SHA256 signature.");
    return res.status(401).send("Invalid webhook signature.");
  }

  // 2. Acknowledge Meta immediately with HTTP 200 within 3 seconds
  res.status(200).send("EVENT_RECEIVED");

  try {
    const body = req.body;
    if (body.object !== "whatsapp_business_account" && !body.entry) {
      return;
    }

    const { Organization, WAAccount, WAWebhookEvent } = getMasterModels();

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const field = change.field;
        const value = change.value;
        if (!value) continue;

        // Durable Event Logging & Deduplication
        const eventId = `${entry.id || "entry"}_${field}_${
          value.metadata?.phone_number_id ||
          value.messages?.[0]?.id ||
          Date.now()
        }`;

        try {
          if (WAWebhookEvent) {
            const existingEvent = await WAWebhookEvent.findOne({ eventId });
            if (existingEvent && existingEvent.status === "processed") {
              console.log(`[WhatsAppWebhook] Skipping duplicate eventId: ${eventId}`);
              continue;
            }
            await WAWebhookEvent.findOneAndUpdate(
              { eventId },
              { $set: { eventId, field, payload: value, status: "pending" } },
              { upsert: true }
            );
          }
        } catch (eventErr) {
          console.warn("[WhatsAppWebhook] Audit log warning:", eventErr.message);
        }

        const phoneNumberId =
          value.metadata?.phone_number_id ||
          value.phone_number_id ||
          value.metadata?.display_phone_number;

        // 3. Resolve Organization & WAAccount
        let waAccount = null;
        let org = null;

        if (phoneNumberId) {
          waAccount = await WAAccount.findOne({ phoneNumberId });
          if (waAccount) {
            org = await Organization.findById(waAccount.organizationId);
          }
        }

        if (!org && phoneNumberId) {
          org = await Organization.findOne({
            "whatsappCloudSettings.phoneNumberId": phoneNumberId,
          });
        }

        if (!org && req.params.orgId) {
          org = await Organization.findById(req.params.orgId);
        }

        if (!org || !org.tenantDbName) {
          console.warn(
            `[WhatsAppWebhook] No active organization found for phone_number_id: ${phoneNumberId} (field: ${field})`
          );
          continue;
        }

        const tenantModels = getTenantModels(org.tenantDbName);

        // -----------------------------------------------------------------
        // 4. MULTI-FIELD DISPATCH
        // -----------------------------------------------------------------

        // (A) FIELD: "messages"
        if (field === "messages") {
          // Status updates (sent / delivered / read / failed)
          if (Array.isArray(value.statuses) && value.statuses.length > 0) {
            await processStatusUpdates(value.statuses, tenantModels, org);
          }

          // Inbound customer messages
          if (Array.isArray(value.messages) && value.messages.length > 0) {
            await processInboundMessages(
              value.messages,
              value.contacts,
              tenantModels,
              org,
              waAccount
            );
          }
        }

        // (B) FIELD: "smb_message_echoes" (Outbound echoes from mobile WhatsApp Business app)
        else if (field === "smb_message_echoes") {
          const echoes = value.messages || value.message_echoes || [];
          if (Array.isArray(echoes) && echoes.length > 0) {
            await processMobileAppEchoes(echoes, tenantModels, org, waAccount);
          }
        }

        // (C) FIELD: "smb_app_state_sync" (Address book contacts sync from mobile phone)
        else if (field === "smb_app_state_sync") {
          const contactsData = value.contacts || value.app_state_sync || [];
          if (Array.isArray(contactsData) && contactsData.length > 0) {
            await processAppStateContacts(contactsData, tenantModels, org, waAccount);
          }
        }

        // (D) FIELD: "history" (Historic chat import chunks)
        else if (field === "history") {
          await processChatHistoryChunk(value, tenantModels, org, waAccount);
        }

        // (E) FIELD: "account_update" (Lifecycle events: PARTNER_REMOVED, PRIMARY_INACTIVITY)
        else if (field === "account_update") {
          await processAccountUpdate(value, org, waAccount);
        }

        // Mark event as processed in audit trail
        try {
          if (WAWebhookEvent) {
            await WAWebhookEvent.updateOne(
              { eventId },
              { $set: { status: "processed", processedAt: new Date() } }
            );
          }
        } catch (logErr) {}
      }
    }
  } catch (error) {
    console.error("[WhatsAppWebhook] Uncaught error in receiveWhatsAppWebhook:", error);
  }
};

/**
 * Idempotently updates recipient records based on Meta delivery receipts with status ranking.
 */
const processStatusUpdates = async (statuses, tenantModels, org) => {
  const { WhatsAppCampaignRecipient, Message } = tenantModels;
  const io = getIO();

  for (const statusObj of statuses) {
    const metaMessageId = statusObj.id;
    const statusStr = (statusObj.status || "").toLowerCase(); // "sent", "delivered", "read", "failed"
    const timestamp = statusObj.timestamp
      ? new Date(parseInt(statusObj.timestamp) * 1000)
      : new Date();

    if (!metaMessageId) continue;

    // Update Message status in chat if found
    if (Message) {
      await Message.updateOne(
        { $or: [{ messageId: metaMessageId }, { wamid: metaMessageId }] },
        {
          $set: {
            status: statusStr,
            delivered: statusStr === "delivered" || statusStr === "read",
            read: statusStr === "read",
          },
        }
      ).catch(() => {});
    }

    if (!WhatsAppCampaignRecipient) continue;

    const recipient = await WhatsAppCampaignRecipient.findOne({ metaMessageId });
    if (!recipient) {
      continue;
    }

    if (recipient.status === "Skipped") continue;

    const currentRank = STATUS_RANK[recipient.status] || 0;
    let updateFields = {};
    let campaignInc = {};

    if (statusStr === "delivered") {
      if (currentRank < STATUS_RANK.Delivered) {
        updateFields = {
          status: "Delivered",
          deliveredAt: timestamp,
        };
        campaignInc.deliveredCount = 1;
      }
    } else if (statusStr === "read") {
      if (currentRank < STATUS_RANK.Read) {
        updateFields = {
          status: "Read",
          readAt: timestamp,
        };
        campaignInc.readCount = 1;

        if (currentRank < STATUS_RANK.Delivered) {
          updateFields.deliveredAt = recipient.deliveredAt || timestamp;
          campaignInc.deliveredCount = 1;
        }
      }
    } else if (statusStr === "failed") {
      if (currentRank >= STATUS_RANK.Delivered) {
        console.warn(
          `[WhatsAppWebhook] Ignored late failed webhook for recipient ${recipient._id} already at '${recipient.status}'`
        );
        continue;
      }

      if (recipient.status !== "Failed") {
        const errDetail = statusObj.errors?.[0] || {};
        updateFields = {
          status: "Failed",
          failedAt: timestamp,
          errorCode: String(errDetail.code || "UNKNOWN"),
          errorMessage: errDetail.title || errDetail.message || "Meta delivery failure",
        };
        campaignInc.failedCount = 1;
      }
    }

    if (Object.keys(updateFields).length > 0) {
      await WhatsAppCampaignRecipient.updateOne(
        { _id: recipient._id },
        { $set: updateFields }
      );
    }
  }
};

/**
 * Normalizes an international phone number string to digits only.
 */
const normalizePhoneDigits = (rawPhone) => {
  if (!rawPhone) return "";
  let digits = String(rawPhone).replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length === 12) {
    digits = digits.slice(2);
  } else if (digits.startsWith("0") && digits.length === 11) {
    digits = digits.slice(1);
  }
  return digits;
};

/**
 * Processes incoming customer messages, deduplicates via wamid, updates 24h window, and triggers AI reply.
 */
const processInboundMessages = async (
  messages,
  contacts,
  tenantModels,
  org,
  waAccount
) => {
  const { Lead, Message, Conversation, WhatsAppOptOut } = tenantModels;
  const io = getIO();

  for (const msg of messages) {
    const rawSender = msg.from;
    const cleanPhone = normalizePhoneDigits(rawSender);
    if (!cleanPhone) continue;

    // Strict deduplication by wamid / messageId
    const wamid = msg.id;
    if (wamid) {
      const existing = await Message.findOne({
        $or: [{ wamid }, { messageId: wamid }],
      });
      if (existing) {
        // If message is an edit
        if (msg.type === "edited" || msg.edited_text) {
          const newText = msg.edited_text || msg.text?.body || "";
          existing.text = newText;
          await existing.save();
          if (io) {
            io.to(existing.leadId.toString()).emit("message_edited", existing);
          }
        }
        continue;
      }
    }

    const contactObj = contacts?.find((c) => c.wa_id === rawSender);
    const senderName = contactObj?.profile?.name || rawSender;

    let messageType = "text";
    let messageText = "";
    let mediaUrl = "";

    if (msg.type === "text") {
      messageText = msg.text?.body || "";
    } else if (msg.type === "image") {
      messageType = "image";
      messageText = msg.image?.caption || "[Image]";
      mediaUrl = msg.image?.id || "";
    } else if (msg.type === "audio") {
      messageType = "audio";
      messageText = "[Audio Note]";
      mediaUrl = msg.audio?.id || "";
    } else if (msg.type === "document") {
      messageType = "document";
      messageText = msg.document?.caption || msg.document?.filename || "[Document]";
      mediaUrl = msg.document?.id || "";
    } else if (msg.type === "location") {
      messageType = "location";
      messageText = `[Location: ${msg.location?.latitude}, ${msg.location?.longitude}]`;
    } else {
      messageText = `[${msg.type || "Media"}]`;
    }

    // 1. Find or create Lead in tenant database
    let lead = await Lead.findOne({
      $or: [
        { phone: cleanPhone },
        { phone: `+91${cleanPhone}` },
        { phone: `91${cleanPhone}` },
        { phone: rawSender },
      ],
    });

    if (!lead) {
      // If line is assigned to a specific sales rep, assign new lead to that rep
      const assignedTo = waAccount?.userId ? waAccount.userId : "Unassigned";

      lead = await Lead.create({
        name: senderName,
        phone: cleanPhone,
        source: "WhatsApp",
        service: "General Enquiry",
        status: "New",
        assignedTo,
        joinedAt: new Date(),
        lastActivity: new Date(),
      });
      console.log(`[WhatsAppWebhook] Created new lead for inbound Cloud API sender: ${cleanPhone}`);
    }

    // 2. Extend 24-hour Meta Customer Service Window
    const now = new Date();
    lead.lastCloudInboundAt = now;
    lead.serviceWindowExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    lead.lastActivity = now;

    // 3. Handle Opt-Out Keywords (STOP, UNSUBSCRIBE, OPT OUT)
    const normalizedText = messageText.trim().toLowerCase();
    if (/^(stop|unsubscribe|opt\s*out|cancel)$/i.test(normalizedText)) {
      lead.isOptedOut = true;
      lead.optedOutAt = now;
      await lead.save();

      if (WhatsAppOptOut) {
        await WhatsAppOptOut.findOneAndUpdate(
          { phone: cleanPhone },
          {
            phone: cleanPhone,
            reason: `Customer texted: "${messageText}"`,
            sourceMessage: messageText,
            optedOutAt: now,
          },
          { upsert: true }
        );
      }

      console.log(`[WhatsAppWebhook] Recorded marketing opt-out for ${cleanPhone}`);

      if (io) {
        io.to(`org_${org._id}`).emit("lead_opted_out", {
          leadId: lead._id,
          phone: cleanPhone,
        });
      }
      continue;
    }

    await lead.save();

    // 4. Save incoming message in tenant Message collection
    const incomingRecord = await Message.create({
      messageId: wamid || `in_cloud_${Date.now()}`,
      wamid: wamid || null,
      leadId: lead._id,
      sender: cleanPhone,
      senderName,
      direction: "incoming",
      messageType,
      text: messageText,
      mediaUrl,
      timestamp: msg.timestamp ? new Date(parseInt(msg.timestamp) * 1000) : now,
      source: "cloud_api",
      status: "delivered",
      rawPayload: msg,
    });

    // Update Conversation
    await Conversation.findOneAndUpdate(
      { leadId: lead._id },
      {
        lastMessage: messageText,
        lastMessageTime: now,
        $inc: { unreadCount: 1 },
      },
      { upsert: true }
    );

    // Emit live Socket.IO update
    if (io) {
      io.to(lead._id.toString()).emit("new_message", incomingRecord);
      io.to(`org_${org._id}`).emit("conversation_updated", {
        leadId: lead._id,
        lastMessage: messageText,
        lastMessageTime: now,
      });
      if (lead.assignedTo && lead.assignedTo !== "Unassigned") {
        io.to(`user_${lead.assignedTo}`).emit("new_message", incomingRecord);
      }
    }

    // 5. Inbound AI Auto-Reply Check
    const isAiPaused =
      lead.aiPausedUntil && new Date(lead.aiPausedUntil).getTime() > now.getTime();
    const canAiReply =
      lead.aiEnabled &&
      !lead.disableAI &&
      !isAiPaused &&
      org.aiSettings?.isAiConfigured &&
      org.aiSettings?.geminiApiKey;

    if (!canAiReply) {
      continue;
    }

    // Trigger AI auto-reply
    (async () => {
      try {
        console.log(`[WhatsAppWebhook] Generating AI response for lead ${cleanPhone}...`);
        const aiResponseResult = await generateAIResponse(
          lead._id,
          messageText,
          tenantModels,
          org
        );
        const aiResponseText =
          typeof aiResponseResult === "object" && aiResponseResult !== null
            ? aiResponseResult.reply
            : aiResponseResult;

        if (!aiResponseText || !aiResponseText.trim()) return;

        // Verify that 24-hour service window has not expired
        if (new Date() > new Date(lead.serviceWindowExpiresAt)) {
          console.warn(
            `[WhatsAppWebhook] 24-hour window expired for ${cleanPhone}. Cannot send free-form AI text.`
          );
          return;
        }

        const accessToken = waAccount?.accessTokenEncrypted
          ? decryptApiKey(waAccount.accessTokenEncrypted)
          : decryptApiKey(org.whatsappCloudSettings?.accessTokenEncrypted);
        const targetPhoneId =
          waAccount?.phoneNumberId || org.whatsappCloudSettings?.phoneNumberId;

        if (!accessToken || !targetPhoneId) {
          console.error(`[WhatsAppWebhook] Missing access token or phone ID for AI reply.`);
          return;
        }

        const sendResult = await sendTextMessage({
          phoneNumberId: targetPhoneId,
          accessToken,
          toPhone: cleanPhone,
          textBody: aiResponseText,
        });

        const replyTime = new Date();

        const outgoingRecord = await Message.create({
          messageId: sendResult.metaMessageId || `out_ai_${Date.now()}`,
          wamid: sendResult.metaMessageId || null,
          leadId: lead._id,
          sender: "AI Agent",
          senderName: org.aiSettings?.agentPersona || "AI Sales Representative",
          direction: "outgoing",
          messageType: "text",
          text: aiResponseText,
          timestamp: replyTime,
          aiGenerated: true,
          source: "ai_agent",
          status: "sent",
        });

        await Conversation.findOneAndUpdate(
          { leadId: lead._id },
          {
            lastMessage: aiResponseText,
            lastMessageTime: replyTime,
            unreadCount: 0,
          },
          { upsert: true }
        );

        if (io) {
          io.to(lead._id.toString()).emit("new_message", outgoingRecord);
          io.to(`org_${org._id}`).emit("conversation_updated", {
            leadId: lead._id,
            lastMessage: aiResponseText,
            lastMessageTime: replyTime,
          });
        }
      } catch (aiErr) {
        console.error(`[WhatsAppWebhook] Error generating/sending AI reply:`, aiErr);
      }
    })();
  }
};

/**
 * Handles smb_message_echoes: messages sent by sales rep from their physical WhatsApp Business phone app.
 * Persists with source: "business_app", triggers 60-minute AI pause, and emits live updates.
 */
const processMobileAppEchoes = async (echoes, tenantModels, org, waAccount) => {
  const { Lead, Message, Conversation } = tenantModels;
  const io = getIO();
  const now = new Date();

  for (const echo of echoes) {
    const rawRecipient = echo.to || echo.recipient_id;
    const cleanPhone = normalizePhoneDigits(rawRecipient);
    if (!cleanPhone) continue;

    const wamid = echo.id;
    if (wamid) {
      const existing = await Message.findOne({
        $or: [{ wamid }, { messageId: wamid }],
      });
      if (existing) continue; // Deduplication
    }

    let echoText = "";
    let messageType = "text";
    if (echo.type === "text") {
      echoText = echo.text?.body || "";
    } else if (echo.type === "image") {
      messageType = "image";
      echoText = echo.image?.caption || "[Image sent from phone]";
    } else if (echo.type === "audio") {
      messageType = "audio";
      echoText = "[Audio sent from phone]";
    } else {
      echoText = `[${echo.type || "Message"} sent from phone]`;
    }

    // Resolve or create lead
    let lead = await Lead.findOne({
      $or: [
        { phone: cleanPhone },
        { phone: `+91${cleanPhone}` },
        { phone: `91${cleanPhone}` },
        { phone: rawRecipient },
      ],
    });

    if (!lead) {
      const assignedTo = waAccount?.userId ? waAccount.userId : "Unassigned";
      lead = await Lead.create({
        name: cleanPhone,
        phone: cleanPhone,
        source: "WhatsApp",
        service: "General Enquiry",
        status: "Contacted",
        assignedTo,
        joinedAt: now,
        lastActivity: now,
      });
    }

    // CRITICAL: SMART COEXISTENCE AI PAUSE
    // When a human sales rep replies directly from their phone, pause AI for 60 minutes!
    const pauseUntil = new Date(now.getTime() + 60 * 60 * 1000);
    lead.aiPausedUntil = pauseUntil;
    lead.lastActivity = now;
    await lead.save();

    console.log(
      `[WhatsAppCoexistence] Captured mobile echo for ${cleanPhone}. AI paused for 60m until ${pauseUntil.toISOString()}`
    );

    // Insert Outbound message record with source: "business_app"
    const timestamp = echo.timestamp ? new Date(parseInt(echo.timestamp) * 1000) : now;
    const echoRecord = await Message.create({
      messageId: wamid || `echo_${Date.now()}`,
      wamid: wamid || null,
      leadId: lead._id,
      sender: "Sales Representative (Phone App)",
      senderName: waAccount?.displayPhone || "WhatsApp Business App",
      direction: "outgoing",
      messageType,
      text: echoText,
      timestamp,
      source: "business_app",
      status: "sent",
      salesRepId: waAccount?.userId || null,
      rawPayload: echo,
    });

    // Update Conversation
    await Conversation.findOneAndUpdate(
      { leadId: lead._id },
      {
        lastMessage: echoText,
        lastMessageTime: timestamp,
      },
      { upsert: true }
    );

    if (io) {
      io.to(lead._id.toString()).emit("new_message", echoRecord);
      io.to(`org_${org._id}`).emit("conversation_updated", {
        leadId: lead._id,
        lastMessage: echoText,
        lastMessageTime: timestamp,
      });
      if (waAccount?.userId) {
        io.to(`user_${waAccount.userId}`).emit("new_message", echoRecord);
      }
    }
  }
};

/**
 * Handles smb_app_state_sync: Address book contacts mirrored from mobile phone app.
 */
const processAppStateContacts = async (contacts, tenantModels, org, waAccount) => {
  const { WAContact, Lead } = tenantModels;
  if (!WAContact) return;

  for (const c of contacts) {
    const waId = normalizePhoneDigits(c.wa_id || c.phone);
    if (!waId) continue;

    const name = c.name || c.display_name || "";
    const action = c.action === "delete" ? "delete" : "upsert";

    if (action === "delete") {
      await WAContact.deleteOne({
        accountId: waAccount?._id,
        waId,
      });
      continue;
    }

    // Upsert into WAContact
    let lead = null;
    if (Lead) {
      lead = await Lead.findOne({
        $or: [{ phone: waId }, { phone: `+91${waId}` }, { phone: `91${waId}` }],
      });
    }

    await WAContact.findOneAndUpdate(
      { accountId: waAccount?._id, waId },
      {
        $set: {
          organizationId: org._id,
          accountId: waAccount?._id,
          waId,
          name,
          leadId: lead?._id || null,
          syncAction: "upsert",
          lastSyncedAt: new Date(),
        },
      },
      { upsert: true }
    );
  }
};

/**
 * Handles history: Backfill chunks of previous chats exported from mobile phone.
 */
const processChatHistoryChunk = async (value, tenantModels, org, waAccount) => {
  const { Message, Conversation, Lead } = tenantModels;
  const historyData = value.history || value;

  // Handle User Declined Error (code 2593109 or decline flag)
  if (
    historyData.error?.code === 2593109 ||
    historyData.status === "declined" ||
    historyData.sharing_declined === true
  ) {
    console.log(`[WhatsAppCoexistence] Client declined history sharing for account ${waAccount?._id}`);
    if (waAccount) {
      waAccount.historySharingDeclined = true;
      waAccount.status = "connected";
      await waAccount.save();
    }
    return;
  }

  const messagesList = historyData.messages || [];
  let importedCount = 0;

  for (const item of messagesList) {
    const wamid = item.id;
    if (!wamid) continue;

    const existing = await Message.findOne({
      $or: [{ wamid }, { messageId: wamid }],
    });
    if (existing) continue;

    const cleanPhone = normalizePhoneDigits(item.from || item.to);
    if (!cleanPhone) continue;

    let lead = await Lead.findOne({
      $or: [{ phone: cleanPhone }, { phone: `+91${cleanPhone}` }],
    });

    if (!lead) {
      lead = await Lead.create({
        name: cleanPhone,
        phone: cleanPhone,
        source: "WhatsApp History",
        status: "Existing Client",
        assignedTo: waAccount?.userId || "Unassigned",
        joinedAt: new Date(),
      });
    }

    const direction = item.from === waAccount?.displayPhone ? "outgoing" : "incoming";
    const timestamp = item.timestamp
      ? new Date(parseInt(item.timestamp) * 1000)
      : new Date();

    await Message.create({
      messageId: wamid,
      wamid,
      leadId: lead._id,
      sender: direction === "outgoing" ? "Me" : cleanPhone,
      direction,
      messageType: item.type || "text",
      text: item.text?.body || `[${item.type || "History Message"}]`,
      timestamp,
      source: "history", // Does NOT open 24h window
      status: "delivered",
      rawPayload: item,
    });

    importedCount++;
  }

  if (waAccount) {
    waAccount.historyProgress = waAccount.historyProgress || {};
    waAccount.historyProgress.chunksReceived =
      (waAccount.historyProgress.chunksReceived || 0) + 1;
    waAccount.historyProgress.messagesImported =
      (waAccount.historyProgress.messagesImported || 0) + importedCount;
    waAccount.historyProgress.lastChunkReceivedAt = new Date();

    if (historyData.is_last_chunk || historyData.is_complete) {
      waAccount.historyProgress.isComplete = true;
      waAccount.status = "connected";
    }
    await waAccount.save();
  }
};

/**
 * Handles account_update: Account lifecycle events (PARTNER_REMOVED, PRIMARY_INACTIVITY).
 */
const processAccountUpdate = async (value, org, waAccount) => {
  const reason = value.reason || value.event || "UNKNOWN";
  console.warn(
    `[WhatsAppCoexistence] Received account_update for org ${org._id} (reason: ${reason})`
  );

  if (waAccount) {
    waAccount.status = "disconnected";
    waAccount.disconnectReason = reason;
    await waAccount.save();
  }

  const io = getIO();
  if (io) {
    io.to(`org_${org._id}`).emit("whatsapp_account_disconnected", {
      reason,
      phoneNumberId: waAccount?.phoneNumberId,
    });
  }
};
