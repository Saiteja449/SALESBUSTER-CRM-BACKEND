import express from "express";
import {
  getFollowups,
  createFollowup,
  updateFollowup,
} from "../controllers/followupController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

// All follow-up routes require authentication
router.use(protect);

router.route("/").get(getFollowups).post(createFollowup);
router.route("/:id").put(updateFollowup);

export default router;
