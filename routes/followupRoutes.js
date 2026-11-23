import express from "express";
import {
  getFollowups,
  createFollowup,
  updateFollowup,
  getAIFollowups,
  handleAIFollowup,
} from "../controllers/followupController.js";
import { protect, requireCrmAccount } from "../middleware/authMiddleware.js";
import validateRequest from "../middleware/validateRequest.js";
import {
  createFollowupSchema,
  updateFollowupSchema,
  queryFollowupsSchema,
} from "../schemas/followupSchemas.js";

const router = express.Router();

// All follow-up routes require authentication
router.use(protect);
router.use(requireCrmAccount);

// Specialized AI follow-up endpoints (must be defined before /:id)
router.get("/ai", getAIFollowups);
router.put("/ai/:id/handle", handleAIFollowup);

router
  .route("/")
  .get(validateRequest(queryFollowupsSchema), getFollowups)
  .post(validateRequest(createFollowupSchema), createFollowup);

router
  .route("/:id")
  .put(validateRequest(updateFollowupSchema), updateFollowup);

export default router;
