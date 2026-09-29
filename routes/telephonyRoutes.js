import express from "express";
import {
  getAgentCredentials,
  handleCDRWebhook,
  getCallLogs,
  getTelephonyAnalytics,
  updateCallDisposition,
  recordManualCallLog,
  updateOrganizationTelephonySettings,
  updateUserTelephonySettings,
  autoProvisionAgentExtension,
} from "../controllers/telephonyController.js";
import { protect } from "../middleware/authMiddleware.js";
import { requireTelephonyAddon } from "../middleware/telephonyMiddleware.js";

const router = express.Router();

// -------------------------------------------------------------
// Public Webhook Endpoints (TeleCMI Dispatches to these)
// -------------------------------------------------------------
router.post("/webhook/cdr", handleCDRWebhook);
router.post("/webhook/cdr/:orgId", handleCDRWebhook);

// -------------------------------------------------------------
// Authenticated Agent & Reporting Endpoints
// -------------------------------------------------------------
router.get("/agent-credentials", protect, getAgentCredentials);
router.get("/call-logs", protect, requireTelephonyAddon, getCallLogs);
router.get("/analytics", protect, requireTelephonyAddon, getTelephonyAnalytics);
router.post("/call-disposition", protect, requireTelephonyAddon, updateCallDisposition);
router.post("/manual-call-log", protect, recordManualCallLog);

// -------------------------------------------------------------
// Admin Settings Configuration Endpoints
// -------------------------------------------------------------
router.put(
  "/settings/organization",
  protect,
  requireTelephonyAddon,
  updateOrganizationTelephonySettings
);
router.put(
  "/settings/agent/:userId",
  protect,
  requireTelephonyAddon,
  updateUserTelephonySettings
);
router.post(
  "/settings/agent/:userId/auto-provision",
  protect,
  requireTelephonyAddon,
  autoProvisionAgentExtension
);

export default router;
