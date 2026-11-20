import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import {
  createOrderHandler,
  getOrderStatusHandler,
  handleCashfreeWebhook,
  getOrderHistoryHandler,
} from "../controllers/cashfreeController.js";

const router = express.Router();

// 1. Order Creation (Auth required)
router.post("/create-order", protect, createOrderHandler);

// 2. Fetch / Verify Order Status (Auth required)
router.get("/order/:orderId", protect, getOrderStatusHandler);

// 3. Webhook Ingestion (Public S2S callback, verified via HMAC-SHA256 signature)
router.post("/webhook", handleCashfreeWebhook);

// 4. Payment History (Auth required)
router.get("/history", protect, getOrderHistoryHandler);
router.get("/orders", protect, getOrderHistoryHandler);

export default router;
