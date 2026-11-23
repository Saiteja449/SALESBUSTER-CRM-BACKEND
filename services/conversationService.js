import { NotFoundError } from "../utils/AppError.js";

/**
 * Queries captured face-to-face conversations with tenant and role scoping.
 */
export const queryCapturedConversationsService = async ({
  tenantModels,
  user,
  organizationId,
  query = {},
}) => {
  const { Conversation } = tenantModels;
  const userRole = String(user?.role || "").toLowerCase();
  const isManager =
    userRole.includes("admin") ||
    userRole.includes("manager") ||
    userRole.includes("owner");

  const mongoQuery = { sessionId: { $exists: true, $ne: null } };

  if (organizationId) {
    mongoQuery.organizationId = organizationId;
  }

  const userId = user?.id || user?._id;
  if (!isManager && userId) {
    mongoQuery.userId = userId;
  }

  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const skip = (page - 1) * limit;

  const [conversations, total] = await Promise.all([
    Conversation.find(mongoQuery)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("-usageMetrics -__v")
      .lean(),
    Conversation.countDocuments(mongoQuery),
  ]);

  return {
    conversations,
    total,
    page,
    limit,
  };
};

/**
 * Retrieves a single captured conversation by sessionId or ObjectId.
 */
export const getConversationByIdService = async ({ tenantModels, id }) => {
  const { Conversation } = tenantModels;
  const isObjectId = id && typeof id === "string" && id.match(/^[0-9a-fA-F]{24}$/);
  
  const conversation = await Conversation.findOne({
    $or: [{ sessionId: id }, ...(isObjectId ? [{ _id: id }] : [])],
  }).lean();

  if (!conversation) {
    throw new NotFoundError("Conversation record not found.");
  }
  return conversation;
};

/**
 * Confirms extracted contact details and creates an EventContact if linked to an event.
 */
export const confirmConversationContactService = async ({
  tenantModels,
  id,
  contactData,
  user,
}) => {
  const { Conversation, EventContact } = tenantModels;
  const isObjectId = id && typeof id === "string" && id.match(/^[0-9a-fA-F]{24}$/);

  const conversation = await Conversation.findOne({
    $or: [{ sessionId: id }, ...(isObjectId ? [{ _id: id }] : [])],
  });

  if (!conversation) {
    throw new NotFoundError("Conversation record not found.");
  }

  const {
    name,
    phone,
    company,
    designation,
    createEventContactRecord = true,
  } = contactData;

  if (!conversation.extractedContact) {
    conversation.extractedContact = { name: {}, phone: {}, company: {}, designation: {} };
  }

  const finalName = (name !== undefined ? name : conversation.extractedContact?.name?.value || "").trim();
  const finalPhone = (phone !== undefined ? phone : conversation.extractedContact?.phone?.value || "").trim();
  const finalCompany = (company !== undefined ? company : conversation.extractedContact?.company?.value || "").trim();
  const finalDesignation = (designation !== undefined ? designation : conversation.extractedContact?.designation?.value || "").trim();

  conversation.extractedContact.name = conversation.extractedContact.name || {};
  conversation.extractedContact.name.value = finalName;
  conversation.extractedContact.phone = conversation.extractedContact.phone || {};
  conversation.extractedContact.phone.value = finalPhone;
  conversation.extractedContact.company = conversation.extractedContact.company || {};
  conversation.extractedContact.company.value = finalCompany;
  conversation.extractedContact.designation = conversation.extractedContact.designation || {};
  conversation.extractedContact.designation.value = finalDesignation;
  conversation.extractedContact.confirmationStatus = "confirmed";
  conversation.extractedContact.confirmedAt = new Date();

  await conversation.save();

  let eventContactDoc = null;
  if (createEventContactRecord && conversation.eventId && finalName && EventContact) {
    try {
      eventContactDoc = await EventContact.create({
        eventId: conversation.eventId,
        name: finalName,
        phone: finalPhone,
        companyName: finalCompany,
        designation: finalDesignation,
        summary: conversation.summary?.keyDiscussion || "",
        transcript: conversation.originalTranscript || "",
        status: "captured",
        capturedBy: user?.id || user?._id,
        capturedByName: user?.name || "Sales Rep",
        aiExtracted: conversation.extractedContact,
      });
    } catch (ecErr) {
      console.warn("[ConversationService] Non-fatal: could not create EventContact:", ecErr.message);
    }
  }

  return {
    conversation,
    eventContact: eventContactDoc,
  };
};

export default {
  queryCapturedConversationsService,
  getConversationByIdService,
  confirmConversationContactService,
};
