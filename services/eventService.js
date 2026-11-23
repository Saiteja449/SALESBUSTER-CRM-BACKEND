import { NotFoundError, BadRequestError } from "../utils/AppError.js";

const sanitizeAttachments = (bodyAttachments, files = []) => {
  let list = [];
  if (typeof bodyAttachments === "string") {
    try {
      const parsed = JSON.parse(bodyAttachments);
      list = Array.isArray(parsed) ? parsed : [parsed];
    } catch (_) {
      list = [];
    }
  } else if (Array.isArray(bodyAttachments)) {
    list = bodyAttachments.flatMap((att) => {
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

  const uploadedAttachments = (Array.isArray(files) ? files : []).map((file) => ({
    name: file.originalname || "attachment",
    type: file.mimetype || "application/octet-stream",
    size: file.size || 0,
    url: `/uploads/events/${file.filename}`,
    uri: `/uploads/events/${file.filename}`,
  }));

  const combined = [...list, ...uploadedAttachments];

  return combined.map((att) => {
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
};

/**
 * Fetch events for organization with aggregated contact statistics.
 */
export const queryEventsService = async ({ tenantModels, status }) => {
  const { Event, EventContact } = tenantModels;
  const filter = {};
  if (status && status !== "all") {
    filter.status = status;
  }

  const events = await Event.find(filter).sort({ createdAt: -1, _id: -1 }).lean();
  const eventIds = events.map((e) => e._id);

  let countsByEventId = new Map();
  if (eventIds.length && EventContact) {
    try {
      const contactCounts = await EventContact.aggregate([
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
      ]);
      countsByEventId = new Map(contactCounts.map((r) => [String(r._id), r]));
    } catch (_) {}
  }

  return events.map((event) => {
    const counts = countsByEventId.get(String(event._id));
    return {
      ...event,
      stats: {
        totalCaptured: counts?.totalCaptured || 0,
        whatsappSentCount: counts?.whatsappSentCount || 0,
      },
    };
  });
};

/**
 * Creates a new Event document.
 */
export const createEventService = async ({
  tenantModels,
  data,
  files = [],
  user = null,
  organizationId = null,
}) => {
  const { Event } = tenantModels;
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
  } = data;

  const finalLocation = (venue || location || "").trim();
  let parsedDate = new Date();
  if (eventDate) {
    const d = new Date(eventDate);
    if (!isNaN(d.getTime())) parsedDate = d;
  }

  const sanitizedAttachments = sanitizeAttachments(attachments, files);
  const finalTemplate = (whatsappTemplate || description || "").trim();

  return await Event.create({
    name: name.trim(),
    venue: finalLocation,
    location: finalLocation,
    eventDate: parsedDate,
    time: (time || "").trim(),
    whatsappTemplate: finalTemplate,
    customMessage: (customMessage || "").trim(),
    description: (description || finalTemplate).trim(),
    attachments: sanitizedAttachments,
    status: status && ["active", "completed", "archived"].includes(status) ? status : "active",
    organizationId,
    createdBy: user?._id || user?.id || null,
    createdByName: user?.name || "Manager",
    stats: {
      totalCaptured: 0,
      whatsappSentCount: 0,
    },
  });
};

/**
 * Fetch a single event with aggregated contact statistics.
 */
export const getEventByIdService = async ({ tenantModels, eventId }) => {
  const { Event, EventContact } = tenantModels;
  const event = await Event.findById(eventId).lean();
  if (!event) {
    throw new NotFoundError("Event not found.");
  }

  let totalCaptured = 0;
  let whatsappSentCount = 0;
  if (EventContact) {
    try {
      const counts = await EventContact.aggregate([
        { $match: { eventId: event._id } },
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
      ]);
      if (counts.length > 0) {
        totalCaptured = counts[0].totalCaptured || 0;
        whatsappSentCount = counts[0].whatsappSentCount || 0;
      }
    } catch (_) {}
  }

  return {
    ...event,
    stats: {
      totalCaptured,
      whatsappSentCount,
    },
  };
};

/**
 * Updates an Event document and its attachments.
 */
export const updateEventService = async ({ tenantModels, eventId, data, files = [] }) => {
  const { Event } = tenantModels;
  const event = await Event.findById(eventId);
  if (!event) {
    throw new NotFoundError("Event not found.");
  }

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
  } = data;

  if (name !== undefined) event.name = name.trim();
  if (venue !== undefined || location !== undefined) {
    const loc = (venue || location || "").trim();
    event.venue = loc;
    event.location = loc;
  }
  if (eventDate) {
    const d = new Date(eventDate);
    if (!isNaN(d.getTime())) event.eventDate = d;
  }
  if (time !== undefined) event.time = (time || "").trim();
  if (whatsappTemplate !== undefined) event.whatsappTemplate = (whatsappTemplate || "").trim();
  if (customMessage !== undefined) event.customMessage = (customMessage || "").trim();
  if (description !== undefined) event.description = (description || "").trim();
  if (status && ["active", "completed", "archived"].includes(status)) {
    event.status = status;
  }

  if (attachments !== undefined || (files && files.length > 0)) {
    event.attachments = sanitizeAttachments(attachments !== undefined ? attachments : event.attachments, files);
  }

  return await event.save();
};

/**
 * Deletes an event and all associated EventContacts.
 */
export const deleteEventService = async ({ tenantModels, eventId }) => {
  const { Event, EventContact } = tenantModels;
  const event = await Event.findById(eventId);
  if (!event) {
    throw new NotFoundError("Event not found.");
  }

  await event.deleteOne();
  if (EventContact) {
    await EventContact.deleteMany({ eventId });
  }
  return { id: eventId, deleted: true };
};

/**
 * Queries contacts under an event with optional search and status filtering.
 */
export const queryEventContactsService = async ({
  tenantModels,
  eventId,
  search = "",
  status = "all",
}) => {
  const { EventContact } = tenantModels;
  const filter = { eventId };

  if (status && status !== "all") {
    filter.status = status;
  }

  if (search && search.trim()) {
    const regex = new RegExp(search.trim(), "i");
    filter.$or = [
      { name: regex },
      { phone: regex },
      { companyName: regex },
      { designation: regex },
      { summary: regex },
    ];
  }

  return await EventContact.find(filter).sort({ createdAt: -1 }).lean();
};

/**
 * Creates an EventContact under an event.
 */
export const createEventContactService = async ({ tenantModels, eventId, data, user = null }) => {
  const { Event, EventContact } = tenantModels;
  const event = await Event.findById(eventId);
  if (!event) {
    throw new NotFoundError("Event not found.");
  }

  const {
    name,
    phone,
    companyName,
    designation,
    summary,
    messageText,
    transcript,
    status = "captured",
    attachments = [],
  } = data;

  const contact = await EventContact.create({
    eventId,
    name: name.trim(),
    phone: (phone || "").trim(),
    companyName: (companyName || "").trim(),
    designation: (designation || "").trim(),
    summary: (summary || "").trim(),
    messageText: (messageText || "").trim(),
    transcript: (transcript || "").trim(),
    status,
    attachments: Array.isArray(attachments) ? attachments : [],
    capturedBy: user?._id || user?.id || null,
    capturedByName: user?.name || "Sales Rep",
  });

  return contact;
};

/**
 * Updates an EventContact's status.
 */
export const updateEventContactStatusService = async ({
  tenantModels,
  eventId,
  contactId,
  status,
}) => {
  const { EventContact } = tenantModels;
  const contact = await EventContact.findOne({ _id: contactId, eventId });
  if (!contact) {
    throw new NotFoundError("Event contact not found.");
  }

  contact.status = status;
  return await contact.save();
};

/**
 * Updates an EventContact's fields.
 */
export const updateEventContactService = async ({
  tenantModels,
  eventId,
  contactId,
  data,
}) => {
  const { EventContact } = tenantModels;
  const contact = await EventContact.findOne({ _id: contactId, eventId });
  if (!contact) {
    throw new NotFoundError("Event contact not found.");
  }

  if (data.name !== undefined) contact.name = data.name.trim();
  if (data.phone !== undefined) contact.phone = data.phone.trim();
  if (data.companyName !== undefined) contact.companyName = data.companyName.trim();
  if (data.designation !== undefined) contact.designation = data.designation.trim();
  if (data.summary !== undefined) contact.summary = data.summary.trim();
  if (data.messageText !== undefined) contact.messageText = data.messageText.trim();
  if (data.status !== undefined) contact.status = data.status;

  return await contact.save();
};

/**
 * Deletes an EventContact.
 */
export const deleteEventContactService = async ({ tenantModels, eventId, contactId }) => {
  const { EventContact } = tenantModels;
  const contact = await EventContact.findOne({ _id: contactId, eventId });
  if (!contact) {
    throw new NotFoundError("Event contact not found.");
  }

  await contact.deleteOne();
  return { id: contactId, deleted: true };
};

export default {
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
};
