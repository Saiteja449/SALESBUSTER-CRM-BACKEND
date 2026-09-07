import express from "express";
import {
  provisionOrganization,
  getOrganizations,
  getOrganizationById,
  updateOrganizationSeats,
  renewSubscription,
  toggleStatus,
  resendWelcomeEmail,
  getMyOrganization,
} from "../controllers/organizationController.js";
import { protect } from "../middleware/authMiddleware.js";
import { requireSuperAdmin } from "../middleware/tenantMiddleware.js";

const router = express.Router();

// Helper middleware: allow if valid super_admin token OR valid x-admin-key header
const superAdminAuth = (req, res, next) => {
  // If x-admin-key is supplied and matches
  const adminKey = req.headers["x-admin-key"];
  const validKey =
    process.env.ADMIN_API_KEY || "salesbuster_super_admin_secret_key_2026";
  if (adminKey && adminKey === validKey) {
    return next();
  }

  // Otherwise fallback to JWT protect and requireSuperAdmin
  protect(req, res, () => {
    requireSuperAdmin(req, res, next);
  });
};

// Organization Owner Profile (Read-only view for current tenant owner)
router.get("/my-org", protect, getMyOrganization);

// Super Admin APIs (For separate Admin Project)
router.post("/provision", superAdminAuth, provisionOrganization);
router.get("/", superAdminAuth, getOrganizations);
router.get("/:id", superAdminAuth, getOrganizationById);
router.put("/:id/seats", superAdminAuth, updateOrganizationSeats);
router.put("/:id/renew", superAdminAuth, renewSubscription);
router.patch("/:id/status", superAdminAuth, toggleStatus);
router.post("/:id/resend-welcome", superAdminAuth, resendWelcomeEmail);

export default router;
