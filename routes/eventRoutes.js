import express from "express";
import {
  summarizeTranscript,
  getEvents,
  createEvent,
  getEventById,
  getEventContacts,
  createEventContact,
  updateContactStatus,
} from "../controllers/eventController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

// All event routes are protected by user authentication
router.use(protect);

// 1. AI Real-Time Transcript Summarization
router.post("/summarize-text", summarizeTranscript);

// 2. Event Management
router.get("/", getEvents);
router.post("/", createEvent);
router.get("/:id", getEventById);

// 3. Contacts under Event (Strictly isolated from CRM Leads)
router.get("/:id/contacts", getEventContacts);
router.post("/:id/contacts", createEventContact);
router.patch("/:id/contacts/:contactId/status", updateContactStatus);

export default router;

