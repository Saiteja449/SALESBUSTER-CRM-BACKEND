import { resumeInterruptedCampaigns } from "./whatsappCampaignWorker.js";
import {
  startCampaignScheduler,
  stopCampaignScheduler,
} from "./whatsappCampaignScheduler.js";
import {
  startWebhookRetryWorker,
  stopWebhookRetryWorker,
} from "./whatsappWebhookRetryWorker.js";
import {
  startInstagramCommentWatcher,
  stopInstagramCommentWatcher,
} from "./instagramService.js";
import { initAllOrganizationWhatsAppConnections } from "../whatsapp/whatsappService.js";

let areWorkersRunning = false;
let workerStartTime = null;

const workerRegistry = {
  whatsappConnections: false,
  campaignScheduler: false,
  webhookRetry: false,
  instagramWatcher: false,
};

/**
 * Initializes and starts all periodic background services and cron workers.
 * Respects ENABLE_BACKGROUND_WORKERS flag for multi-instance separation.
 */
export const startBackgroundWorkers = (io = null) => {
  const isEnabled =
    process.env.ENABLE_BACKGROUND_WORKERS !== "false" &&
    process.env.RUN_WORKERS !== "false";

  if (!isEnabled) {
    console.log("[BackgroundTasks] Background workers disabled by configuration (API-only mode).");
    return;
  }

  if (areWorkersRunning) {
    console.log("[BackgroundTasks] Background workers are already active.");
    return;
  }

  console.log("[BackgroundTasks] Initializing background workers and scheduled tasks...");

  try {
    // 1. WhatsApp Connections for tenant organizations
    initAllOrganizationWhatsAppConnections();
    workerRegistry.whatsappConnections = true;

    // 2. Resume interrupted WhatsApp campaigns
    resumeInterruptedCampaigns();

    // 3. WhatsApp Campaign recurring & scheduled dispatcher
    startCampaignScheduler();
    workerRegistry.campaignScheduler = true;

    // 4. WhatsApp Webhook retry worker
    startWebhookRetryWorker();
    workerRegistry.webhookRetry = true;

    // 5. Instagram comment watcher
    if (io) {
      startInstagramCommentWatcher(io);
      workerRegistry.instagramWatcher = true;
    }

    areWorkersRunning = true;
    workerStartTime = new Date();
    console.log("[BackgroundTasks] All background workers successfully initialized.");
  } catch (err) {
    console.error("[BackgroundTasks] Error initializing background workers:", err.message);
  }
};

/**
 * Gracefully terminates all background intervals and cron tasks.
 */
export const stopBackgroundWorkers = () => {
  if (!areWorkersRunning) return;

  console.log("[BackgroundTasks] Stopping all background workers...");
  try {
    stopCampaignScheduler();
    workerRegistry.campaignScheduler = false;

    stopWebhookRetryWorker();
    workerRegistry.webhookRetry = false;

    stopInstagramCommentWatcher();
    workerRegistry.instagramWatcher = false;

    areWorkersRunning = false;
    console.log("[BackgroundTasks] All background workers stopped cleanly.");
  } catch (err) {
    console.error("[BackgroundTasks] Error stopping background workers:", err.message);
  }
};

/**
 * Diagnostic status for health check monitoring.
 */
export const getBackgroundWorkersStatus = () => {
  return {
    enabled:
      process.env.ENABLE_BACKGROUND_WORKERS !== "false" &&
      process.env.RUN_WORKERS !== "false",
    isRunning: areWorkersRunning,
    startedAt: workerStartTime,
    workers: { ...workerRegistry },
  };
};

export default {
  startBackgroundWorkers,
  stopBackgroundWorkers,
  getBackgroundWorkersStatus,
};

