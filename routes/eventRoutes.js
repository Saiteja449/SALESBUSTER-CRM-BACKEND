import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
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
  analyzeVoiceAudio,
} from "../controllers/eventController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();
const voiceUploadDir = path.resolve(process.cwd(), "uploads", "voice");
fs.mkdirSync(voiceUploadDir, { recursive: true });
const voiceUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, voiceUploadDir),
    filename: (_req, file, cb) => cb(null, `guest-${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname || "") || ".wav"}`),
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
});

// Multer storage for event attachments (images, PDF, documents)
const eventUploadDir = path.resolve(process.cwd(), "uploads", "events");
if (!fs.existsSync(eventUploadDir)) {
  fs.mkdirSync(eventUploadDir, { recursive: true });
}
const eventFilesUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, eventUploadDir),
    filename: (_req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      let ext = path.extname(file.originalname || "") || "";
      if (!ext && file.mimetype) {
        if (file.mimetype.includes("png")) ext = ".png";
        else if (file.mimetype.includes("webp")) ext = ".webp";
        else if (file.mimetype.includes("jpeg") || file.mimetype.includes("jpg")) ext = ".jpg";
      }
      cb(null, `event-${uniqueSuffix}${ext}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const handleEventFilesUpload = (req, res, next) => {
  eventFilesUpload.any()(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({
          success: false,
          message: `File upload error: ${err.message}`,
        });
      }
      return res.status(400).json({
        success: false,
        message: err.message || "Failed to process uploaded files.",
      });
    }
    next();
  });
};

// All event routes are protected by user authentication
router.use(protect);

// 1. AI Real-Time Transcript & Card Vision
router.post("/summarize-text", summarizeTranscript);
router.post("/analyze-voice-audio", voiceUpload.single("audio"), analyzeVoiceAudio);
router.post("/scan-card", scanBusinessCard);

// 2. Event Management
router.get("/", getEvents);
router.post("/", handleEventFilesUpload, createEvent);
router.get("/:id", getEventById);
router.put("/:id", handleEventFilesUpload, updateEvent);
router.delete("/:id", deleteEvent);

// 3. Contacts under Event (Strictly isolated from CRM Leads)
router.get("/:id/contacts", getEventContacts);
router.post("/:id/contacts", createEventContact);
router.patch("/:id/contacts/:contactId/status", updateContactStatus);

export default router;

