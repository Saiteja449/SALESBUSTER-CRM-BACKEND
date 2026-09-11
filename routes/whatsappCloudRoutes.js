import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import {
  getCloudStatus,
  connectCloudAccount,
  disconnectCloudAccount,
  syncTemplates,
  getTemplates,
  estimateAudience,
} from "../controllers/whatsappCloudController.js";
import {
  createCampaign,
  getCampaigns,
  getCampaignById,
  startCampaign,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  retryFailedRecipients,
  getCampaignRecipients,
  getCampaignAnalytics,
} from "../controllers/whatsappCampaignController.js";

const router = express.Router();

// All WhatsApp Cloud routes require authentication
router.use(protect);

// 1. Account & Health
router.get("/status", getCloudStatus);
router.post("/connect", connectCloudAccount);
router.post("/disconnect", disconnectCloudAccount);

// 2. Templates
router.get("/templates", getTemplates);
router.post("/templates/sync", syncTemplates);

// 3. Audience Estimation
router.post("/audience/estimate", estimateAudience);

// 4. Campaigns CRUD & Lifecycle
router.get("/campaigns", getCampaigns);
router.post("/campaigns", createCampaign);
router.get("/campaigns/:id", getCampaignById);
router.post("/campaigns/:id/start", startCampaign);
router.post("/campaigns/:id/pause", pauseCampaign);
router.post("/campaigns/:id/resume", resumeCampaign);
router.post("/campaigns/:id/cancel", cancelCampaign);
router.post("/campaigns/:id/retry-failed", retryFailedRecipients);

// 5. Recipients & Analytics
router.get("/campaigns/:id/recipients", getCampaignRecipients);
router.get("/campaigns/:id/analytics", getCampaignAnalytics);

export default router;
