import Conversation from "../models/Conversation.js";
import EventContact from "../models/EventContact.js";

/**
 * Controller for captured face-to-face conversations.
 */

/**
 * List captured conversations for authenticated user / tenant.
 * @route GET /api/conversations
 */
export const getConversations = async (req, res) => {
  try {
    const orgId = req.user?.organizationId;
    const userId = req.user?.id || req.user?._id;
    const userRole = String(req.user?.role || "").toLowerCase();
    const isManager =
      userRole.includes("admin") ||
      userRole.includes("manager") ||
      userRole.includes("owner");

    const query = { sessionId: { $exists: true, $ne: null } };

    if (orgId) {
      query.organizationId = orgId;
    }
    // Standard sales reps only see their own captured conversations
    if (!isManager && userId) {
      query.userId = userId;
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const [conversations, total] = await Promise.all([
      Conversation.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select("-usageMetrics -__v")
        .lean(),
      Conversation.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      data: conversations,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("[ConversationController] getConversations error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to retrieve conversation capture records.",
      error: err.message,
    });
  }
};

/**
 * Get single conversation record by sessionId or ID.
 * @route GET /api/conversations/:id
 */
export const getConversationById = async (req, res) => {
  try {
    const { id } = req.params;
    const conversation = await Conversation.findOne({
      $or: [{ sessionId: id }, { _id: id.match(/^[0-9a-fA-F]{24}$/) ? id : null }],
    }).lean();

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: "Conversation record not found.",
      });
    }

    res.status(200).json({
      success: true,
      data: conversation,
    });
  } catch (err) {
    console.error("[ConversationController] getConversationById error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to retrieve conversation details.",
      error: err.message,
    });
  }
};

/**
 * User review and confirmation of extracted contact details.
 * Saves confirmed details in MongoDB and marks confirmation status as "confirmed".
 * @route POST /api/conversations/:id/confirm
 */
export const confirmContact = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      phone,
      company,
      designation,
      createEventContactRecord = true,
    } = req.body;

    const conversation = await Conversation.findOne({
      $or: [{ sessionId: id }, { _id: id.match(/^[0-9a-fA-F]{24}$/) ? id : null }],
    });

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: "Conversation record not found.",
      });
    }

    // Apply corrections or confirm extracted values
    const finalName = (name !== undefined ? name : conversation.extractedContact?.name?.value || "").trim();
    const finalPhone = (phone !== undefined ? phone : conversation.extractedContact?.phone?.value || "").trim();
    const finalCompany = (company !== undefined ? company : conversation.extractedContact?.company?.value || "").trim();
    const finalDesignation = (designation !== undefined ? designation : conversation.extractedContact?.designation?.value || "").trim();

    conversation.extractedContact.name.value = finalName;
    conversation.extractedContact.phone.value = finalPhone;
    conversation.extractedContact.company.value = finalCompany;
    conversation.extractedContact.designation.value = finalDesignation;
    conversation.extractedContact.confirmationStatus = "confirmed";
    conversation.extractedContact.confirmedAt = new Date();

    await conversation.save();

    // If tied to an event and requested, also create a confirmed EventContact record
    let eventContactDoc = null;
    if (createEventContactRecord && conversation.eventId && finalName) {
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
          capturedBy: req.user?.id || req.user?._id,
          capturedByName: req.user?.name || "Sales Rep",
          aiExtracted: conversation.extractedContact,
        });
      } catch (ecErr) {
        console.warn("[ConversationController] Non-fatal: could not create EventContact:", ecErr.message);
      }
    }

    res.status(200).json({
      success: true,
      message: "Contact confirmed and verified successfully.",
      data: {
        conversation,
        eventContact: eventContactDoc,
      },
    });
  } catch (err) {
    console.error("[ConversationController] confirmContact error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to confirm contact details.",
      error: err.message,
    });
  }
};

