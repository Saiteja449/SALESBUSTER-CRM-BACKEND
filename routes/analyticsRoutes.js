import express from "express";
import {
  logCall,
  getAnalyticsBySalesperson,
  getTodayAnalyticsForAll,
  getAILimits,
  refreshAILimits,
} from "../controllers/analyticsController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

// All analytics routes require authentication
router.use(protect);

router.post("/log-call", logCall);
router.get("/today", getTodayAnalyticsForAll);
router.get("/ai-limits", getAILimits);
router.post("/ai-limits/refresh", refreshAILimits);
router.get("/:salesperson", getAnalyticsBySalesperson);

export default router;
