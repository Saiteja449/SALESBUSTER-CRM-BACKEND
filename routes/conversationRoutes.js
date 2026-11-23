import express from "express";
import {
  getConversations,
  getConversationById,
  confirmContact,
} from "../controllers/conversationController.js";
import { protect } from "../middleware/authMiddleware.js";
import validateRequest from "../middleware/validateRequest.js";
import {
  queryConversationsSchema,
  confirmContactSchema,
} from "../schemas/conversationSchemas.js";

const router = express.Router();

// All conversation routes require authentication (available to both CRM and Guest accounts)
router.use(protect);

router.get("/", validateRequest(queryConversationsSchema), getConversations);
router.get("/:id", getConversationById);
router.post("/:id/confirm", validateRequest(confirmContactSchema), confirmContact);

export default router;

