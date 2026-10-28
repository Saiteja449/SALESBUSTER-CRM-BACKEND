import { GoogleGenerativeAI } from "@google/generative-ai";
import { getMasterModels } from "../services/tenantManager.js";
import { decryptApiKey } from "../utils/encryption.js";

/**
 * Summarize real-time speech transcript using Gemini AI
 * Extracts: Name, 10-digit Phone, Company, Summary, and ready-to-send WhatsApp message.
 * @route POST /api/events/summarize-text
 */
export const summarizeTranscript = async (req, res) => {
  try {
    const { transcript, eventName } = req.body;

    if (!transcript || typeof transcript !== "string" || !transcript.trim()) {
      return res.status(400).json({
        success: false,
        message: "Speech transcript text is required for AI summarization.",
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

    if (!activeKey) {
      return res.status(500).json({
        success: false,
        message: "Gemini AI API Key is not configured on the server or organization.",
      });
    }

    const genAI = new GoogleGenerativeAI(activeKey);
    const preferredModel = process.env.GEMINI_TEXT_MODEL || "gemini-1.5-flash";
    const model = genAI.getGenerativeModel({ model: preferredModel });

    const senderName = req.user?.name || "Sales Manager";
    const orgName = organization?.name || "Our Team";
    const currentEvent = eventName || "our discussion";

    const prompt = `
You are the SalesBuster Event Intelligence Engine.
Analyze the following raw spoken voice transcript from a face-to-face conversation or voice memo at an event ("${currentEvent}").
The conversation may be in English, Hindi, Telugu, or multilingual mix.

TRANSCRIPT:
"${transcript.trim()}"

TASK:
Extract the following information:
1. name: The customer / person's name mentioned or spoken. If unknown, return null.
2. phone: The customer's 10-digit mobile number spoken (e.g. "9876543210"). Extract ONLY digits. If none found, return null.
3. companyName: The company, firm, shop, or organization associated with the person. If none mentioned, return null.
4. summary: A concise 1-2 sentence summary of the discussion topic, requirements, or next steps.
5. messageText: A professional, warm, personalized WhatsApp message ready to be sent to this person from ${senderName} (${orgName}). Keep it friendly, mentioning the context discussed and inviting them to stay in touch. (Do NOT include fake links or placeholders).

CRITICAL FORMAT REQUIREMENT:
Respond ONLY with a valid raw JSON object and nothing else. Do NOT include markdown code fences or backticks.
Example:
{
  "name": "Rahul Verma",
  "phone": "9876543210",
  "companyName": "Apex Technologies",
  "summary": "Discussed commercial CRM licensing and sales rep tracking.",
  "messageText": "Hello Rahul, it was great speaking with you regarding commercial CRM at ${currentEvent}. Feel free to connect directly whenever you need assistance!\\n\\nBest regards,\\n${senderName}\\n${orgName}"
}
`;

    const result = await model.generateContent(prompt);
    const rawResponse = result.response.text().trim();

    // Clean JSON formatting if enclosed in code blocks
    const cleanJson = rawResponse
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleanJson);
    } catch (parseErr) {
      console.warn("[EventAI] Failed to parse Gemini response as JSON:", rawResponse);
      parsed = {
        name: null,
        phone: null,
        companyName: null,
        summary: transcript.slice(0, 150),
        messageText: `Hello! It was great connecting with you today at ${currentEvent}. Let's stay in touch!\n\nBest regards,\n${senderName}\n${orgName}`,
      };
    }

    // Clean phone number
    let cleanPhone = "";
    if (parsed.phone && parsed.phone !== "null") {
      const digits = String(parsed.phone).replace(/\D/g, "");
      if (digits.length >= 10) {
        cleanPhone = digits.slice(-10);
      }
    }

    // Fallback phone extraction with regex if Gemini missed it
    if (!cleanPhone) {
      const phoneMatch = transcript.match(/(?:(?:\+|0{0,2})91[\s-]*)?([6-9]\d{9})/);
      if (phoneMatch) {
        cleanPhone = phoneMatch[1];
      }
    }

    const customerName =
      parsed.name && parsed.name !== "null" && parsed.name !== "Valued Customer"
        ? parsed.name.trim()
        : "";

    const companyName =
      parsed.companyName && parsed.companyName !== "null"
        ? parsed.companyName.trim()
        : "";

    const summary = (parsed.summary || transcript.slice(0, 120)).trim();

    const greetingName = customerName || "there";
    const defaultMessage =
      `Hello ${greetingName},\n\n` +
      `It was great speaking with you regarding ${companyName || "our discussion"} at ${currentEvent}.\n` +
      `Feel free to reach out to me directly on WhatsApp whenever you need any assistance!\n\n` +
      `Best regards,\n` +
      `*${senderName}*\n` +
      `${orgName}`;

    const messageText = (parsed.messageText || defaultMessage).trim();

    return res.status(200).json({
      success: true,
      data: {
        name: customerName,
        phone: cleanPhone,
        companyName,
        summary,
        messageText,
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

    const events = await Event.find(filter).sort({ createdAt: -1 }).lean();

    // Attach up-to-date counts
    const eventsWithCounts = await Promise.all(
      events.map(async (ev) => {
        const totalCaptured = await EventContact.countDocuments({ eventId: ev._id });
        const whatsappSentCount = await EventContact.countDocuments({
          eventId: ev._id,
          status: { $in: ["whatsapp_opened", "completed"] },
        });

        return {
          ...ev,
          stats: {
            totalCaptured,
            whatsappSentCount,
          },
        };
      })
    );

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
    const { name, description, eventDate, location } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Event name is required.",
      });
    }

    const orgId = req.user?.organizationId || req.organization?._id;

    const newEvent = await Event.create({
      name: name.trim(),
      description: (description || "").trim(),
      eventDate: eventDate ? new Date(eventDate) : new Date(),
      location: (location || "").trim(),
      status: "active",
      organizationId: orgId,
      createdBy: req.user?._id || null,
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

    const filter = { eventId: req.params.id };

    if (search && search.trim()) {
      const q = search.trim();
      filter.$or = [
        { name: { $regex: q, $options: "i" } },
        { phone: { $regex: q, $options: "i" } },
        { companyName: { $regex: q, $options: "i" } },
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
    const { name, phone, companyName, summary, messageText, status = "whatsapp_opened" } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Contact name is required.",
      });
    }

    if (!phone || !phone.trim()) {
      return res.status(400).json({
        success: false,
        message: "Contact phone number is required.",
      });
    }

    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found.",
      });
    }

    // Clean phone number
    const cleanPhone = phone.replace(/\D/g, "");

    const newContact = await EventContact.create({
      eventId: event._id,
      name: name.trim(),
      phone: cleanPhone,
      companyName: (companyName || "").trim(),
      summary: (summary || "").trim(),
      messageText: (messageText || "").trim(),
      status: status || "whatsapp_opened",
      capturedBy: req.user?._id || null,
      capturedByName: req.user?.name || "Manager",
      sentAt: status === "whatsapp_opened" || status === "completed" ? new Date() : null,
    });

    // Update event counter
    await Event.findByIdAndUpdate(event._id, {
      $inc: {
        "stats.totalCaptured": 1,
        ...(status === "whatsapp_opened" || status === "completed"
          ? { "stats.whatsappSentCount": 1 }
          : {}),
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
    if ((status === "whatsapp_opened" || status === "completed") && !contact.sentAt) {
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

