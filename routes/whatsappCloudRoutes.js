import express from "express";
import multer from "multer";
import { protect } from "../middleware/authMiddleware.js";
import {
  getCloudStatus,
  connectCloudAccount,
  disconnectCloudAccount,
  syncTemplates,
  getTemplates,
  createTemplate,
  deleteTemplate,
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

// Role-based authorization guard for administrative actions
const requireManagerOrOwner = (req, res, next) => {
  if (
    req.user?.role === "sales manager" ||
    req.user?.role === "super_admin" ||
    req.user?.isOrgOwner
  ) {
    return next();
  }
  return res.status(403).json({
    success: false,
    message: "Access forbidden: Manager or Administrator privileges required",
  });
};

// Memory upload handler for template sample media files (Image, Video, Document)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
});

// All WhatsApp Cloud routes require authentication and manager/owner privileges
router.use(protect);
router.use(requireManagerOrOwner);

// 1. Account & Health (Configuration restricted to manager/admin)
router.get("/status", requireManagerOrOwner, getCloudStatus);
router.post("/connect", requireManagerOrOwner, connectCloudAccount);
router.post("/disconnect", requireManagerOrOwner, disconnectCloudAccount);

// 2. Templates (Mutations restricted to manager/admin)
router.get("/templates", getTemplates);
router.post(
  "/templates",
  requireManagerOrOwner,
  upload.single("sampleFile"),
  createTemplate
);
router.delete("/templates/:id", requireManagerOrOwner, deleteTemplate);
router.post("/templates/sync", requireManagerOrOwner, syncTemplates);

// 3. Audience Estimation
router.post("/audience/estimate", estimateAudience);

// 4. Campaigns CRUD & Lifecycle (Mutations restricted to manager/admin)
router.get("/campaigns", getCampaigns);
router.post("/campaigns", requireManagerOrOwner, createCampaign);
router.get("/campaigns/:id", getCampaignById);
router.post("/campaigns/:id/start", requireManagerOrOwner, startCampaign);
router.post("/campaigns/:id/pause", requireManagerOrOwner, pauseCampaign);
router.post("/campaigns/:id/resume", requireManagerOrOwner, resumeCampaign);
router.post("/campaigns/:id/cancel", requireManagerOrOwner, cancelCampaign);
router.post(
  "/campaigns/:id/retry-failed",
  requireManagerOrOwner,
  retryFailedRecipients
);

// 5. Recipients & Analytics
router.get("/campaigns/:id/recipients", getCampaignRecipients);
router.get("/campaigns/:id/analytics", getCampaignAnalytics);

export default router;
