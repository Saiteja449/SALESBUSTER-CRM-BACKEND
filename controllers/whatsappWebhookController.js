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
    const envVerifyToken = process.env.WHATSAPP_CLOUD_VERIFY_TOKEN;
    const envMetaToken = process.env.META_VERIFY_TOKEN;

    // Fast path: if token matches standard global token or the orgId itself, verify immediately
    const quickValidTokens = [
      defaultGlobalToken,
      altGlobalToken,
      envVerifyToken,
      envMetaToken,
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
        if (org?.whatsappCloudSettings?.webhookVerifyToken && token === org.whatsappCloudSettings.webhookVerifyToken) {
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

    const { Organization } = getMasterModels();

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;

        const value = change.value;
        if (!value) continue;

        const phoneNumberId = value.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        // 3. Resolve Organization from Master Database by phone_number_id
        let org = await Organization.findOne({
          "whatsappCloudSettings.phoneNumberId": phoneNumberId,
        });

        // Fallback: If route provided :orgId parameter
        if (!org && req.params.orgId) {
          org = await Organization.findById(req.params.orgId);
          if (org && !org.whatsappCloudSettings?.phoneNumberId) {
            org.whatsappCloudSettings = org.whatsappCloudSettings || {};
            org.whatsappCloudSettings.phoneNumberId = phoneNumberId;
            await org.save().catch((err) => console.warn("[WhatsAppWebhook] Auto-save phoneNumberId failed:", err.message));
          }
        }

        if (!org || !org.tenantDbName) {
          console.warn(
            `[WhatsAppWebhook] No active organization found for phone_number_id: ${phoneNumberId} (orgId: ${req.params.orgId || "none"})`
          );
          continue;
        }

        const tenantModels = getTenantModels(org.tenantDbName);

        // 4. Process Status Updates (sent / delivered / read / failed)
        if (Array.isArray(value.statuses) && value.statuses.length > 0) {
          await processStatusUpdates(value.statuses, tenantModels, org);
        }

        // 5. Process Inbound Customer Messages & Trigger AI Auto-Reply
        if (Array.isArray(value.messages) && value.messages.length > 0) {
          await processInboundMessages(value.messages, value.contacts, tenantModels, org);
        }
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
  const { WhatsAppCampaignRecipient, WhatsAppCampaign } = tenantModels;
  const io = getIO();

  for (const statusObj of statuses) {
    const metaMessageId = statusObj.id;
    const statusStr = (statusObj.status || "").toLowerCase(); // "sent", "delivered", "read", "failed"
    const timestamp = statusObj.timestamp
      ? new Date(parseInt(statusObj.timestamp) * 1000)
      : new Date();

    if (!metaMessageId) continue;

    const recipient = await WhatsAppCampaignRecipient.findOne({ metaMessageId });
    if (!recipient) {
      continue;
    }

    // Never alter skipped recipients
    if (recipient.status === "Skipped") continue;

    const currentRank = STATUS_RANK[recipient.status] || 0;
    let updateFields = {};
    let campaignInc = {};

    if (statusStr === "delivered") {
      // Do not downgrade if already Read
      if (currentRank < STATUS_RANK.Delivered) {
        updateFields = {
          status: "Delivered",
          deliveredAt: timestamp,
        };
        campaignInc.deliveredCount = 1;
      }
    } else if (statusStr === "read") {
      // Upgrade to Read
      if (currentRank < STATUS_RANK.Read) {
        updateFields = {
          status: "Read",
          readAt: timestamp,
        };
        campaignInc.readCount = 1;

        // If skipped intermediate "delivered" webhook, also count as delivered
        if (currentRank < STATUS_RANK.Delivered) {
          updateFields.deliveredAt = recipient.deliveredAt || timestamp;
          campaignInc.deliveredCount = 1;
        }
      }
    } else if (statusStr === "failed") {
      // NEVER downgrade a recipient that has already reached Delivered or Read
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
          errorCode: String(errDetail.code || "FAILED"),
          errorMessage: errDetail.title || errDetail.message || "Delivery failed",
        };
        campaignInc.failedCount = 1;
      }
    }

    if (Object.keys(updateFields).length > 0) {
      await WhatsAppCampaignRecipient.findByIdAndUpdate(recipient._id, updateFields);

      if (Object.keys(campaignInc).length > 0) {
        await WhatsAppCampaign.findByIdAndUpdate(recipient.campaignId, {
          $inc: campaignInc,
        });
      }

      if (io) {
        io.to(`org_${org._id}`).emit("recipient_status_updated", {
          campaignId: recipient.campaignId,
          recipientId: recipient._id,
          status: updateFields.status,
          timestamp,
        });
      }
    }
  }
};

/**
 * Handles inbound customer messages, opt-outs, and triggers AI responses within the 24h window.
 */
const processInboundMessages = async (messages, contacts, tenantModels, org) => {
  const { Lead, Message, Conversation, WhatsAppOptOut } = tenantModels;
  const io = getIO();
  const contactMap = {};

  if (Array.isArray(contacts)) {
    for (const c of contacts) {
      if (c.wa_id) contactMap[c.wa_id] = c.profile?.name || "";
    }
  }

  for (const msg of messages) {
    const rawPhone = msg.from; // E.g. "919876543210"
    if (!rawPhone) continue;

    const cleanPhone = rawPhone.replace(/\D/g, "");
    const last10 = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;
    const senderName = contactMap[rawPhone] || "WhatsApp User";

    // Extract message content
    let messageText = "";
    let messageType = "text";

    if (msg.type === "text") {
      messageText = msg.text?.body || "";
    } else if (msg.type === "button") {
      messageText = msg.button?.text || "";
    } else if (msg.type === "interactive") {
      messageText =
        msg.interactive?.button_reply?.title ||
        msg.interactive?.list_reply?.title ||
        "";
    } else if (msg.type === "image") {
      messageType = "image";
      messageText = msg.image?.caption || "[Image received]";
    } else {
      messageText = `[${msg.type} attachment]`;
    }

    // 1. Locate or create Lead in tenant database
    let lead = await Lead.findOne({
      $or: [
        { phone: cleanPhone },
        { phone: last10 },
        { phone: new RegExp(last10 + "$") },
      ],
    });

    if (!lead) {
      lead = await Lead.create({
        name: senderName,
        phone: cleanPhone,
        source: "WhatsApp",
        service: "General Enquiry",
        status: "New",
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
      messageId: msg.id || `in_cloud_${Date.now()}`,
      leadId: lead._id,
      sender: cleanPhone,
      senderName,
      direction: "incoming",
      messageType,
      text: messageText,
      timestamp: now,
      source: "cloud_api_chat",
      status: "delivered",
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
      io.to(`org_${org._id}`).emit("new_message", incomingRecord);
      io.to(`org_${org._id}`).emit("conversation_updated", {
        leadId: lead._id,
        lastMessage: messageText,
        lastMessageTime: now,
      });
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
      console.log(
        `[WhatsAppWebhook] AI reply skipped for lead ${cleanPhone} (aiEnabled: ${lead.aiEnabled}, paused: ${isAiPaused})`
      );
      continue;
    }

    // Trigger AI in background (does not block webhook response)
    (async () => {
      try {
        console.log(`[WhatsAppWebhook] Generating AI response for lead ${cleanPhone}...`);
        const aiResponseText = await generateAIResponse(
          lead._id,
          messageText,
          tenantModels,
          org
        );

        if (!aiResponseText || !aiResponseText.trim()) return;

        // Verify that 24-hour service window has not expired
        if (new Date() > new Date(lead.serviceWindowExpiresAt)) {
          console.warn(
            `[WhatsAppWebhook] 24-hour window expired for ${cleanPhone}. Cannot send free-form AI text.`
          );
          return;
        }

        const accessToken = decryptApiKey(org.whatsappCloudSettings.accessTokenEncrypted);
        if (!accessToken) {
          console.error(`[WhatsAppWebhook] Missing decrypted access token for org ${org._id}`);
          return;
        }

        // Send free-form AI message via Cloud API
        const sendResult = await sendTextMessage({
          phoneNumberId: org.whatsappCloudSettings.phoneNumberId,
          accessToken,
          toPhone: cleanPhone,
          textBody: aiResponseText,
        });

        const replyTime = new Date();

        // Save AI outgoing message
        const outgoingRecord = await Message.create({
          messageId: sendResult.metaMessageId || `out_ai_${Date.now()}`,
          leadId: lead._id,
          sender: "AI Agent",
          senderName: org.aiSettings?.agentPersona || "AI Sales Representative",
          direction: "outgoing",
          messageType: "text",
          text: aiResponseText,
          timestamp: replyTime,
          aiGenerated: true,
          source: "cloud_api_chat",
          status: "sent",
        });

        // Update Conversation
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
          io.to(`org_${org._id}`).emit("new_message", outgoingRecord);
          io.to(`org_${org._id}`).emit("conversation_updated", {
            leadId: lead._id,
            lastMessage: aiResponseText,
            lastMessageTime: replyTime,
          });
        }

        console.log(`[WhatsAppWebhook] Successfully sent AI reply to ${cleanPhone}`);
      } catch (aiErr) {
        console.error(`[WhatsAppWebhook] Error generating/sending AI reply to ${cleanPhone}:`, aiErr);
      }
    })();
  }
};
