import express from "express";
import {
  connectClient,
  getStatus,
  logoutClient,
  getQR,
  getConversations,
  getMessages,
  sendMessage,
  toggleAI,
  getGlobalSettings,
  updateGlobalSettings,
} from "../controllers/whatsappController.js";

const router = express.Router();

// Settings & Controls
router.get("/settings", getGlobalSettings);
router.post("/settings", updateGlobalSettings);

// Session Control
router.post("/connect", connectClient);
router.get("/status", getStatus);
router.post("/logout", logoutClient);
router.get("/qr", getQR);

// Chats and Messages
router.get("/conversations", getConversations);
router.get("/conversation/:leadId", getMessages);
router.post("/message/send", sendMessage);

// AI Automation
router.post("/ai/toggle", toggleAI);

// Testing Route
import { testAI, getTestAIHistory } from "../controllers/whatsappController.js";
router.post("/test-ai", testAI);
router.get("/test-ai", getTestAIHistory);

export default router;
