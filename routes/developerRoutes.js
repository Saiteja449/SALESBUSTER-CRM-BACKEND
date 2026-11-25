import express from "express";
import { verifySuperAdmin } from "../middleware/authMiddleware.js";
import {
  getDeveloperOverview,
  getApiLogs,
  clearApiLogs,
  getUserSessions,
  forceLogoutSession,
  forceLogoutPlatform,
  listDeveloperUsers,
  createDeveloperUser,
  toggleDeveloperUserStatus,
} from "../controllers/developerController.js";

const router = express.Router();

// All developer routes require elevated super_admin or developer role
router.use(verifySuperAdmin);

router.get("/overview", getDeveloperOverview);
router.get("/logs", getApiLogs);
router.delete("/logs", clearApiLogs);
router.get("/sessions", getUserSessions);
router.post("/sessions/force-logout-platform", forceLogoutPlatform);
router.post("/sessions/:sessionId/force-logout", forceLogoutSession);
router.get("/users", listDeveloperUsers);
router.post("/users", createDeveloperUser);
router.patch("/users/:id/status", toggleDeveloperUserStatus);

export default router;
