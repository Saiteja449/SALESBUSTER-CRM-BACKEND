import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import {
  connectClient,
  getStatus,
  logoutClient,
  getQR,
  getConversations,
  getMessages,
  sendMessage,
  sendDocumentMessage,
  toggleAI,
  getGlobalSettings,
  updateGlobalSettings,
  toggleMyAIAutoReply,
  testAI,
  getTestAIHistory,
  summarizeConversation,
  getTeamWhatsAppStatuses,
  requestPairingCode,
} from "../controllers/whatsappController.js";
import { protect } from "../middleware/authMiddleware.js";
import { getMasterModels } from "../services/tenantManager.js";

const router = express.Router();

// Ensure uploads/documents directory exists
const docUploadDir = path.resolve(process.cwd(), "uploads", "documents");
if (!fs.existsSync(docUploadDir)) {
  fs.mkdirSync(docUploadDir, { recursive: true });
}

// Multer Storage Configuration for WhatsApp Documents (PDF / Word DOCX / DOC)
const docStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, docUploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `doc-${uniqueSuffix}${ext}`);
  },
});

// Strictly allow PDF and Word documents up to 25MB
const docFilter = (req, file, cb) => {
  const allowedExts = [".pdf", ".docx", ".doc"];
  const ext = path.extname(file.originalname || "").toLowerCase();
  const allowedMimes = [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
    "application/octet-stream",
  ];

  if (allowedExts.includes(ext) || allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Invalid file type. Only PDF and Word documents (.pdf, .docx, .doc) are permitted."));
  }
};

const documentMulter = multer({
  storage: docStorage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB limit
  fileFilter: docFilter,
});

// Middleware wrapper for document upload
const handleDocumentUpload = (req, res, next) => {
  documentMulter.fields([
    { name: "file", maxCount: 1 },
    { name: "document", maxCount: 1 },
  ])(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          success: false,
          message: "File too large. Maximum document size is 25 MB.",
        });
      }
      return res.status(400).json({
        success: false,
        message: err.message || "File upload error",
      });
    }

    // Normalize req.file from fields
    if (!req.file) {
      req.file = req.files?.file?.[0] || req.files?.document?.[0] || null;
    }
    next();
  });
};

// Dual-mode authentication: Allows either User JWT Bearer token OR Organization webhookKey / x-api-key
const authenticateUserOrWebhook = async (req, res, next) => {
  if (req.headers.authorization && req.headers.authorization.startsWith("Bearer")) {
    return protect(req, res, next);
  }

  const secretOrKey =
    req.headers["x-webhook-secret"] ||
    req.headers["x-api-key"] ||
    req.query?.secret ||
    req.query?.apiKey ||
    req.body?.secret ||
    req.body?.apiKey;

  if (secretOrKey) {
    try {
      const { Organization } = getMasterModels();
      const org = await Organization.findOne({ webhookKey: secretOrKey });
      if (org) {
        req.organization = org;
        const { getTenantModels } = await import("../services/tenantManager.js");
        req.tenantModels = await getTenantModels(org.tenantDbName);
        return next();
      }
    } catch (err) {
      console.error("[WhatsApp send-document Auth error]:", err);
    }
  }

  return res.status(401).json({
    success: false,
    message: "Unauthorized: Valid Bearer token, x-webhook-secret, or x-api-key required.",
  });
};

// Public/Webhook or User Authenticated: Send WhatsApp document with text/caption
router.post(
  "/send-document",
  authenticateUserOrWebhook,
  handleDocumentUpload,
  sendDocumentMessage
);
router.post(
  "/message/send-document",
  authenticateUserOrWebhook,
  handleDocumentUpload,
  sendDocumentMessage
);

// Middleware to restrict administrative WhatsApp actions to managers, super admins, or owners
const requireManagerOrOwner = (req, res, next) => {
  const role = (req.user?.role || "").toLowerCase().trim();
  if (
    role === "sales manager" ||
    role === "super_admin" ||
    role === "super admin" ||
    role === "admin" ||
    Boolean(req.user?.isOrgOwner)
  ) {
    return next();
  }
  return res.status(403).json({
    success: false,
    message: "Access forbidden: Manager or Administrator privileges required",
  });
};

// Standard authenticated routes
router.use(protect);

// Settings & Controls (Mutations restricted to manager/admin)
router.get("/settings", getGlobalSettings);
router.post("/settings", requireManagerOrOwner, updateGlobalSettings);
router.post("/my-ai-toggle", toggleMyAIAutoReply);

// Session Control
router.post("/connect", connectClient);
router.get("/status", getStatus);
router.post("/logout", logoutClient);
router.get("/qr", getQR);
router.post("/pairing-code", requestPairingCode);

// Chats and Messages
router.get("/conversations", getConversations);
router.get("/conversation/:leadId", getMessages);
router.post("/message/send", sendMessage);

// AI Features
router.post("/conversation/:leadId/summarize", summarizeConversation);
router.get("/team-status", requireManagerOrOwner, getTeamWhatsAppStatuses);

// AI Automation Toggle
router.post("/ai/toggle", toggleAI);

// Testing Route (Restricted to managers/admins)
router.post("/test-ai", requireManagerOrOwner, testAI);
router.get("/test-ai", requireManagerOrOwner, getTestAIHistory);

export default router;
