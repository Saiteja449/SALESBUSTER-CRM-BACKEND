import express from "express";
import {
  getRoiDashboardData,
  getCampaignRecords,
  createCampaignRecord,
  updateCampaignRecord,
  deleteCampaignRecord,
  triggerPlatformSync,
  exportRoiCsv,
} from "../controllers/marketingRoiController.js";
import { protect, requireCrmAccount } from "../middleware/authMiddleware.js";

const router = express.Router();

// Apply auth to all ROI endpoints
router.use(protect);
router.use(requireCrmAccount);

// Dashboard KPI metrics, timelines & platform breakdowns
router.get("/dashboard", getRoiDashboardData);

// Campaign performance table records with sorting & pagination
router.get("/campaigns", getCampaignRecords);

// Manual Campaign CRUD
router.post("/campaign", createCampaignRecord);
router.put("/campaign/:id", updateCampaignRecord);
router.delete("/campaign/:id", deleteCampaignRecord);

// Live Platform & CRM Lead Sync
router.post("/sync", triggerPlatformSync);

// Export CSV report
router.get("/export", exportRoiCsv);

export default router;
