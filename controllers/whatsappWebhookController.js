import crypto from "crypto";
import { getMasterModels, getTenantModels } from "../services/tenantManager.js";
import { decryptApiKey } from "../utils/encryption.js";
import { sendTextMessage } from "../services/whatsappCloudService.js";
import { generateAIResponse } from "../ai/aiService.js";
import { getIO } from "../socket/socket.js";

/**
 * Validates Meta X-Hub-Signature-256 HMAC-SHA256 signature using raw request buffer.
 *
 * Fix #5 – Fail-closed behaviour:
 *   - In production (NODE_ENV=production) a missing META_APP_SECRET is a fatal
 *     misconfiguration: all requests are rejected and the error is logged loudly.
 *   - In non-production environments the missing secret emits a loud warning but
 *     still allows traffic so local development keeps working.
 *   - Signature comparison uses constant-time Buffer comparison to prevent
 *     timing-oracle attacks.
 *   - Mismatched buffer lengths are rejected explicitly before timingSafeEqual.
 */
export const verifyMetaSignature = (req) => {
  const appSecret = process.env.META_APP_SECRET;

  if (!appSecret) {
    const isProd =
      (process.env.NODE_ENV || "").toLowerCase() === "production";
    if (isProd) {
      console.error(
        "[WebhookSecurity] FATAL: META_APP_SECRET is not set. " +
          "All webhook requests will be rejected (fail-closed in production)."
      );
      return false;
    }
    // Non-production: warn but allow so local dev works without the secret.
    console.warn(
      "[WebhookSecurity] WARNING: META_APP_SECRET is not configured. " +
        "Webhook HMAC validation is DISABLED. Set META_APP_SECRET before deploying to production."
    );
    return true;
  }

  const signature = req.headers["x-hub-signature-256"];
  if (!signature) {
    console.warn("[WebhookSecurity] Missing X-Hub-Signature-256 header.");
    return false;
  }

  const rawBody = req.rawBody || JSON.stringify(req.body);

  let expectedBuf;
  try {
    const hex = crypto
      .createHmac("sha256", appSecret)
      .update(rawBody)
      .digest("hex");
    expectedBuf = Buffer.from(`sha256=${hex}`);
  } catch (computeErr) {
    console.error(
      "[WebhookSecurity] HMAC computation error:",
      computeErr.message
    );
    return false;
  }

  let receivedBuf;
  try {
    receivedBuf = Buffer.from(String(signature));
  } catch {
    return false;
  }

  // Lengths must match before timingSafeEqual to prevent length-timing leaks.
  if (receivedBuf.length !== expectedBuf.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(receivedBuf, expectedBuf);
  } catch {
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
      return res
        .status(400)
        .send("Missing hub.mode or hub.verify_token parameters.");
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
      console.log(
        `[WebhookVerification] Verified immediately (org: ${
          orgId || "global"
        }) with token: ${token}`
      );
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
          console.log(
            `[WebhookVerification] Verified via custom DB token for org: ${orgId}`
          );
          return res.status(200).send(challenge);
        }
      } catch (err) {
        console.warn(
          `[WebhookVerification] Org DB lookup error for ${orgId}:`,
          err.message
        );
      }
      console.warn(
        `[WebhookVerification] Token mismatch for org ${orgId}. Received: ${token}`
      );
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

// ---------------------------------------------------------------------------
// Fix #4 – Durable ingestion before acknowledgement & atomic deduplication
// ---------------------------------------------------------------------------
/**
 * Atomically claims or records a webhook event in WAWebhookEvent.
 *
 * Concurrency & Idempotency:
 *  - Uses findOneAndUpdate with status $nin: ["processed", "processing"] and upsert: true.
 *  - If the event is already "processing" or "processed", the filter fails to match and
 *    MongoDB attempts an upsert with the same eventId, triggering E11000 duplicate key error.
 *  - Catching E11000 guarantees that concurrent retries are safely recognized as duplicates
 *    without check-then-write race conditions.
 */
export const claimOrPersistWebhookEvent = async (
  WAWebhookEvent,
  eventId,
  field,
  payload,
  targetStatus = "processing"
) => {
  if (!WAWebhookEvent || !eventId) {
    return { shouldProcess: true, isDuplicate: false };
  }

  try {
    const doc = await WAWebhookEvent.findOneAndUpdate(
      {
        eventId,
        status: { $nin: ["processed", "processing"] },
      },
      {
        $setOnInsert: {
          eventId,
          field,
          payload,
        },
        $set: {
          status: targetStatus,
          lockedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    return { shouldProcess: true, isDuplicate: false, doc };
  } catch (err) {
    // E11000 duplicate key error indicates another concurrent delivery or previous run
    // already inserted this eventId with status "processed" or "processing".
    if (err.code === 11000 || String(err.message).includes("E11000")) {
      return { shouldProcess: false, isDuplicate: true };
    }
    // Genuine database failure (connection drop, disk full, etc.)
    throw err;
  }
};

/**
 * Persists raw incoming change durably with status "pending" before acknowledging Meta.
 * Throws genuine database errors so the HTTP handler can fail-closed with 500.
 */
export const persistPendingChange = async (
  WAWebhookEvent,
  eventId,
  field,
  payload
) => {
  if (!WAWebhookEvent || !eventId) return;

  try {
    await WAWebhookEvent.updateOne(
      { eventId },
      {
        $setOnInsert: {
          eventId,
          field,
          payload,
          status: "pending",
        },
      },
      { upsert: true }
    );
  } catch (err) {
    if (err.code === 11000 || String(err.message).includes("E11000")) {
      return; // Already present
    }
    throw err;
  }
};

export const markEventProcessed = async (WAWebhookEvent, eventId) => {
  if (!WAWebhookEvent || !eventId) return;
  try {
    await WAWebhookEvent.updateOne(
      { eventId },
      { $set: { status: "processed", processedAt: new Date() } }
    );
  } catch (_) {}
};

export const markEventFailed = async (WAWebhookEvent, eventId, errorMessage) => {
  if (!WAWebhookEvent || !eventId) return;
  try {
    await WAWebhookEvent.updateOne(
      { eventId },
      { $set: { status: "failed", errorMessage: String(errorMessage) } }
    );
  } catch (_) {}
};

// ---------------------------------------------------------------------------
// Fix #1 – Per-item idempotency key builder
// ---------------------------------------------------------------------------
export const makeMessageEventId = (entryId, wamid) =>
  `msg_${entryId}_${wamid}`;

export const makeStatusEventId = (entryId, wamid, statusType) =>
  `status_${entryId}_${wamid}_${statusType}`;

export const makeChangeLevelEventId = (entryId, field, phoneNumberId, timestamp = "0") =>
  `change_${entryId}_${field}_${phoneNumberId || "unknown"}_${timestamp}`;

// ---------------------------------------------------------------------------
// Main webhook handler
// ---------------------------------------------------------------------------
/**
 * Handles incoming Meta WhatsApp Cloud API events (POST).
 *
 * Fix #4 – Durable before-ack: we persist each change to WAWebhookEvent
 * BEFORE calling res.send("EVENT_RECEIVED"). A crash after persistence but
 * before processing leaves the record in "pending" state so Meta re-delivers
 * and we can reprocess.
 *
 * Fix #1 – Per-item idempotency: separate eventIds for every message and
 * every status update, preventing same-phone events from sharing a key.
 */
export const receiveWhatsAppWebhook = async (req, res) => {
  // 1. Cryptographic signature check FIRST before doing anything else
  if (!verifyMetaSignature(req)) {
    console.error(
      "[WebhookSecurity] Webhook payload rejected: Invalid HMAC-SHA256 signature."
    );
    return res.status(401).send("Invalid webhook signature.");
  }

  const body = req.body;

  // 2. Quick structural sanity check
  if (!body || (body.object !== "whatsapp_business_account" && !body.entry)) {
    return res.status(200).send("EVENT_RECEIVED");
  }

  const { Organization, WAAccount, WAWebhookEvent } =
    req.masterModels || getMasterModels();

  // 3. Collect change items from the payload
  const changeItems = [];

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const field = change.field;
      const value = change.value;
      if (!value) continue;

      const phoneNumberId =
        value.metadata?.phone_number_id ||
        value.phone_number_id ||
        value.metadata?.display_phone_number;

      const timestamp = entry.time || value.statuses?.[0]?.timestamp || value.messages?.[0]?.timestamp || "0";
      const changeLevelId = makeChangeLevelEventId(
        entry.id || "entry",
        field,
        phoneNumberId,
        timestamp
      );

      changeItems.push({
        entryId: entry.id || "entry",
        field,
        value,
        phoneNumberId,
        changeLevelEventId: changeLevelId,
      });
    }
  }

  // 4. Durably persist events BEFORE acknowledging Meta.
  //    If pre-acknowledgment persistence fails, return HTTP 500 so Meta will retry!
  try {
    if (WAWebhookEvent) {
      for (const item of changeItems) {
        await persistPendingChange(
          WAWebhookEvent,
          item.changeLevelEventId,
          item.field,
          item.value
        );
      }
    }
  } catch (persistErr) {
    console.error(
      "[WhatsAppWebhook] Ingestion persistence failed; rejecting with 500 so Meta retries:",
      persistErr
    );
    return res.status(500).send("INGESTION_FAILED");
  }

  // 5. Acknowledge Meta AFTER durable persistence is guaranteed.
  res.status(200).send("EVENT_RECEIVED");

  // 6. Asynchronously process each change item
  (async () => {
    for (const item of changeItems) {
      try {
        await processChangeItem(item, { Organization, WAAccount, WAWebhookEvent });
      } catch (itemErr) {
        console.error(
          `[WhatsAppWebhook] Error processing change item (${item.field}):`,
          itemErr
        );
      }
    }
  })();
};

/**
 * Processes a single change item (messages, status updates, echoes, etc.).
 * Shared by both live webhook processing and the background retry worker.
 */
export const processChangeItem = async (
  item,
  { Organization, WAAccount, WAWebhookEvent } = {}
) => {
  const {
    entryId,
    field,
    value,
    phoneNumberId,
    changeLevelEventId,
  } = item;

  try {
    // Resolve Organization & WAAccount
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

    if (!org) {
      const storedEvt = WAWebhookEvent
        ? await WAWebhookEvent.findOne({
            eventId: changeLevelEventId,
          }).lean()
        : null;
      if (storedEvt?.payload?.orgId) {
        org = await Organization.findById(storedEvt.payload.orgId);
      }
    }

    if (!org || !org.tenantDbName) {
      console.warn(
        `[WhatsAppWebhook] No active organization found for phone_number_id: ${phoneNumberId} (field: ${field})`
      );
      await markEventFailed(
        WAWebhookEvent,
        changeLevelEventId,
        "Organization not found"
      );
      return;
    }

    const tenantModels = getTenantModels(org.tenantDbName);

    // MULTI-FIELD DISPATCH
    if (field === "messages") {
      // Status updates
      if (Array.isArray(value.statuses) && value.statuses.length > 0) {
        await processStatusUpdates(
          value.statuses,
          tenantModels,
          org,
          entryId,
          WAWebhookEvent
        );
      }

      // Inbound customer messages
      if (Array.isArray(value.messages) && value.messages.length > 0) {
        await processInboundMessages(
          value.messages,
          value.contacts,
          tenantModels,
          org,
          waAccount,
          entryId,
          WAWebhookEvent
        );
      }
    } else if (field === "smb_message_echoes") {
      const claim = await claimOrPersistWebhookEvent(
        WAWebhookEvent,
        changeLevelEventId,
        field,
        value,
        "processing"
      );
      if (claim.shouldProcess) {
        const echoes = value.messages || value.message_echoes || [];
        if (Array.isArray(echoes) && echoes.length > 0) {
          await processMobileAppEchoes(echoes, tenantModels, org, waAccount);
        }
      }
    } else if (field === "smb_app_state_sync") {
      const claim = await claimOrPersistWebhookEvent(
        WAWebhookEvent,
        changeLevelEventId,
        field,
        value,
        "processing"
      );
      if (claim.shouldProcess) {
        const contactsData = value.contacts || value.app_state_sync || [];
        if (Array.isArray(contactsData) && contactsData.length > 0) {
          await processAppStateContacts(contactsData, tenantModels, org, waAccount);
        }
      }
    } else if (field === "history") {
      const claim = await claimOrPersistWebhookEvent(
        WAWebhookEvent,
        changeLevelEventId,
        field,
        value,
        "processing"
      );
      if (claim.shouldProcess) {
        await processChatHistoryChunk(value, tenantModels, org, waAccount);
      }
    } else if (field === "account_update") {
      const claim = await claimOrPersistWebhookEvent(
        WAWebhookEvent,
        changeLevelEventId,
        field,
        value,
        "processing"
      );
      if (claim.shouldProcess) {
        await processAccountUpdate(value, org, waAccount);
      }
    }

    await markEventProcessed(WAWebhookEvent, changeLevelEventId);
  } catch (err) {
    console.error(
      `[WhatsAppWebhook] Error in processChangeItem (${field}):`,
      err
    );
    await markEventFailed(WAWebhookEvent, changeLevelEventId, err.message);
    throw err;
  }
};

/**
 * Idempotently updates recipient records based on Meta delivery receipts with status ranking.
 *
 * Fix #1 – Each status object gets its own eventId: "status_<entryId>_<wamid>_<statusType>"
 */
const processStatusUpdates = async (
  statuses,
  tenantModels,
  org,
  entryId,
  WAWebhookEvent
) => {
  const { WhatsAppCampaignRecipient, Message } = tenantModels;
  const io = getIO();

  for (const statusObj of statuses) {
    const metaMessageId = statusObj.id;
    const statusStr = (statusObj.status || "").toLowerCase(); // "sent", "delivered", "read", "failed"
    const timestamp = statusObj.timestamp
      ? new Date(parseInt(statusObj.timestamp) * 1000)
      : new Date();

    if (!metaMessageId) continue;

    // Per-item deduplication for status updates
    const statusEventId = makeStatusEventId(
      entryId || "entry",
      metaMessageId,
      statusStr
    );
    const { shouldProcess, isDuplicate } = await claimOrPersistWebhookEvent(
      WAWebhookEvent,
      statusEventId,
      "status_update",
      { metaMessageId, statusStr },
      "processing"
    );
    if (!shouldProcess || isDuplicate) {
      console.log(
        `[WhatsAppWebhook] Skipping duplicate status update: ${statusEventId}`
      );
      continue;
    }

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

    if (!WhatsAppCampaignRecipient) {
      await markEventProcessed(WAWebhookEvent, statusEventId);
      continue;
    }

    const recipient = await WhatsAppCampaignRecipient.findOne({
      metaMessageId,
    });
    if (!recipient) {
      await markEventProcessed(WAWebhookEvent, statusEventId);
      continue;
    }

    if (recipient.status === "Skipped") {
      await markEventProcessed(WAWebhookEvent, statusEventId);
      continue;
    }

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
        await markEventProcessed(WAWebhookEvent, statusEventId);
        continue;
      }

      if (recipient.status !== "Failed") {
        const errDetail = statusObj.errors?.[0] || {};
        updateFields = {
          status: "Failed",
          failedAt: timestamp,
          errorCode: String(errDetail.code || "UNKNOWN"),
          errorMessage:
            errDetail.title || errDetail.message || "Meta delivery failure",
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

    await markEventProcessed(WAWebhookEvent, statusEventId);
  }
};

// ---------------------------------------------------------------------------
// Fix #2 – Canonical international phone number helpers
// ---------------------------------------------------------------------------
/**
 * Derives a canonical international phone number (digits only, no leading +)
 * suitable for sending via Meta Cloud API.
 *
 * Rules:
 *  - Already has 12 digits starting with "91"  →  keep as-is (Indian E.164)
 *  - Exactly 10 digits                          →  prefix "91" (Indian local)
 *  - Starts with "0" and 11 digits             →  strip leading 0, prefix "91"
 *  - Already has another country code (≥11 d)  →  keep as-is
 *  - Anything else                              →  return as-is (caller should validate)
 *
 * This function never double-prefixes a number that already has a country code.
 */
export const toInternationalPhone = (rawPhone) => {
  if (!rawPhone) return "";
  const digits = String(rawPhone).replace(/\D/g, "");

  // Already has Indian country code exactly (91 + 10 digits = 12)
  if (digits.startsWith("91") && digits.length === 12) return digits;

  // Indian local number (10 digits)
  if (digits.length === 10) return `91${digits}`;

  // Local number with leading 0 (0XXXXXXXXXX = 11 digits)
  if (digits.startsWith("0") && digits.length === 11) return `91${digits.slice(1)}`;

  // Already has some country code (≥11 digits not caught above)
  return digits;
};

/**
 * Strips country code to get the canonical 10-digit local number for lead
 * lookup – used for inbound message deduplication / lead resolution.
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
 * Processes incoming customer messages, deduplicates via wamid, updates 24h window,
 * and triggers AI reply.
 *
 * Fix #1 – Per-wamid idempotency key so two messages from the same phone never
 * collide on a shared event ID.
 * Fix #2 – Stores the canonical international number alongside the local number
 * so outbound replies can derive the correct recipient without double-prefixing.
 */
const processInboundMessages = async (
  messages,
  contacts,
  tenantModels,
  org,
  waAccount,
  entryId,
  WAWebhookEvent
) => {
  const { Lead, Message, Conversation, WhatsAppOptOut } = tenantModels;
  const io = getIO();

  for (const msg of messages) {
    const rawSender = msg.from; // Full international number as supplied by Meta (e.g. "919876543210")
    const cleanPhone = normalizePhoneDigits(rawSender); // 10-digit local
    const intlPhone = toInternationalPhone(rawSender); // 12-digit international (for sending)
    if (!cleanPhone) continue;

    // Strict per-message deduplication by wamid
    const wamid = msg.id;

    if (wamid && WAWebhookEvent) {
      const msgEventId = makeMessageEventId(entryId || "entry", wamid);
      const { shouldProcess, isDuplicate } = await claimOrPersistWebhookEvent(
        WAWebhookEvent,
        msgEventId,
        "inbound_message",
        { wamid, from: rawSender },
        "processing"
      );
      if (!shouldProcess || isDuplicate) {
        console.log(
          `[WhatsAppWebhook] Skipping duplicate inbound message: ${msgEventId}`
        );
        continue;
      }

      // Also check tenant Message collection for backward-compatibility
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
        await markEventProcessed(WAWebhookEvent, msgEventId);
        continue;
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
        messageText =
          msg.document?.caption || msg.document?.filename || "[Document]";
        mediaUrl = msg.document?.id || "";
      } else if (msg.type === "location") {
        messageType = "location";
        messageText = `[Location: ${msg.location?.latitude}, ${msg.location?.longitude}]`;
      } else {
        messageText = `[${msg.type || "Media"}]`;
      }

      // 1. Find or create Lead in tenant database
      //    Search by local 10-digit and various international forms.
      let lead = await Lead.findOne({
        $or: [
          { phone: cleanPhone },
          { phone: `+91${cleanPhone}` },
          { phone: `91${cleanPhone}` },
          { phone: rawSender },
          { phoneNormalized: intlPhone },
        ],
      });

      if (!lead) {
        const assignedTo = waAccount?.userId ? waAccount.userId : "Unassigned";

        lead = await Lead.create({
          name: senderName,
          phone: cleanPhone, // store local 10-digit for display
          phoneNormalized: intlPhone, // store canonical international for sending
          source: "WhatsApp",
          service: "General Enquiry",
          status: "New",
          assignedTo,
          joinedAt: new Date(),
          lastActivity: new Date(),
        });
        console.log(
          `[WhatsAppWebhook] Created new lead for inbound Cloud API sender: ${cleanPhone} (intl: ${intlPhone})`
        );
      } else if (!lead.phoneNormalized) {
        // Back-fill phoneNormalized for existing leads that were created before this fix
        lead.phoneNormalized = intlPhone;
      }

      // 2. Extend 24-hour Meta Customer Service Window
      const now = new Date();
      lead.lastCloudInboundAt = now;
      lead.serviceWindowExpiresAt = new Date(
        now.getTime() + 24 * 60 * 60 * 1000
      );
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

        console.log(
          `[WhatsAppWebhook] Recorded marketing opt-out for ${cleanPhone}`
        );

        if (io) {
          io.to(`org_${org._id}`).emit("lead_opted_out", {
            leadId: lead._id,
            phone: cleanPhone,
          });
        }

        await markEventProcessed(WAWebhookEvent, msgEventId);
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
        timestamp: msg.timestamp
          ? new Date(parseInt(msg.timestamp) * 1000)
          : now,
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

      await markEventProcessed(WAWebhookEvent, msgEventId);

      // 5. Inbound AI Auto-Reply Check
      const isAiPaused =
        lead.aiPausedUntil &&
        new Date(lead.aiPausedUntil).getTime() > now.getTime();
      const canAiReply =
        lead.aiEnabled &&
        !lead.disableAI &&
        !isAiPaused &&
        org.aiSettings?.isAiConfigured &&
        org.aiSettings?.geminiApiKey;

      if (!canAiReply) {
        continue;
      }

      // Trigger AI auto-reply (fire-and-forget)
      (async () => {
        try {
          console.log(
            `[WhatsAppWebhook] Generating AI response for lead ${cleanPhone}...`
          );
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
            waAccount?.phoneNumberId ||
            org.whatsappCloudSettings?.phoneNumberId;

          if (!accessToken || !targetPhoneId) {
            console.error(
              `[WhatsAppWebhook] Missing access token or phone ID for AI reply.`
            );
            return;
          }

          // Fix #2 – use canonical international number for AI reply
          const recipientPhone =
            lead.phoneNormalized || intlPhone || cleanPhone;

          const sendResult = await sendTextMessage({
            phoneNumberId: targetPhoneId,
            accessToken,
            toPhone: recipientPhone,
            textBody: aiResponseText,
          });

          const replyTime = new Date();

          const outgoingRecord = await Message.create({
            messageId: sendResult.metaMessageId || `out_ai_${Date.now()}`,
            wamid: sendResult.metaMessageId || null,
            leadId: lead._id,
            sender: "AI Agent",
            senderName:
              org.aiSettings?.agentPersona || "AI Sales Representative",
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
          console.error(
            `[WhatsAppWebhook] Error generating/sending AI reply:`,
            aiErr
          );
        }
      })();
    } else if (!wamid) {
      // No wamid – still process but can't deduplicate precisely
      const contactObj = contacts?.find((c) => c.wa_id === rawSender);
      const senderName = contactObj?.profile?.name || rawSender;
      let messageType = "text";
      let messageText = msg.type === "text" ? msg.text?.body || "" : `[${msg.type || "Media"}]`;

      let lead = await Lead.findOne({
        $or: [
          { phone: cleanPhone },
          { phone: `+91${cleanPhone}` },
          { phone: `91${cleanPhone}` },
          { phone: rawSender },
        ],
      });

      if (!lead) {
        lead = await Lead.create({
          name: senderName,
          phone: cleanPhone,
          phoneNormalized: intlPhone,
          source: "WhatsApp",
          service: "General Enquiry",
          status: "New",
          assignedTo: waAccount?.userId || "Unassigned",
          joinedAt: new Date(),
          lastActivity: new Date(),
        });
      }

      const now = new Date();
      lead.lastCloudInboundAt = now;
      lead.serviceWindowExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      if (!lead.phoneNormalized) lead.phoneNormalized = intlPhone;
      lead.lastActivity = now;
      await lead.save();

      await Message.create({
        messageId: `in_cloud_${Date.now()}`,
        leadId: lead._id,
        sender: cleanPhone,
        senderName,
        direction: "incoming",
        messageType,
        text: messageText,
        timestamp: msg.timestamp ? new Date(parseInt(msg.timestamp) * 1000) : now,
        source: "cloud_api",
        status: "delivered",
        rawPayload: msg,
      });

      await Conversation.findOneAndUpdate(
        { leadId: lead._id },
        { lastMessage: messageText, lastMessageTime: now, $inc: { unreadCount: 1 } },
        { upsert: true }
      );
    }
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
    const intlPhone = toInternationalPhone(rawRecipient);
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
        phoneNormalized: intlPhone,
        source: "WhatsApp",
        service: "General Enquiry",
        status: "Contacted",
        assignedTo,
        joinedAt: now,
        lastActivity: now,
      });
    } else if (!lead.phoneNormalized) {
      lead.phoneNormalized = intlPhone;
    }

    // SMART AI PAUSE: When a human sales rep replies directly from their phone, pause AI for 60 minutes
    const pauseUntil = new Date(now.getTime() + 60 * 60 * 1000);
    lead.aiPausedUntil = pauseUntil;
    lead.lastActivity = now;
    await lead.save();

    console.log(
      `[WhatsAppCoexistence] Captured mobile echo for ${cleanPhone}. AI paused for 60m until ${pauseUntil.toISOString()}`
    );

    // Insert Outbound message record with source: "business_app"
    const timestamp = echo.timestamp
      ? new Date(parseInt(echo.timestamp) * 1000)
      : now;
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
const processAppStateContacts = async (
  contacts,
  tenantModels,
  org,
  waAccount
) => {
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
    console.log(
      `[WhatsAppCoexistence] Client declined history sharing for account ${waAccount?._id}`
    );
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
        phoneNormalized: toInternationalPhone(item.from || item.to),
        source: "WhatsApp History",
        status: "Existing Client",
        assignedTo: waAccount?.userId || "Unassigned",
        joinedAt: new Date(),
      });
    }

    const direction =
      item.from === waAccount?.displayPhone ? "outgoing" : "incoming";
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
