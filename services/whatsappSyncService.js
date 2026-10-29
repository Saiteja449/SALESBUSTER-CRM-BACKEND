import WAAccount from "../models/WhatsAppAccount.js";
import { decryptApiKey } from "../utils/encryption.js";

const getGraphApiVersion = () => process.env.META_GRAPH_API_VERSION || "v26.0";
const getGraphApiBaseUrl = () =>
  `https://graph.facebook.com/${getGraphApiVersion()}`;

/**
 * Triggers initial synchronization of Contacts and Chat History with Meta Cloud API Coexistence.
 * Enforces single-trigger idempotency rules (contactsSyncRequested & historySyncRequested).
 */
export const processInitialSync = async ({ accountId, phoneNumberId, accessToken }) => {
  try {
    const account = await WAAccount.findById(accountId);
    if (!account) {
      console.warn(`[WhatsAppSync] Account ${accountId} not found.`);
      return;
    }

    const token = accessToken || decryptApiKey(account.accessTokenEncrypted);
    const targetPhoneId = phoneNumberId || account.phoneNumberId;

    if (!token || !targetPhoneId) {
      console.warn(`[WhatsAppSync] Missing token or phoneNumberId for account ${accountId}`);
      return;
    }

    // 1. Sync Contacts (smb_app_state_sync) - only once
    if (!account.contactsSyncRequested || !account.contactsSyncRequestId) {
      try {
        console.log(`[WhatsAppSync] Requesting contacts sync for phone ${targetPhoneId}...`);
        const res = await fetch(`${getGraphApiBaseUrl()}/${targetPhoneId}/smb_app_data`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            sync_type: "smb_app_state_sync",
          }),
        });

        const data = await res.json();
        if (res.ok && !data.error) {
          account.contactsSyncRequested = true;
          account.contactsSyncRequestId = data.request_id || "requested";
          await account.save();
          console.log(`[WhatsAppSync] Contacts sync initiated. Request ID: ${account.contactsSyncRequestId}`);
        } else {
          console.warn(`[WhatsAppSync] Contacts sync API warning:`, data.error?.message || data);
          // If already requested or feature unavailable for this tier, mark flag to avoid spamming
          if (data.error?.code === 131000 || data.error?.message?.toLowerCase().includes("already")) {
            account.contactsSyncRequested = true;
            await account.save();
          }
        }
      } catch (err) {
        console.error(`[WhatsAppSync] Error initiating contacts sync for ${targetPhoneId}:`, err.message);
      }
    }

    // 2. Sync Chat History (history) - only once
    if (!account.historySyncRequested || !account.historySyncRequestId) {
      try {
        console.log(`[WhatsAppSync] Requesting chat history sync for phone ${targetPhoneId}...`);
        const res = await fetch(`${getGraphApiBaseUrl()}/${targetPhoneId}/smb_app_data`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            sync_type: "history",
          }),
        });

        const data = await res.json();
        if (res.ok && !data.error) {
          account.historySyncRequested = true;
          account.historySyncRequestId = data.request_id || "requested";
          await account.save();
          console.log(`[WhatsAppSync] Chat history sync initiated. Request ID: ${account.historySyncRequestId}`);
        } else {
          console.warn(`[WhatsAppSync] Chat history sync API warning:`, data.error?.message || data);
          if (data.error?.code === 131000 || data.error?.message?.toLowerCase().includes("already")) {
            account.historySyncRequested = true;
            await account.save();
          }
        }
      } catch (err) {
        console.error(`[WhatsAppSync] Error initiating history sync for ${targetPhoneId}:`, err.message);
      }
    }
  } catch (error) {
    console.error("[WhatsAppSync] processInitialSync unexpected failure:", error);
  }
};

/**
 * Asynchronously enqueues the initial sync job so HTTP onboarding returns without latency.
 */
export const enqueueSyncJob = async (jobData) => {
  setImmediate(async () => {
    try {
      await processInitialSync(jobData);
    } catch (err) {
      console.error("[WhatsAppSync] Asynchronous sync job error:", err);
    }
  });
};

/**
 * Watchdog helper to inspect accounts approaching their 24-hour coexistence sync deadline.
 */
export const checkSyncDeadlines = async () => {
  try {
    const now = new Date();
    const fourHoursFromNow = new Date(now.getTime() + 4 * 60 * 60 * 1000);

    const pendingAccounts = await WAAccount.find({
      status: "syncing",
      syncDeadline: { $lte: fourHoursFromNow, $gt: now },
      "historyProgress.isComplete": false,
    });

    for (const acc of pendingAccounts) {
      console.warn(
        `[WhatsAppSyncWatchdog] Account ${acc.phoneNumberId} (Org ${acc.organizationId}) is within 4h of sync deadline!`
      );
    }
  } catch (err) {
    console.error("[WhatsAppSyncWatchdog] Deadline inspection error:", err.message);
  }
};
