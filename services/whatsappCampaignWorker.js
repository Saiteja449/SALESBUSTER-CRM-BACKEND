import { sendTemplateMessage } from "./whatsappCloudService.js";
import { decryptApiKey } from "../utils/encryption.js";
import { getMasterModels, getTenantModels } from "./tenantManager.js";
import { getIO } from "../socket/socket.js";

const STALE_LOCK_MS = 120000; // 2 minutes for stale lease recovery
const runningCampaignWorkers = new Set(); // Tracks actively running campaign IDs in-process

/**
 * Sleeps for specified milliseconds.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Builds Meta template components array from recipient rendered parameters and media header.
 */
export const buildTemplateComponents = (campaign, recipient) => {
  const components = [];

  // 1. Header Media (IMAGE, DOCUMENT, VIDEO) if present
  if (campaign.headerMedia?.url) {
    const mediaType = campaign.headerMedia.type.toLowerCase();
    components.push({
      type: "header",
      parameters: [
        {
          type: mediaType,
          [mediaType]: {
            link: campaign.headerMedia.url,
            ...(campaign.headerMedia.fileName
              ? { filename: campaign.headerMedia.fileName }
              : {}),
          },
        },
      ],
    });
  }

  // 2. Body Parameters ({{1}}, {{2}}, etc.)
  if (Array.isArray(recipient.renderedParameters) && recipient.renderedParameters.length > 0) {
    components.push({
      type: "body",
      parameters: recipient.renderedParameters.map((val) => ({
        type: "text",
        text: String(val || ""),
      })),
    });
  }

  return components;
};

/**
 * Processes a single campaign's queue until finished, paused, or cancelled.
 */
export const processCampaignQueue = async (campaignId, tenantDbName, organizationId) => {
  const campaignKey = `${tenantDbName}_${campaignId}`;
  if (runningCampaignWorkers.has(campaignKey)) {
    console.log(`[CampaignWorker] Campaign ${campaignId} is already being processed.`);
    return;
  }

  runningCampaignWorkers.add(campaignKey);
  console.log(`[CampaignWorker] Starting worker for campaign ${campaignId} (Tenant: ${tenantDbName})`);

  try {
    const tenantModels = getTenantModels(tenantDbName);
    const { WhatsAppCampaign, WhatsAppCampaignRecipient, Message, Conversation } = tenantModels;
    const { Organization } = getMasterModels();

    const org = await Organization.findById(organizationId);
    if (!org || !org.whatsappCloudSettings?.isConfigured) {
      console.error(`[CampaignWorker] Organization ${organizationId} does not have WhatsApp Cloud API configured.`);
      await WhatsAppCampaign.findByIdAndUpdate(campaignId, {
        status: "Failed",
      });
      return;
    }

    const { phoneNumberId, accessTokenEncrypted } = org.whatsappCloudSettings;
    const accessToken = decryptApiKey(accessTokenEncrypted);
    if (!accessToken) {
      console.error(`[CampaignWorker] Failed to decrypt access token for organization ${organizationId}.`);
      await WhatsAppCampaign.findByIdAndUpdate(campaignId, {
        status: "Failed",
      });
      return;
    }

    // Reclaim any stale locks from previous crashes before starting loop
    await WhatsAppCampaignRecipient.updateMany(
      {
        campaignId,
        $or: [
          {
            status: "Sending",
            lockedAt: { $lt: new Date(Date.now() - STALE_LOCK_MS) },
          },
          {
            status: "Queued",
            lockedAt: { $ne: null, $lt: new Date(Date.now() - STALE_LOCK_MS) },
          },
        ],
      },
      {
        $set: { status: "Queued", lockedAt: null },
      }
    );

    let isRunning = true;
    let consecutiveRateLimits = 0;

    while (isRunning) {
      // 1. Verify campaign status hasn't been changed to Paused or Cancelled
      const currentCampaign = await WhatsAppCampaign.findById(campaignId);
      if (!currentCampaign || currentCampaign.status !== "Running") {
        console.log(`[CampaignWorker] Campaign ${campaignId} status is ${currentCampaign?.status || "null"}. Stopping worker loop.`);
        break;
      }

      // 2. Atomic Lease Lock next recipient (At-least-once crash-resilient queue)
      const recipient = await WhatsAppCampaignRecipient.findOneAndUpdate(
        {
          campaignId,
          $or: [
            { status: "Queued", lockedAt: null },
            {
              status: "Queued",
              lockedAt: { $lt: new Date(Date.now() - STALE_LOCK_MS) },
            },
            {
              status: "Sending",
              lockedAt: { $lt: new Date(Date.now() - STALE_LOCK_MS) },
            },
          ],
        },
        {
          $set: {
            status: "Sending",
            lockedAt: new Date(),
            workerId: `worker_${process.pid}_${Date.now()}`,
          },
        },
        { new: true }
      );

      // If no queued recipients left, check if any are still in "Sending"
      if (!recipient) {
        const stillSendingCount = await WhatsAppCampaignRecipient.countDocuments({
          campaignId,
          status: "Sending",
        });

        if (stillSendingCount === 0) {
          console.log(`[CampaignWorker] All recipients processed for campaign ${campaignId}. Marking completed.`);
          await WhatsAppCampaign.findByIdAndUpdate(campaignId, {
            status: "Completed",
            completedAt: new Date(),
          });

          const io = getIO();
          if (io) {
            io.to(`org_${organizationId}`).emit("campaign_completed", {
              campaignId,
              status: "Completed",
              completedAt: new Date(),
            });
          }
        }
        break;
      }

      // 3. Rate Pacing delay (Safer default 5 msg/sec)
      const messagesPerSecond =
        currentCampaign.messagesPerSecond ||
        org.whatsappCloudSettings.messagesPerSecond ||
        5;
      const delayMs = Math.max(15, Math.floor(1000 / messagesPerSecond));

      // 4. Send Message via WhatsApp Cloud API
      try {
        const components = buildTemplateComponents(currentCampaign, recipient);
        const sendResult = await sendTemplateMessage({
          phoneNumberId,
          accessToken,
          toPhone: recipient.recipientPhone,
          templateName: currentCampaign.templateName,
          languageCode: currentCampaign.templateLanguage || "en_US",
          components,
        });

        // SUCCESS: Update recipient to "Sent"
        const sentTime = new Date();
        await WhatsAppCampaignRecipient.findByIdAndUpdate(recipient._id, {
          status: "Sent",
          metaMessageId: sendResult.metaMessageId,
          sentAt: sentTime,
          lockedAt: null,
          errorCode: null,
          errorMessage: null,
        });

        // Increment campaign sent count
        await WhatsAppCampaign.findByIdAndUpdate(campaignId, {
          $inc: { sentCount: 1, queuedCount: -1 },
        });

        // Optionally record in Lead conversation history if leadId exists
        if (recipient.leadId) {
          try {
            await Message.create({
              messageId: sendResult.metaMessageId || `campaign_${Date.now()}_${recipient._id}`,
              leadId: recipient.leadId,
              sender: "Campaign Bot",
              senderName: currentCampaign.name,
              direction: "outgoing",
              messageType: "text",
              text: `[WhatsApp Campaign: ${currentCampaign.templateName}]`,
              timestamp: sentTime,
              source: "cloud_api_campaign",
              campaignId: currentCampaign._id,
              status: "sent",
            });

            await Conversation.findOneAndUpdate(
              { leadId: recipient.leadId },
              {
                lastMessage: `[Campaign: ${currentCampaign.templateName}]`,
                lastMessageTime: sentTime,
              },
              { upsert: true }
            );
          } catch (msgErr) {
            console.warn(`[CampaignWorker] Failed to sync message to conversation for lead ${recipient.leadId}:`, msgErr.message);
          }
        }

        consecutiveRateLimits = 0;

        // Emit Socket.IO progress update
        const io = getIO();
        if (io) {
          io.to(`org_${organizationId}`).emit("campaign_progress", {
            campaignId,
            recipientId: recipient._id,
            recipientPhone: recipient.recipientPhone,
            status: "Sent",
            metaMessageId: sendResult.metaMessageId,
          });
        }
      } catch (err) {
        const metaCode = err.meta?.code || err.code || null;
        const metaMessage = err.meta?.message || err.message || "Failed to send";

        console.error(
          `[CampaignWorker] Error sending to ${recipient.recipientPhone} (Code: ${metaCode}):`,
          metaMessage
        );

        // A. Meta Rate Limit Hit (130429 or 80007)
        if (metaCode === 130429 || metaCode === 80007) {
          consecutiveRateLimits++;
          const backoffDelay = Math.min(60000, 15000 * consecutiveRateLimits);
          console.warn(`[CampaignWorker] Meta rate limit hit. Backing off for ${backoffDelay}ms...`);

          // Release recipient lock so it can be retried
          await WhatsAppCampaignRecipient.findByIdAndUpdate(recipient._id, {
            status: "Queued",
            lockedAt: null,
            $inc: { retryCount: 1 },
          });

          await sleep(backoffDelay);
          continue;
        }

        // B. Tier Limit or Quality Score Block (131049) -> PAUSE CAMPAIGN IMMEDIATELY
        if (metaCode === 131049) {
          console.error(`[CampaignWorker] Meta tier or quality limit exceeded (131049). Pausing campaign immediately.`);
          await WhatsAppCampaign.findByIdAndUpdate(campaignId, {
            status: "Paused",
          });

          await WhatsAppCampaignRecipient.findByIdAndUpdate(recipient._id, {
            status: "Failed",
            errorCode: String(metaCode),
            errorMessage: metaMessage,
            lockedAt: null,
            failedAt: new Date(),
          });

          await WhatsAppCampaign.findByIdAndUpdate(campaignId, {
            $inc: { failedCount: 1, queuedCount: -1 },
          });

          const io = getIO();
          if (io) {
            io.to(`org_${organizationId}`).emit("campaign_paused", {
              campaignId,
              reason: "Meta messaging tier limit reached (131049). Campaign paused automatically.",
            });
          }
          break;
        }

        // C. Non-retryable failure (Invalid phone, template mismatch, unverified phone, etc.)
        const isNonRetryable =
          metaCode === 131026 || // Message undeliverable
          metaCode === 132000 || // Template param count mismatch
          metaCode === 132001 || // Template does not exist
          metaCode === 100 || // Invalid parameter
          (recipient.retryCount || 0) >= 3;

        if (isNonRetryable) {
          await WhatsAppCampaignRecipient.findByIdAndUpdate(recipient._id, {
            status: "Failed",
            errorCode: String(metaCode || "UNKNOWN"),
            errorMessage: metaMessage,
            lockedAt: null,
            failedAt: new Date(),
          });

          await WhatsAppCampaign.findByIdAndUpdate(campaignId, {
            $inc: { failedCount: 1, queuedCount: -1 },
          });

          const io = getIO();
          if (io) {
            io.to(`org_${organizationId}`).emit("campaign_progress", {
              campaignId,
              recipientId: recipient._id,
              recipientPhone: recipient.recipientPhone,
              status: "Failed",
              errorCode: metaCode,
              errorMessage: metaMessage,
            });
          }
        } else {
          // Retryable temporary error
          await WhatsAppCampaignRecipient.findByIdAndUpdate(recipient._id, {
            status: "Queued",
            lockedAt: null,
            $inc: { retryCount: 1 },
            errorCode: String(metaCode || "TEMP_ERR"),
            errorMessage: metaMessage,
          });
        }
      }

      // Wait between sends to respect messaging rate
      await sleep(delayMs);
    }
  } catch (workerErr) {
    console.error(`[CampaignWorker] Fatal worker error for campaign ${campaignId}:`, workerErr);
  } finally {
    runningCampaignWorkers.delete(campaignKey);
    console.log(`[CampaignWorker] Finished worker cycle for campaign ${campaignId}`);
  }
};

/**
 * Server restart recovery: resumes all campaigns that were left in "Running" status.
 */
export const resumeInterruptedCampaigns = async () => {
  try {
    const { Organization } = getMasterModels();
    const organizations = await Organization.find({
      status: "active",
      "whatsappCloudSettings.isConfigured": true,
    }).select("_id tenantDbName");

    console.log(`[CampaignWorker] Checking for interrupted campaigns across ${organizations.length} organizations...`);

    for (const org of organizations) {
      if (!org.tenantDbName) continue;
      try {
        const tenantModels = getTenantModels(org.tenantDbName);
        const { WhatsAppCampaign, WhatsAppCampaignRecipient } = tenantModels;

        // Reclaim all stale locks across the tenant database on restart
        await WhatsAppCampaignRecipient.updateMany(
          {
            $or: [
              {
                status: "Sending",
                lockedAt: { $lt: new Date(Date.now() - STALE_LOCK_MS) },
              },
              {
                status: "Queued",
                lockedAt: { $ne: null, $lt: new Date(Date.now() - STALE_LOCK_MS) },
              },
            ],
          },
          {
            $set: { status: "Queued", lockedAt: null },
          }
        );

        const interrupted = await WhatsAppCampaign.find({ status: "Running" });

        for (const camp of interrupted) {
          console.log(`[CampaignWorker] Resuming interrupted campaign ${camp._id} for tenant ${org.tenantDbName}`);
          processCampaignQueue(camp._id, org.tenantDbName, org._id.toString()).catch((err) =>
            console.error(`[CampaignWorker] Failed resuming campaign ${camp._id}:`, err)
          );
        }
      } catch (tenantErr) {
        console.warn(`[CampaignWorker] Error inspecting tenant ${org.tenantDbName}:`, tenantErr.message);
      }
    }
  } catch (err) {
    console.error("[CampaignWorker] Error in resumeInterruptedCampaigns:", err);
  }
};
