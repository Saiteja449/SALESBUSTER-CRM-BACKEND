import express from "express";
import {
  getFollowups,
  createFollowup,
  updateFollowup,
  getAIFollowups,
  handleAIFollowup,
} from "../controllers/followupController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

// All follow-up routes require authentication
router.use(protect);

// Specialized AI follow-up endpoints (must be defined before /:id)
router.get("/ai", getAIFollowups);
router.put("/ai/:id/handle", handleAIFollowup);

router.route("/").get(getFollowups).post(createFollowup);
router.route("/:id").put(updateFollowup);

export default router;
