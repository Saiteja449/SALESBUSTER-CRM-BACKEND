import express from "express";
import {
  verifyWhatsAppWebhook,
  receiveWhatsAppWebhook,
} from "../controllers/whatsappWebhookController.js";

const router = express.Router();

// Public routes for Meta Webhook verification & events
router.get("/", verifyWhatsAppWebhook);
router.get("/:orgId", verifyWhatsAppWebhook);

router.post("/", receiveWhatsAppWebhook);
router.post("/:orgId", receiveWhatsAppWebhook);

export default router;
