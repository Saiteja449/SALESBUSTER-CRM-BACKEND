import { extractSpeakerAwareContactDeterministically } from "../services/ai/contactExtractionService.js";
import { extractBusinessCardData } from "../services/ai/cardVisionExtractionService.js";
import { getMasterModels } from "../services/tenantManager.js";
import { decryptApiKey } from "../utils/encryption.js";
import fs from "fs";
import path from "path";
import { extractProspectDetailsFromVoice } from "../services/voiceProspectExtractionService.js";

export const analyzeVoiceAudio = async (req, res) => {
  const audioFile = req.file;
  const requestId = `guest-voice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const startedAt = Date.now();
  try {
    if (!audioFile) return res.status(400).json({ success: false, message: "Audio recording file is required." });
    const { Organization } = getMasterModels();
    const orgId = req.user?.organizationId?.toString() || req.organization?._id?.toString();
    const organization = orgId ? await Organization.findById(orgId).lean() : null;
    const apiKey = decryptApiKey(organization?.aiSettings?.geminiApiKey) || process.env.GEMINI_API_KEY;
    console.info(`[CONTACT_CAPTURE][${requestId}] Audio received`, { organizationId: orgId, sizeBytes: audioFile.size, mimeType: audioFile.mimetype });
    const details = await extractProspectDetailsFromVoice(audioFile.path, audioFile.mimetype, apiKey, requestId);
    console.info(`[CONTACT_CAPTURE][${requestId}] Audio analyzed`, { durationMs: Date.now() - startedAt });
    const name = details.customerName === "Valued Customer" ? "" : details.customerName;
    return res.json({ success: true, data: {
      name, customerName: name, phone: details.spokenPhone || "",
      companyName: details.companyName || "", designation: details.designation || "",
      summary: details.keyTopic || "",
    }});
  } catch (error) {
    console.error(`[CONTACT_CAPTURE][${requestId}] Audio analysis failed`, { durationMs: Date.now() - startedAt, error: error.message });
    return res.status(422).json({ success: false, message: error.message || "Failed to analyze voice recording." });
  } finally {
    if (audioFile?.path && fs.existsSync(audioFile.path)) {
      try { fs.unlinkSync(audioFile.path); } catch (error) { console.warn(`[CONTACT_CAPTURE][${requestId}] Upload cleanup failed`, { error: error.message }); }
    }
  }
};

/**
 * Analyze business / visiting card photo using Gemini Multimodal Vision (gemini-3.5-flash-lite)
 * @route POST /api/events/scan-card
 */
export const scanBusinessCard = async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body;

    if (!imageBase64 || typeof imageBase64 !== "string" || !imageBase64.trim()) {
      return res.status(400).json({
        success: false,
        message: "Image base64 data is required to scan business card.",
      });
    }

    const { Organization } = getMasterModels();
    const orgId = req.user?.organizationId
      ? req.user.organizationId.toString()
      : req.organization?._id?.toString();

    const organization = orgId ? await Organization.findById(orgId).lean() : null;
    const activeKey =
      decryptApiKey(organization?.aiSettings?.geminiApiKey) ||
      process.env.GEMINI_API_KEY;

    const extracted = await extractBusinessCardData({
      imageBase64,
      mimeType: mimeType || "image/jpeg",
      geminiApiKey: activeKey,
    });

    return res.status(200).json({
      success: true,
      data: extracted,
      message: "Business card analyzed successfully.",
    });
  } catch (err) {
    console.error("[EventController] Error scanning business card:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to analyze business card image.",
    });
  }
};

/**
 * Return a deterministic transcript parse. Live voice capture is the sole AI model
 * path; this compatibility endpoint must not start a second post-capture model call.
 * @route POST /api/events/summarize-text
 */
export const summarizeTranscript = async (req, res) => {
  try {
    const { transcript, eventName } = req.body;

    if (!transcript || typeof transcript !== "string" || !transcript.trim()) {
      return res.status(400).json({
        success: false,
        message: "Speech transcript text is required.",
      });
    }

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

    return res.status(200).json({
      success: true,
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
  } catch (err) {
    console.error("[EventController] Error summarizing transcript:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to analyze speech transcript.",
    });
  }
};

/**
 * Get all events for the current organization
 * @route GET /api/events
 */
export const getEvents = async (req, res) => {
  try {
    const { Event, EventContact } = req.tenantModels;
    if (!Event) {
      return res.status(500).json({ success: false, message: "Event model unavailable." });
    }

    const { status } = req.query;
    const filter = {};
    if (status && status !== "all") {
      filter.status = status;
    }

    const events = await Event.find(filter).sort({ createdAt: -1, _id: -1 }).lean();
    const eventIds = events.map((event) => event._id);
    const contactCounts = eventIds.length
      ? await EventContact.aggregate([
          { $match: { eventId: { $in: eventIds } } },
          {
            $group: {
              _id: "$eventId",
              totalCaptured: { $sum: 1 },
              whatsappSentCount: {
                $sum: {
                  $cond: [{ $in: ["$status", ["whatsapp_opened", "completed"]] }, 1, 0],
                },
              },
            },
          },
        ])
      : [];
    const countsByEventId = new Map(contactCounts.map((row) => [String(row._id), row]));
    const eventsWithCounts = events.map((event) => {
      const counts = countsByEventId.get(String(event._id));
      return {
        ...event,
        stats: {
          totalCaptured: counts?.totalCaptured || 0,
          whatsappSentCount: counts?.whatsappSentCount || 0,
        },
      };
    });

    return res.status(200).json({
      success: true,
      data: eventsWithCounts,
    });
  } catch (err) {
    console.error("[EventController] getEvents error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to fetch events.",
    });
  }
};

/**
 * Create a new event
 * @route POST /api/events
 */
export const createEvent = async (req, res) => {
  try {
    const { Event } = req.tenantModels;
    const {
      name,
      venue,
      location,
      eventDate,
      time,
      whatsappTemplate,
      customMessage,
      description,
      attachments,
      status,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Event name is required.",
      });
    }

    const orgId = req.user?.organizationId || req.organization?._id;
    const finalLocation = (venue || location || "").trim();

    // Sanitize eventDate
    let parsedEventDate = new Date();
    if (eventDate) {
      const d = new Date(eventDate);
      if (!isNaN(d.getTime())) {
        parsedEventDate = d;
      }
    }

    // Sanitize attachments from body and uploaded files
    let bodyAttachments = [];
    if (typeof attachments === "string") {
      try {
        const parsed = JSON.parse(attachments);
        bodyAttachments = Array.isArray(parsed) ? parsed : [parsed];
      } catch (_) {
        bodyAttachments = [];
      }
    } else if (Array.isArray(attachments)) {
      bodyAttachments = attachments.flatMap((att) => {
        if (typeof att === "string") {
          try {
            const parsed = JSON.parse(att);
            return Array.isArray(parsed) ? parsed : [parsed];
          } catch (_) {
            return [];
          }
        }
        return att ? [att] : [];
      });
    }

    const uploadedFiles = Array.isArray(req.files) ? req.files : [];
    const uploadedAttachments = uploadedFiles.map((file) => ({
      name: file.originalname || "attachment",
      type: file.mimetype || "application/octet-stream",
      size: file.size || 0,
      url: `/uploads/events/${file.filename}`,
      uri: `/uploads/events/${file.filename}`,
    }));

    const combinedAttachments = [...bodyAttachments, ...uploadedAttachments];

    const sanitizedAttachments = combinedAttachments.map((att) => {
      const fileUrl = typeof att?.url === "string" ? att.url.trim() : "";
      const fileUri = typeof att?.uri === "string" ? att.uri.trim() : "";
      const finalUrl = fileUrl || (fileUri.startsWith("/uploads/") ? fileUri : "");
      return {
        name: typeof att?.name === "string" ? att.name.trim() : "file",
        type: typeof att?.type === "string" ? att.type.trim() : "application/octet-stream",
        size: typeof att?.size === "number" ? att.size : 0,
        url: finalUrl,
        uri: fileUri || finalUrl,
      };
    });

    const finalTemplate = (whatsappTemplate || description || "").trim();

    const newEvent = await Event.create({
      name: name.trim(),
      venue: finalLocation,
      location: finalLocation,
      eventDate: parsedEventDate,
      time: (time || "").trim(),
      whatsappTemplate: finalTemplate,
      customMessage: (customMessage || "").trim(),
      description: (description || finalTemplate).trim(),
      attachments: sanitizedAttachments,
      status: status && ["active", "completed", "archived"].includes(status) ? status : "active",
      organizationId: orgId,
      createdBy: req.user?._id || req.user?.id || null,
      createdByName: req.user?.name || "Manager",
      stats: {
        totalCaptured: 0,
        whatsappSentCount: 0,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Event created successfully.",
      data: newEvent,
    });
  } catch (err) {
    console.error("[EventController] createEvent error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to create event.",
    });
  }
};

/**
 * Update an existing event
 * @route PUT /api/events/:id
 */
export const updateEvent = async (req, res) => {
  try {
    const { Event, EventContact } = req.tenantModels;
    const { id } = req.params;
    const {
      name,
      venue,
      location,
      eventDate,
      time,
      whatsappTemplate,
      customMessage,
      description,
      attachments,
      status,
    } = req.body;

    const event = await Event.findById(id);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found.",
      });
    }

    if (name !== undefined) event.name = name.trim();
    if (venue !== undefined || location !== undefined) {
      const finalLoc = (venue !== undefined ? venue : location || "").trim();
      event.venue = finalLoc;
      event.location = finalLoc;
    }
    if (eventDate !== undefined) {
      const d = new Date(eventDate);
      if (!isNaN(d.getTime())) event.eventDate = d;
    }
    if (time !== undefined) event.time = (time || "").trim();
    if (whatsappTemplate !== undefined) event.whatsappTemplate = (whatsappTemplate || "").trim();
    if (customMessage !== undefined) event.customMessage = (customMessage || "").trim();
    if (description !== undefined) event.description = (description || "").trim();
    if (status !== undefined && ["active", "completed", "archived"].includes(status)) {
      event.status = status;
    }
    const uploadedFiles = Array.isArray(req.files) ? req.files : [];
    const hasUploadedFiles = uploadedFiles.length > 0;

    let bodyAttachments = null;
    const rawAttachments =
      req.body.existingAttachments !== undefined
        ? req.body.existingAttachments
        : attachments;

    if (typeof rawAttachments === "string") {
      try {
        const parsed = JSON.parse(rawAttachments);
        bodyAttachments = Array.isArray(parsed) ? parsed : [parsed];
      } catch (_) {
        bodyAttachments = [];
      }
    } else if (Array.isArray(rawAttachments)) {
      bodyAttachments = rawAttachments.flatMap((att) => {
        if (typeof att === "string") {
          try {
            const parsed = JSON.parse(att);
            return Array.isArray(parsed) ? parsed : [parsed];
          } catch (_) {
            return [];
          }
        }
        return att ? [att] : [];
      });
    }

    const shouldReplace =
      req.body.replaceAttachments === "true" ||
      req.body.replaceAttachments === true ||
      req.body.existingAttachments !== undefined ||
      bodyAttachments !== null;

    if (shouldReplace || hasUploadedFiles) {
      const existing = bodyAttachments !== null ? bodyAttachments : [];
      const uploadedAttachments = uploadedFiles.map((file) => {
        const ext = (path?.extname
          ? path.extname(file.originalname || "")
          : (file.originalname || "").slice((file.originalname || "").lastIndexOf("."))
        ).toLowerCase();
        const isImg =
          (file.mimetype && file.mimetype.startsWith("image/")) ||
          [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"].includes(ext);
        return {
          name: file.originalname || "photo.jpg",
          type: file.mimetype || (isImg ? "image/jpeg" : "application/octet-stream"),
          size: file.size || 0,
          url: `/uploads/events/${file.filename}`,
          uri: `/uploads/events/${file.filename}`,
          isImage: isImg,
        };
      });
      const combined = [...existing, ...uploadedAttachments];
      event.attachments = combined.map((att) => {
        const fileUrl = typeof att?.url === "string" ? att.url.trim() : "";
        const fileUri = typeof att?.uri === "string" ? att.uri.trim() : "";
        const finalUrl = fileUrl || (fileUri.startsWith("/uploads/") ? fileUri : "");
        const rawType = typeof att?.type === "string" ? att.type.trim() : "";
        const rawName = typeof att?.name === "string" ? att.name.trim() : "file";
        const isImg =
          att?.isImage === true ||
          rawType.startsWith("image/") ||
          /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(rawName) ||
          /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(finalUrl);

        return {
          name: rawName,
          type: rawType || (isImg ? "image/jpeg" : "application/octet-stream"),
          size: typeof att?.size === "number" ? att.size : 0,
          url: finalUrl,
          uri: fileUri || finalUrl,
          isImage: isImg,
        };
      });
    }

    await event.save();

    const totalCaptured = await EventContact.countDocuments({ eventId: event._id });
    const whatsappSentCount = await EventContact.countDocuments({
      eventId: event._id,
      status: { $in: ["whatsapp_opened", "completed"] },
    });

    return res.status(200).json({
      success: true,
      message: "Event updated successfully.",
      data: {
        ...event.toObject(),
        stats: {
          totalCaptured,
          whatsappSentCount,
        },
      },
    });
  } catch (err) {
    console.error("[EventController] updateEvent error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to update event.",
    });
  }
};

/**
 * Delete or archive an event
 * @route DELETE /api/events/:id
 */
export const deleteEvent = async (req, res) => {
  try {
    const { Event, EventContact } = req.tenantModels;
    const { id } = req.params;

    const event = await Event.findById(id);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found.",
      });
    }

    const contactsCount = await EventContact.countDocuments({ eventId: id });
    if (contactsCount > 0) {
      // Archive event if it already holds captured contacts
      event.status = "archived";
      await event.save();
      return res.status(200).json({
        success: true,
        message: "Event has existing contacts and was archived.",
        data: event,
      });
    }

    await Event.findByIdAndDelete(id);
    return res.status(200).json({
      success: true,
      message: "Event deleted successfully.",
      data: { _id: id },
    });
  } catch (err) {
    console.error("[EventController] deleteEvent error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to delete event.",
    });
  }
};

/**
 * Get Event Details by ID with stats
 * @route GET /api/events/:id
 */
export const getEventById = async (req, res) => {
  try {
    const { Event, EventContact } = req.tenantModels;
    const event = await Event.findById(req.params.id).lean();

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found.",
      });
    }

    const totalCaptured = await EventContact.countDocuments({ eventId: event._id });
    const whatsappSentCount = await EventContact.countDocuments({
      eventId: event._id,
      status: { $in: ["whatsapp_opened", "completed"] },
    });

    return res.status(200).json({
      success: true,
      data: {
        ...event,
        stats: {
          totalCaptured,
          whatsappSentCount,
        },
      },
    });
  } catch (err) {
    console.error("[EventController] getEventById error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to fetch event.",
    });
  }
};

/**
 * Get contacts under an Event
 * @route GET /api/events/:id/contacts
 */
export const getEventContacts = async (req, res) => {
  try {
    const { EventContact } = req.tenantModels;
    const { search, limit = 100, page = 1 } = req.query;

    const filter = { eventId: req.params.id, isDeleted: { $ne: true } };

    if (search && search.trim()) {
      const q = search.trim();
      filter.$or = [
        { name: { $regex: q, $options: "i" } },
        { phone: { $regex: q, $options: "i" } },
        { companyName: { $regex: q, $options: "i" } },
        { designation: { $regex: q, $options: "i" } },
        { summary: { $regex: q, $options: "i" } },
      ];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(200, parseInt(limit, 10) || 100));
    const skip = (pageNum - 1) * limitNum;

    const [contacts, total] = await Promise.all([
      EventContact.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      EventContact.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        contacts,
        total,
        page: pageNum,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error("[EventController] getEventContacts error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to fetch event contacts.",
    });
  }
};

/**
 * Create a new Contact strictly under an Event
 * (Zero contamination into CRM Leads)
 * @route POST /api/events/:id/contacts
 */
export const createEventContact = async (req, res) => {
  try {
    const { Event, EventContact } = req.tenantModels;
    const {
      name,
      phone = "",
      companyName = "",
      designation = "",
      summary = "",
      messageText = "",
      transcript = "",
      attachments = [],
      aiExtracted = {},
      corrections = {},
      status = "captured",
      idempotencyKey = null,
      allowDuplicate = false,
      forceUpdate = false,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Contact name is required.",
      });
    }

    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found.",
      });
    }

    // Clean phone number (leave empty if not provided)
    const rawCleanPhone = phone ? String(phone).replace(/\D/g, "") : "";

    // N10: Phone validation if non-empty
    if (rawCleanPhone.length > 0 && rawCleanPhone.length < 10) {
      return res.status(400).json({
        success: false,
        message: "Invalid phone number: Must contain at least 10 digits.",
      });
    }

    const cleanPhone = rawCleanPhone;
    const normalized10 = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : "";

    // D03: Idempotency check if idempotencyKey provided
    if (idempotencyKey && typeof EventContact?.findOne === "function") {
      const existingKeyDoc = await EventContact.findOne({
        eventId: event._id,
        idempotencyKey,
      });
      if (existingKeyDoc) {
        return res.status(200).json({
          success: true,
          message: "Contact already saved (idempotent request).",
          data: existingKeyDoc,
          idempotent: true,
        });
      }
    }

    // D04 & D06: Duplicate prevention within same event by normalized phone
    if (normalized10 && !allowDuplicate && typeof EventContact?.findOne === "function") {
      const existingContact = await EventContact.findOne({
        eventId: event._id,
        $or: [
          { phone: cleanPhone },
          { phone: normalized10 },
          { phone: `91${normalized10}` },
        ],
      });

      if (existingContact) {
        if (forceUpdate && typeof EventContact.findByIdAndUpdate === "function") {
          const updated = await EventContact.findByIdAndUpdate(
            existingContact._id,
            {
              $set: {
                name: name.trim(),
                companyName: (companyName || "").trim(),
                designation: (designation || "").trim(),
                summary: (summary || "").trim(),
                messageText: (messageText || "").trim(),
                transcript: (transcript || "").trim(),
                updatedAt: new Date(),
              },
            },
            { new: true }
          );
          return res.status(200).json({
            success: true,
            message: "Contact updated successfully.",
            data: updated,
            updated: true,
          });
        }

        return res.status(409).json({
          success: false,
          duplicateDetected: true,
          message: "This contact was already captured at this event.",
          existingContact,
        });
      }
    }

    const isHandoffDone = status === "whatsapp_opened" || status === "completed";

    const newContact = await EventContact.create({
      eventId: event._id,
      idempotencyKey: idempotencyKey || null,
      name: name.trim(),
      phone: cleanPhone,
      companyName: (companyName || "").trim(),
      designation: (designation || "").trim(),
      summary: (summary || "").trim(),
      messageText: (messageText || "").trim(),
      transcript: (transcript || "").trim(),
      attachments: Array.isArray(attachments) ? attachments : [],
      aiExtracted: aiExtracted || {},
      corrections: corrections || {},
      status: status || "captured",
      capturedBy: req.user?._id || null,
      capturedByName: req.user?.name || "Manager",
      whatsappOpenedAt: isHandoffDone ? new Date() : null,
      sentAt: isHandoffDone ? new Date() : null,
    });

    // Update event counter
    await Event.findByIdAndUpdate(event._id, {
      $inc: {
        "stats.totalCaptured": 1,
        ...(isHandoffDone ? { "stats.whatsappSentCount": 1 } : {}),
      },
    });

    return res.status(201).json({
      success: true,
      message: "Event contact saved successfully.",
      data: newContact,
    });
  } catch (err) {
    console.error("[EventController] createEventContact error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to save event contact.",
    });
  }
};

/**
 * Update contact status (e.g. when WhatsApp was opened)
 * @route PATCH /api/events/:id/contacts/:contactId/status
 */
export const updateContactStatus = async (req, res) => {
  try {
    const { Event, EventContact } = req.tenantModels;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        message: "Status is required.",
      });
    }

    const contact = await EventContact.findOne({
      _id: req.params.contactId,
      eventId: req.params.id,
    });

    if (!contact) {
      return res.status(404).json({
        success: false,
        message: "Event contact not found.",
      });
    }

    const wasSentBefore = contact.status === "whatsapp_opened" || contact.status === "completed";
    contact.status = status;
    if ((status === "whatsapp_opened" || status === "completed") && !contact.whatsappOpenedAt) {
      contact.whatsappOpenedAt = new Date();
      contact.sentAt = new Date();
    }
    await contact.save();

    if (!wasSentBefore && (status === "whatsapp_opened" || status === "completed")) {
      await Event.findByIdAndUpdate(req.params.id, {
        $inc: { "stats.whatsappSentCount": 1 },
      });
    }

    return res.status(200).json({
      success: true,
      data: contact,
    });
  } catch (err) {
    console.error("[EventController] updateContactStatus error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to update contact status.",
    });
  }
};

/**
 * Update an existing Contact under an Event
 * @route PUT /api/events/:id/contacts/:contactId
 */
export const updateEventContact = async (req, res) => {
  try {
    const { EventContact } = req.tenantModels;
    const { id, contactId } = req.params;
    const {
      name,
      phone,
      companyName,
      designation,
      summary,
      messageText,
    } = req.body;

    const contact = await EventContact.findOne({
      _id: contactId,
      eventId: id,
      isDeleted: { $ne: true },
    });

    if (!contact) {
      return res.status(404).json({
        success: false,
        message: "Event contact not found or has been removed.",
      });
    }

    if (name !== undefined) {
      if (!name.trim()) {
        return res.status(400).json({
          success: false,
          message: "Contact name cannot be empty.",
        });
      }
      contact.name = name.trim();
    }

    if (phone !== undefined) {
      contact.phone = String(phone).trim();
    }
    if (companyName !== undefined) contact.companyName = String(companyName).trim();
    if (designation !== undefined) contact.designation = String(designation).trim();
    if (summary !== undefined) contact.summary = String(summary).trim();
    if (messageText !== undefined) contact.messageText = String(messageText).trim();

    await contact.save();

    return res.status(200).json({
      success: true,
      message: "Contact updated successfully.",
      data: contact,
    });
  } catch (err) {
    console.error("[EventController] updateEventContact error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to update event contact.",
    });
  }
};

/**
 * Soft Delete a Contact under an Event
 * (Records are preserved in MongoDB with isDeleted: true, never permanently removed)
 * @route DELETE /api/events/:id/contacts/:contactId
 */
export const deleteEventContact = async (req, res) => {
  try {
    const { Event, EventContact } = req.tenantModels;
    const { id, contactId } = req.params;

    const contact = await EventContact.findOne({
      _id: contactId,
      eventId: id,
      isDeleted: { $ne: true },
    });

    if (!contact) {
      return res.status(404).json({
        success: false,
        message: "Event contact not found or already removed.",
      });
    }

    // Strictly perform SOFT DELETE only
    contact.isDeleted = true;
    contact.deletedAt = new Date();
    contact.deletedBy = req.user?._id || null;
    await contact.save();

    // Decrement stats counter safely if > 0
    try {
      const event = await Event.findById(id);
      if (event && event.stats && event.stats.totalCaptured > 0) {
        event.stats.totalCaptured = Math.max(0, event.stats.totalCaptured - 1);
        if (contact.status === "whatsapp_opened" || contact.status === "completed") {
          event.stats.whatsappSentCount = Math.max(0, (event.stats.whatsappSentCount || 0) - 1);
        }
        await event.save();
      }
    } catch (statErr) {
      console.warn("[EventController] Error updating event stats on soft delete:", statErr.message);
    }

    return res.status(200).json({
      success: true,
      message: "Contact removed successfully.",
      data: { contactId, isDeleted: true },
    });
  } catch (err) {
    console.error("[EventController] deleteEventContact error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to remove event contact.",
    });
  }
};

