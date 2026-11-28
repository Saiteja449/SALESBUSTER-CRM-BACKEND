import express from "express";
import { protect, requireCrmAccount, verifySuperAdmin } from "../middleware/authMiddleware.js";
import validateRequest from "../middleware/validateRequest.js";
import {
  createCashfreeOrderSchema,
  queryOrdersSchema,
  addonQuoteSchema,
} from "../schemas/cashfreeSchemas.js";
import {
  createOrderHandler,
  getOrderStatusHandler,
  handleCashfreeWebhook,
  getOrderHistoryHandler,
  getAdminOrdersHandler,
  devSimulateSuccessHandler,
  getPublicPricingConfigHandler,
  getAdminPricingSettingsHandler,
  updatePricingSettingsHandler,
  createAdminAddonHandler,
  updateAdminAddonHandler,
  deleteAdminAddonHandler,
  createAdminPlanHandler,
  updateAdminPlanHandler,
  deleteAdminPlanHandler,
  getAddonQuoteHandler,
  downloadInvoiceHandler,
  resendInvoiceHandler,
} from "../controllers/cashfreeController.js";
import {
  startFreeTrialHandler,
} from "../controllers/trialAutopayController.js";

const router = express.Router();

// 1. Order Creation (Auth required)
router.post(
  "/create-order",
  protect,
  requireCrmAccount,
  validateRequest(createCashfreeOrderSchema),
  createOrderHandler
);

router.post("/addon-quote", protect, requireCrmAccount, validateRequest(addonQuoteSchema), getAddonQuoteHandler);

// 1b. Public Website Order Creation (No auth required for marketing web checkout)
router.post(
  "/public/create-order",
  validateRequest(createCashfreeOrderSchema),
  createOrderHandler
);

// 1c. Dev simulation endpoint (Testing only)
router.post("/public/dev-simulate-success", devSimulateSuccessHandler);

// 1d. Pricing & GST Config (Public for web checkout)
router.get("/public/pricing-config", getPublicPricingConfigHandler);

// 1e. Admin Pricing, GST & Addon Catalog Configuration (Super Admin / Developer only)
router.get("/admin/pricing-settings", verifySuperAdmin, getAdminPricingSettingsHandler);
router.put("/admin/pricing-settings", verifySuperAdmin, updatePricingSettingsHandler);
router.post("/admin/addons", verifySuperAdmin, createAdminAddonHandler);
router.put("/admin/addons/:addonId", verifySuperAdmin, updateAdminAddonHandler);
router.delete("/admin/addons/:addonId", verifySuperAdmin, deleteAdminAddonHandler);
router.post("/admin/plans", verifySuperAdmin, createAdminPlanHandler);
router.put("/admin/plans/:planId", verifySuperAdmin, updateAdminPlanHandler);
router.delete("/admin/plans/:planId", verifySuperAdmin, deleteAdminPlanHandler);

// 2. Fetch / Verify Order Status & Download Tax Invoice
router.get("/order/:orderId", protect, getOrderStatusHandler);
router.get("/public/order/:orderId", getOrderStatusHandler);
router.get("/order/:orderId/invoice", protect, downloadInvoiceHandler);
router.get("/public/order/:orderId/invoice", downloadInvoiceHandler);
router.post("/admin/orders/:orderId/resend-invoice", protect, requireCrmAccount, resendInvoiceHandler);

// 3. Webhook Ingestion (Public S2S callback, verified via HMAC-SHA256 signature)
router.post("/webhook", handleCashfreeWebhook);

// 3b. 3-Day Free Trial
router.post("/trial/start", protect, startFreeTrialHandler);

// 4. Payment History for Tenant Organization (Auth required)
router.get("/history", protect, requireCrmAccount, getOrderHistoryHandler);
router.get("/orders", protect, requireCrmAccount, getOrderHistoryHandler);

// 5. Admin & Management View across orders and metrics (Auth required)
router.get(
  "/admin/orders",
  protect,
  requireCrmAccount,
  validateRequest(queryOrdersSchema),
  getAdminOrdersHandler
);

export default router;
