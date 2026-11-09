import express from "express";
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

// All event routes are protected by user authentication
router.use(protect);

// 1. AI Real-Time Transcript & Card Vision
router.post("/summarize-text", summarizeTranscript);
router.post("/scan-card", scanBusinessCard);

// 2. Event Management
router.get("/", getEvents);
router.post("/", createEvent);
router.get("/:id", getEventById);
router.put("/:id", updateEvent);
router.delete("/:id", deleteEvent);

// 3. Contacts under Event (Strictly isolated from CRM Leads)
router.get("/:id/contacts", getEventContacts);
router.post("/:id/contacts", createEventContact);
router.patch("/:id/contacts/:contactId/status", updateContactStatus);

export default router;

