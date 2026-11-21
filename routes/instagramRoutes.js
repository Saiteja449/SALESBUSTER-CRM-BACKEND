import express from "express";
import {
  verifyInstagramWebhook,
  handleInstagramWebhook,
  onboardInstagramAccount,
  getInstagramStatus,
  disconnectInstagramAccount,
  resubscribeInstagramWebhooks,
  syncInstagramCommentsHandler,
  getAutomationRules,
  createAutomationRule,
  updateAutomationRule,
  deleteAutomationRule,
  getInstagramConversations,
  getInstagramMessages,
  sendInstagramAgentMessage,
} from "../controllers/instagramController.js";
import { protect, requireCrmAccount } from "../middleware/authMiddleware.js";

const router = express.Router();

// Public Webhook endpoints for Meta
router.get("/webhook", verifyInstagramWebhook);
router.post("/webhook", handleInstagramWebhook);

// Protected Account & Status endpoints
router.post("/onboard", protect, requireCrmAccount, onboardInstagramAccount);
router.get("/status", protect, requireCrmAccount, getInstagramStatus);
router.post("/disconnect", protect, requireCrmAccount, disconnectInstagramAccount);
router.post("/subscribe-webhooks", protect, requireCrmAccount, resubscribeInstagramWebhooks);
router.post("/sync-comments", protect, requireCrmAccount, syncInstagramCommentsHandler);

// Protected Automation Rules CRUD
router.get("/rules", protect, requireCrmAccount, getAutomationRules);
router.post("/rules", protect, requireCrmAccount, createAutomationRule);
router.put("/rules/:id", protect, requireCrmAccount, updateAutomationRule);
router.delete("/rules/:id", protect, requireCrmAccount, deleteAutomationRule);

// Protected Unified Inbox Conversation & Message endpoints
router.get("/conversations", protect, requireCrmAccount, getInstagramConversations);
router.get("/conversation/:contactId/messages", protect, requireCrmAccount, getInstagramMessages);
router.post("/message/send", protect, requireCrmAccount, sendInstagramAgentMessage);

export default router;
