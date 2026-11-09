import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import multer from "multer";
import { fileURLToPath } from "url";
import {
  summarizeTranscript,
  scanBusinessCard,
  getEvents,
  createEvent,
  getEventById,
  updateEvent,
  deleteEvent,
  getEventContacts,
  createEventContact,
  updateContactStatus,
} from "../controllers/eventController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

const eventAttachmentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "uploads", "event-attachments");
fs.mkdirSync(eventAttachmentDir, { recursive: true });
const eventAttachmentUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, eventAttachmentDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase().replace(/[^.a-z0-9]/g, "");
      cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { files: 3, fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedExtensions = new Set([".pdf", ".doc", ".docx", ".ppt", ".pptx", ".jpg", ".jpeg", ".png", ".webp", ".gif"]);
    const allowed = new Set([
      "application/pdf", "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "image/jpeg", "image/png", "image/webp", "image/gif",
    ]);
    if (allowed.has(file.mimetype) || allowedExtensions.has(path.extname(file.originalname || "").toLowerCase())) return cb(null, true);
    cb(new Error("Event attachments must be PDF, Word, PowerPoint, or image files."));
  },
});

// All event routes are protected by user authentication
router.use(protect);

// 1. AI Real-Time Transcript & Card Vision
router.post("/summarize-text", summarizeTranscript);
router.post("/scan-card", scanBusinessCard);

// 2. Event Management
router.get("/", getEvents);
router.post("/", eventAttachmentUpload.array("attachments", 3), createEvent);
router.get("/:id", getEventById);
router.put("/:id", updateEvent);
router.delete("/:id", deleteEvent);

// 3. Contacts under Event (Strictly isolated from CRM Leads)
router.get("/:id/contacts", getEventContacts);
router.post("/:id/contacts", createEventContact);
router.patch("/:id/contacts/:contactId/status", updateContactStatus);

export default router;

