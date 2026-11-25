import express from "express";
import { protect, requireCrmAccount } from "../middleware/authMiddleware.js";
import validateRequest from "../middleware/validateRequest.js";
import {
  createCashfreeOrderSchema,
  queryOrdersSchema,
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
  downloadInvoiceHandler,
  resendInvoiceHandler,
} from "../controllers/cashfreeController.js";

const router = express.Router();

// 1. Order Creation (Auth required)
router.post(
  "/create-order",
  protect,
  requireCrmAccount,
  validateRequest(createCashfreeOrderSchema),
  createOrderHandler
);

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

// 1e. Admin Pricing, GST & Addon Catalog Configuration (Auth required)
router.get("/admin/pricing-settings", protect, requireCrmAccount, getAdminPricingSettingsHandler);
router.put("/admin/pricing-settings", protect, requireCrmAccount, updatePricingSettingsHandler);
router.post("/admin/addons", protect, requireCrmAccount, createAdminAddonHandler);
router.put("/admin/addons/:addonId", protect, requireCrmAccount, updateAdminAddonHandler);
router.delete("/admin/addons/:addonId", protect, requireCrmAccount, deleteAdminAddonHandler);

// 2. Fetch / Verify Order Status & Download Tax Invoice
router.get("/order/:orderId", protect, getOrderStatusHandler);
router.get("/public/order/:orderId", getOrderStatusHandler);
router.get("/order/:orderId/invoice", protect, downloadInvoiceHandler);
router.get("/public/order/:orderId/invoice", downloadInvoiceHandler);
router.post("/admin/orders/:orderId/resend-invoice", protect, requireCrmAccount, resendInvoiceHandler);

// 3. Webhook Ingestion (Public S2S callback, verified via HMAC-SHA256 signature)
router.post("/webhook", handleCashfreeWebhook);

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
