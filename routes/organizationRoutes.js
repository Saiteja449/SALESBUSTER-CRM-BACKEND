import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import {
  provisionOrganization,
  getOrganizations,
  getOrganizationById,
  updateOrganizationSeats,
  renewSubscription,
  toggleStatus,
  resendWelcomeEmail,
  getMyOrganization,
  getMyAISettings,
  updateMyAISettings,
  uploadKnowledgeDoc,
  deleteKnowledgeDoc,
  getOrgAISettings,
  updateOrgAISettings,
  uploadOrgKnowledgeDoc,
  deleteOrgKnowledgeDoc,
} from "../controllers/organizationController.js";
import { protect } from "../middleware/authMiddleware.js";
import { requireSuperAdmin } from "../middleware/tenantMiddleware.js";

const router = express.Router();

// Multer storage for knowledge base document uploads
const uploadDir = "uploads/knowledge/";
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const sanitized = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    cb(null, `${Date.now()}-${sanitized}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
});

// Helper middleware: allow if valid super_admin token OR valid x-admin-key header
const superAdminAuth = (req, res, next) => {
  const adminKey = req.headers["x-admin-key"];
  const validKey =
    process.env.ADMIN_API_KEY || "salesbuster_super_admin_secret_key_2026";
  if (adminKey && adminKey === validKey) {
    return next();
  }

  protect(req, res, () => {
    requireSuperAdmin(req, res, next);
  });
};

// Organization Owner Profile (Read-only view for current tenant owner)
router.get("/my-org", protect, getMyOrganization);

// Tenant AI Settings & Knowledge Base (Tenant Owner / Sales Manager)
router.get("/my-org/ai-settings", protect, getMyAISettings);
router.put("/my-org/ai-settings", protect, updateMyAISettings);
router.post(
  "/my-org/knowledge-base/upload",
  protect,
  upload.single("file"),
  uploadKnowledgeDoc,
);
router.delete(
  "/my-org/knowledge-base/:docId",
  protect,
  deleteKnowledgeDoc,
);

// Super Admin APIs (For Super Admin Portal)
router.post("/provision", superAdminAuth, provisionOrganization);
router.get("/", superAdminAuth, getOrganizations);
router.get("/:id", superAdminAuth, getOrganizationById);
router.put("/:id/seats", superAdminAuth, updateOrganizationSeats);
router.put("/:id/renew", superAdminAuth, renewSubscription);
router.patch("/:id/status", superAdminAuth, toggleStatus);
router.post("/:id/resend-welcome", superAdminAuth, resendWelcomeEmail);

// Super Admin AI Settings & Knowledge Base APIs
router.get("/:id/ai-settings", superAdminAuth, getOrgAISettings);
router.put("/:id/ai-settings", superAdminAuth, updateOrgAISettings);
router.post(
  "/:id/knowledge-base/upload",
  superAdminAuth,
  upload.single("file"),
  uploadOrgKnowledgeDoc,
);
router.delete(
  "/:id/knowledge-base/:docId",
  superAdminAuth,
  deleteOrgKnowledgeDoc,
);

export default router;
