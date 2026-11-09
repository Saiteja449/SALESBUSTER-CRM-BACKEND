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
const eventAttachmentDir = path.resolve(process.cwd(), "uploads", "events");
fs.mkdirSync(voiceUploadDir, { recursive: true });
fs.mkdirSync(eventAttachmentDir, { recursive: true });
const eventAttachmentUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, eventAttachmentDir),
    filename: (_req, file, cb) => {
      const safeName = path.basename(file.originalname || "attachment").replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `event-${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeName}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
});
const voiceUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, voiceUploadDir),
    filename: (_req, file, cb) => cb(null, `guest-${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname || "") || ".wav"}`),
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
});

// All event routes are protected by user authentication
router.use(protect);

// 1. AI Real-Time Transcript & Card Vision
router.post("/summarize-text", summarizeTranscript);
router.post("/analyze-voice-audio", voiceUpload.single("audio"), analyzeVoiceAudio);
router.post("/scan-card", scanBusinessCard);

// 2. Event Management
router.get("/", getEvents);
router.post("/", eventAttachmentUpload.array("attachments", 10), createEvent);
router.get("/:id", getEventById);
router.put("/:id", updateEvent);
router.delete("/:id", deleteEvent);

// 3. Contacts under Event (Strictly isolated from CRM Leads)
router.get("/:id/contacts", getEventContacts);
router.post("/:id/contacts", createEventContact);
router.patch("/:id/contacts/:contactId/status", updateContactStatus);

export default router;

