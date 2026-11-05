import express from "express";
import {
  getConversations,
  getConversationById,
  confirmContact,
} from "../controllers/conversationController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

// All conversation routes require authentication
router.use(protect);

router.get("/", getConversations);
router.get("/:id", getConversationById);
router.post("/:id/confirm", confirmContact);

export default router;

