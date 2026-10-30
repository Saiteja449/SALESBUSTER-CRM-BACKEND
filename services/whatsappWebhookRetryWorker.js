import { getMasterModels } from "./tenantManager.js";
import {
  claimOrPersistWebhookEvent,
  markEventProcessed,
  markEventFailed,
  processChangeItem,
} from "../controllers/whatsappWebhookController.js";

let retryIntervalTimer = null;
let isRetrying = false;

/**
 * Reprocesses webhook events that are in 'pending' or 'failed' status
 * and have not exceeded the maximum retry count.
 */
export const reprocessPendingWebhookEvents = async (options = {}) => {
  const { maxRetries = 3, olderThanMs = 15000, limit = 50, masterModels } = options;
  const { Organization, WAAccount, WAWebhookEvent } = masterModels || getMasterModels();
  if (!WAWebhookEvent) return { reprocessed: 0, failed: 0, skipped: 0 };

  const cutoff = new Date(Date.now() - olderThanMs);
  const pendingOrFailed = await WAWebhookEvent.find({
    status: { $in: ["pending", "failed"] },
    updatedAt: { $lt: cutoff },
    $or: [{ retryCount: { $lt: maxRetries } }, { retryCount: { $exists: false } }],
  })
    .sort({ createdAt: 1 })
    .limit(limit);

  let reprocessed = 0;
  let failed = 0;
  let skipped = 0;

  for (const doc of pendingOrFailed) {
    // Atomically claim the event for retry
    const claim = await claimOrPersistWebhookEvent(
      WAWebhookEvent,
      doc.eventId,
      doc.field,
      doc.payload,
      "processing"
    );

    if (!claim.shouldProcess) {
      skipped++;
      continue;
    }

    try {
      await WAWebhookEvent.updateOne(
        { eventId: doc.eventId },
        { $inc: { retryCount: 1 } }
      );

      // Reconstruct change item for processing
      const item = {
        entryId: "retry",
        field: doc.field,
        value: doc.payload,
        phoneNumberId:
          doc.payload?.metadata?.phone_number_id ||
          doc.payload?.phone_number_id ||
          doc.payload?.metadata?.display_phone_number,
        changeLevelEventId: doc.eventId,
      };

      await processChangeItem(item, { Organization, WAAccount, WAWebhookEvent });
      await markEventProcessed(WAWebhookEvent, doc.eventId);
      reprocessed++;
    } catch (err) {
      console.error(`[WebhookRetryWorker] Error re-processing event ${doc.eventId}:`, err);
      await markEventFailed(WAWebhookEvent, doc.eventId, err.message);
      failed++;
    }
  }

  return { reprocessed, failed, skipped };
};

/**
 * Starts periodic background polling for webhook retries.
 */
export const startWebhookRetryWorker = ({ intervalMs = 60000, maxRetries = 3 } = {}) => {
  if (retryIntervalTimer) return;

  retryIntervalTimer = setInterval(async () => {
    if (isRetrying) return;
    isRetrying = true;
    try {
      await reprocessPendingWebhookEvents({ maxRetries });
    } catch (err) {
      console.error("[WebhookRetryWorker] Worker tick error:", err);
    } finally {
      isRetrying = false;
    }
  }, intervalMs);

  if (retryIntervalTimer.unref) {
    retryIntervalTimer.unref();
  }

  console.log(`[WebhookRetryWorker] Background retry worker started (interval: ${intervalMs}ms)`);
};

/**
 * Stops periodic background polling for webhook retries.
 */
export const stopWebhookRetryWorker = () => {
  if (retryIntervalTimer) {
    clearInterval(retryIntervalTimer);
    retryIntervalTimer = null;
    console.log("[WebhookRetryWorker] Background retry worker stopped.");
  }
};
