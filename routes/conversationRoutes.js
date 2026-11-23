import express from "express";
import {
  getConversations,
  getConversationById,
  confirmContact,
} from "../controllers/conversationController.js";
import { protect, requireCrmAccount } from "../middleware/authMiddleware.js";
import validateRequest from "../middleware/validateRequest.js";
import {
  queryConversationsSchema,
  confirmContactSchema,
} from "../schemas/conversationSchemas.js";

const router = express.Router();

// All conversation routes require authentication and active CRM account
router.use(protect);
router.use(requireCrmAccount);

router.get("/", validateRequest(queryConversationsSchema), getConversations);
router.get("/:id", getConversationById);
router.post("/:id/confirm", validateRequest(confirmContactSchema), confirmContact);

export default router;

