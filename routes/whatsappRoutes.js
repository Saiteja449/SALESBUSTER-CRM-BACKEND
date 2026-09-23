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
  testAI,
  getTestAIHistory,
  summarizeConversation,
  getTeamWhatsAppStatuses,
} from "../controllers/whatsappController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

// Middleware to restrict administrative WhatsApp actions to managers, super admins, or owners
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

// All WhatsApp routes require authentication
router.use(protect);

// Settings & Controls (Mutations restricted to manager/admin)
router.get("/settings", getGlobalSettings);
router.post("/settings", requireManagerOrOwner, updateGlobalSettings);

// Session Control
router.post("/connect", connectClient);
router.get("/status", getStatus);
router.post("/logout", logoutClient);
router.get("/qr", getQR);

// Chats and Messages
router.get("/conversations", getConversations);
router.get("/conversation/:leadId", getMessages);
router.post("/message/send", sendMessage);

// AI Features
router.post("/conversation/:leadId/summarize", summarizeConversation);
router.get("/team-status", getTeamWhatsAppStatuses);

// AI Automation Toggle
router.post("/ai/toggle", toggleAI);

// Testing Route (Restricted to managers/admins)
router.post("/test-ai", requireManagerOrOwner, testAI);
router.get("/test-ai", requireManagerOrOwner, getTestAIHistory);

export default router;
