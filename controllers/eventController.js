import fs from "fs";
import asyncHandler from "../utils/asyncHandler.js";
import { getTenantScope } from "../utils/tenantScope.js";
import { sendSuccess } from "../utils/responseHandler.js";
import { getMasterModels } from "../services/tenantManager.js";
import { decryptApiKey } from "../utils/encryption.js";
import { extractProspectDetailsFromVoice } from "../services/voiceProspectExtractionService.js";
import { extractBusinessCardData } from "../services/ai/cardVisionExtractionService.js";
import { extractSpeakerAwareContactDeterministically } from "../services/ai/contactExtractionService.js";
import {
  queryEventsService,
  createEventService,
  getEventByIdService,
  updateEventService,
  deleteEventService,
  queryEventContactsService,
  createEventContactService,
  updateEventContactStatusService,
  updateEventContactService,
  deleteEventContactService,
} from "../services/eventService.js";

/**
 * Voice Audio Analysis for Prospect Capture
 * @route POST /api/events/analyze-voice-audio
 */
export const analyzeVoiceAudio = asyncHandler(async (req, res) => {
  const audioFile = req.file;
  const requestId = `guest-voice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const startedAt = Date.now();

  try {
    if (!audioFile) {
      return res.status(400).json({ success: false, message: "Audio recording file is required." });
    }

    const { Organization } = getMasterModels();
    const orgId = req.user?.organizationId?.toString() || req.organization?._id?.toString();
    const organization = orgId ? await Organization.findById(orgId).lean() : null;
    const apiKey = decryptApiKey(organization?.aiSettings?.geminiApiKey) || process.env.GEMINI_API_KEY;

    console.info(`[CONTACT_CAPTURE][${requestId}] Audio received`, {
      organizationId: orgId,
      sizeBytes: audioFile.size,
      mimeType: audioFile.mimetype,
    });

    const details = await extractProspectDetailsFromVoice(audioFile.path, audioFile.mimetype, apiKey, requestId);
    console.info(`[CONTACT_CAPTURE][${requestId}] Audio analyzed`, { durationMs: Date.now() - startedAt });

    const name = details.customerName === "Valued Customer" ? "" : details.customerName;
    return sendSuccess(res, {
      data: {
        name,
        customerName: name,
        phone: details.spokenPhone || "",
        companyName: details.companyName || "",
        designation: details.designation || "",
        summary: details.keyTopic || "",
      },
    });
  } catch (error) {
    console.error(`[CONTACT_CAPTURE][${requestId}] Audio analysis failed`, {
      durationMs: Date.now() - startedAt,
      error: error.message,
    });
    return res.status(422).json({ success: false, message: error.message || "Failed to analyze voice recording." });
  } finally {
    if (audioFile?.path && fs.existsSync(audioFile.path)) {
      try {
        fs.unlinkSync(audioFile.path);
      } catch (error) {
        console.warn(`[CONTACT_CAPTURE][${requestId}] Upload cleanup failed`, { error: error.message });
      }
    }
  }
});

/**
 * Scan Business Card Photo using Gemini Multimodal Vision
 * @route POST /api/events/scan-card
 */
export const scanBusinessCard = asyncHandler(async (req, res) => {
  const { imageBase64, mimeType } = req.body;
  const { Organization } = getMasterModels();
  const orgId = req.user?.organizationId
    ? req.user.organizationId.toString()
    : req.organization?._id?.toString();

  const organization = orgId ? await Organization.findById(orgId).lean() : null;
  const activeKey = decryptApiKey(organization?.aiSettings?.geminiApiKey) || process.env.GEMINI_API_KEY;

  const extracted = await extractBusinessCardData({
    imageBase64,
    mimeType: mimeType || "image/jpeg",
    geminiApiKey: activeKey,
  });

  return sendSuccess(res, {
    data: extracted,
    message: "Business card analyzed successfully.",
  });
});

/**
 * Summarize speech transcript deterministically
 * @route POST /api/events/summarize-text
 */
export const summarizeTranscript = asyncHandler(async (req, res) => {
  const { transcript, eventName } = req.body;
  const senderName = req.user?.name || "Sales Manager";
  const orgName = req.organization?.name || req.user?.organizationName || "Our Team";
  const repPhone = (req.user?.phone || "").replace(/\D/g, "").slice(-10);
  const currentEvent = eventName || "our discussion";

  const extractedContact = extractSpeakerAwareContactDeterministically({
    segments: [{ speakerId: "attendee", text: transcript.trim() }],
    rawTranscript: transcript.trim(),
    hostUser: { name: senderName, phone: repPhone, organizationName: orgName },
    organization: req.organization || { name: orgName },
  });

  const customerName = extractedContact.contact?.name?.value || "";
  const cleanPhone = extractedContact.contact?.phone?.value || "";
  const companyName = extractedContact.contact?.company?.value || "";
  const designation = extractedContact.contact?.designation?.value || "";
  const summary = extractedContact.summary || transcript.trim().slice(0, 1000);

  const greetingName = customerName || "there";
  const defaultMessage =
    `Hello ${greetingName},\n\n` +
    `It was great speaking with you regarding ${companyName || "our discussion"} at ${currentEvent}.\n` +
    `Feel free to reach out to me directly on WhatsApp whenever you need any assistance!\n\n` +
    `Best regards,\n` +
    `*${senderName}*\n` +
    `${orgName}`;

  return sendSuccess(res, {
    data: {
      name: customerName,
      customerName,
      phone: cleanPhone,
      spokenPhone: cleanPhone,
      companyName,
      designation,
      summary,
      messageText: defaultMessage,
      originalTranscript: transcript,
    },
  });
});

/**
 * Get all events with contact stats
 * @route GET /api/events
 */
export const getEvents = asyncHandler(async (req, res) => {
  const { tenantModels } = getTenantScope(req);
  const events = await queryEventsService({
    tenantModels,
    status: req.query.status,
  });

  return sendSuccess(res, { data: events });
});

/**
 * Create a new event
 * @route POST /api/events
 */
export const createEvent = asyncHandler(async (req, res) => {
  const { tenantModels, organizationId } = getTenantScope(req);
  const newEvent = await createEventService({
    tenantModels,
    data: req.body,
    files: req.files,
    user: req.user,
    organizationId,
  });

  return sendSuccess(res, {
    statusCode: 201,
    data: newEvent,
    message: "Event created successfully.",
  });
});

/**
 * Get a single event by ID
 * @route GET /api/events/:id
 */
export const getEventById = asyncHandler(async (req, res) => {
  const { tenantModels } = getTenantScope(req);
  const event = await getEventByIdService({
    tenantModels,
    eventId: req.params.id,
  });

  return sendSuccess(res, { data: event });
});

/**
 * Update an existing event
 * @route PUT /api/events/:id
 */
export const updateEvent = asyncHandler(async (req, res) => {
  const { tenantModels } = getTenantScope(req);
  const updatedEvent = await updateEventService({
    tenantModels,
    eventId: req.params.id,
    data: req.body,
    files: req.files,
  });

  return sendSuccess(res, {
    data: updatedEvent,
    message: "Event updated successfully.",
  });
});

/**
 * Delete an event and its contacts
 * @route DELETE /api/events/:id
 */
export const deleteEvent = asyncHandler(async (req, res) => {
  const { tenantModels } = getTenantScope(req);
  const result = await deleteEventService({
    tenantModels,
    eventId: req.params.id,
  });

  return sendSuccess(res, {
    data: result,
    message: "Event and associated contacts deleted successfully.",
  });
});

/**
 * List contacts under an event
 * @route GET /api/events/:id/contacts
 */
export const getEventContacts = asyncHandler(async (req, res) => {
  const { tenantModels } = getTenantScope(req);
  const contacts = await queryEventContactsService({
    tenantModels,
    eventId: req.params.id,
    search: req.query.search,
    status: req.query.status,
  });

  return sendSuccess(res, { data: contacts });
});

/**
 * Create an event contact
 * @route POST /api/events/:id/contacts
 */
export const createEventContact = asyncHandler(async (req, res) => {
  const { tenantModels } = getTenantScope(req);
  const contact = await createEventContactService({
    tenantModels,
    eventId: req.params.id,
    data: req.body,
    user: req.user,
  });

  return sendSuccess(res, {
    statusCode: 201,
    data: contact,
    message: "Event contact created successfully.",
  });
});

/**
 * Update event contact status
 * @route PATCH /api/events/:id/contacts/:contactId/status
 */
export const updateContactStatus = asyncHandler(async (req, res) => {
  const { tenantModels } = getTenantScope(req);
  const contact = await updateEventContactStatusService({
    tenantModels,
    eventId: req.params.id,
    contactId: req.params.contactId,
    status: req.body.status,
  });

  return sendSuccess(res, {
    data: contact,
    message: "Event contact status updated successfully.",
  });
});

/**
 * Update event contact details
 * @route PUT /api/events/:id/contacts/:contactId
 */
export const updateEventContact = asyncHandler(async (req, res) => {
  const { tenantModels } = getTenantScope(req);
  const contact = await updateEventContactService({
    tenantModels,
    eventId: req.params.id,
    contactId: req.params.contactId,
    data: req.body,
  });

  return sendSuccess(res, {
    data: contact,
    message: "Event contact details updated successfully.",
  });
});

/**
 * Delete an event contact
 * @route DELETE /api/events/:id/contacts/:contactId
 */
export const deleteEventContact = asyncHandler(async (req, res) => {
  const { tenantModels } = getTenantScope(req);
  const result = await deleteEventContactService({
    tenantModels,
    eventId: req.params.id,
    contactId: req.params.contactId,
  });

  return sendSuccess(res, {
    data: result,
    message: "Event contact deleted successfully.",
  });
});

export default {
  analyzeVoiceAudio,
  scanBusinessCard,
  summarizeTranscript,
  getEvents,
  createEvent,
  getEventById,
  updateEvent,
  deleteEvent,
  getEventContacts,
  createEventContact,
  updateContactStatus,
  updateEventContact,
  deleteEventContact,
};
