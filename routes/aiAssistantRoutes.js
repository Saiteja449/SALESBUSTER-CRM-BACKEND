import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import {
  sendMessage,
  getChatSessions,
  getChatSessionById,
  deleteChatSession,
  clearAllChatSessions,
} from "../controllers/aiAssistantController.js";

import { requireAddon } from "../middleware/addonMiddleware.js";

const router = express.Router();

/**
 * Middleware: Restricts AI CRM Assistant strictly to Sales Managers, Org Owners, and Super Admins
 */
export const requireSalesManager = (req, res, next) => {
  const role = String(req.user?.role || "").toLowerCase().trim();
  const isManager =
    role === "sales manager" ||
    role === "super_admin" ||
    Boolean(req.user?.isOrgOwner);

  if (!isManager) {
    return res.status(403).json({
      success: false,
      message: "Access forbidden: AI CRM Assistant is restricted to Sales Manager role.",
    });
  }

  next();
};

// All assistant routes require authentication, Sales Manager role, and the biAnalyst add-on
router.use(protect);
router.use(requireSalesManager);
router.use(requireAddon("biAnalyst"));

// Chat & History Endpoints
router.post("/chat", sendMessage);
router.get("/sessions", getChatSessions);
router.get("/sessions/:chatId", getChatSessionById);
router.delete("/sessions/:chatId", deleteChatSession);
router.delete("/sessions", clearAllChatSessions);

export default router;
