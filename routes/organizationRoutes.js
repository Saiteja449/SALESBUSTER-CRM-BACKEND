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
  validateGeminiApiKey,
  uploadKnowledgeDoc,
  deleteKnowledgeDoc,
  getOrgAISettings,
  updateOrgAISettings,
  uploadOrgKnowledgeDoc,
  deleteOrgKnowledgeDoc,
} from "../controllers/organizationController.js";
import { protect, verifySuperAdmin } from "../middleware/authMiddleware.js";

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

// Organization Owner Profile (Read-only view for current tenant owner)
router.get("/my-org", protect, getMyOrganization);

// Tenant AI Settings & Knowledge Base (Tenant Owner / Sales Manager)
router.get("/my-org/ai-settings", protect, getMyAISettings);
router.put("/my-org/ai-settings", protect, updateMyAISettings);
router.post("/my-org/validate-gemini-key", protect, validateGeminiApiKey);
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
// Provisioning an organization with super admin token verification
router.post("/", verifySuperAdmin, provisionOrganization);
router.post("/provision", verifySuperAdmin, provisionOrganization);
router.get("/", verifySuperAdmin, getOrganizations);
router.get("/:id", verifySuperAdmin, getOrganizationById);
router.put("/:id/seats", verifySuperAdmin, updateOrganizationSeats);
router.put("/:id/renew", verifySuperAdmin, renewSubscription);
router.patch("/:id/status", verifySuperAdmin, toggleStatus);
router.post("/:id/resend-welcome", verifySuperAdmin, resendWelcomeEmail);

// Super Admin AI Settings & Knowledge Base APIs
router.get("/:id/ai-settings", verifySuperAdmin, getOrgAISettings);
router.put("/:id/ai-settings", verifySuperAdmin, updateOrgAISettings);
router.post(
  "/:id/knowledge-base/upload",
  verifySuperAdmin,
  upload.single("file"),
  uploadOrgKnowledgeDoc,
);
router.delete(
  "/:id/knowledge-base/:docId",
  verifySuperAdmin,
  deleteOrgKnowledgeDoc,
);

export default router;
