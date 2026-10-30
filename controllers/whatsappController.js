import mongoose from "mongoose";
import Lead from "../models/Lead.js";
import Message from "../models/Message.js";
import Conversation from "../models/Conversation.js";
import WhatsAppSession from "../models/WhatsAppSession.js";
import User from "../models/User.js";
import { getMasterModels } from "../services/tenantManager.js";
import { getIO } from "../socket/socket.js";
import WAAccount from "../models/WhatsAppAccount.js";
import { sendTextMessage } from "../services/whatsappCloudService.js";
import { decryptApiKey } from "../utils/encryption.js";

const getModels = (req) => ({
  LeadModel: req.tenantModels?.Lead || Lead,
  MessageModel: req.tenantModels?.Message || Message,
  ConversationModel: req.tenantModels?.Conversation || Conversation,
  WhatsAppSessionModel: req.tenantModels?.WhatsAppSession || WhatsAppSession,
  UserModel: req.tenantModels?.User || User,
});

const isLeadAssignedToUser = (lead, user) => {
  if (!lead || !user) return false;
  const userIdStr = (user._id || user.id || "").toString();
  const userName = user.name || "";
  const assigned = lead.assignedTo;
  if (!assigned) return false;
  if (typeof assigned === "object") {
    const assignedId = (assigned._id || assigned.id || "").toString();
    const assignedName = assigned.name || "";
    return (userIdStr && assignedId === userIdStr) || (userName && assignedName === userName);
  }
  const assignedStr = assigned.toString();
  return (userIdStr && assignedStr === userIdStr) || (userName && assignedStr === userName);
};


// @desc    Get WhatsApp connection status (Meta Cloud API)
// @route   GET /api/whatsapp/status
// @access  Protected
export const getStatus = async (req, res) => {
  try {
    const orgId = req.user?.organizationId
      ? req.user.organizationId.toString()
      : req.organization?._id
        ? req.organization._id.toString()
        : null;

    const isSalesRep = req.user?.role === "sales person";

    let waAccount = null;
    const AccountModel = req.tenantModels?.WAAccount || WAAccount;
    if (orgId) {
      try {
        if (isSalesRep) {
          waAccount = await AccountModel.findOne({
            organizationId: orgId,
            userId: req.user._id,
          }).lean();
        }
        if (!waAccount) {
          waAccount = await AccountModel.findOne({
            organizationId: orgId,
            userId: null,
          }).lean();
        }
        // Fallback 1: Check Master WAAccount
        if (!waAccount) {
          const { WAAccount: MasterWA } = getMasterModels();
          waAccount = await MasterWA.findOne({
            organizationId: orgId,
            ...(isSalesRep ? { userId: req.user._id } : {}),
          }).lean();
        }
        // Fallback 2: Check Default WAAccount
        if (!waAccount) {
          waAccount = await WAAccount.findOne({
            organizationId: orgId,
            ...(isSalesRep ? { userId: req.user._id } : {}),
          }).lean();
        }
        // Fallback 3: Check Organization.whatsappCloudSettings
        if (!waAccount) {
          const org = req.organization || (await getMasterModels().Organization.findById(orgId).lean());
          if (org?.whatsappCloudSettings?.isConfigured && org.whatsappCloudSettings.phoneNumberId) {
            waAccount = {
              phoneNumberId: org.whatsappCloudSettings.phoneNumberId,
              displayPhone: org.whatsappCloudSettings.displayPhoneNumber,
              status: "connected",
              businessName: org.whatsappCloudSettings.verifiedName || "WhatsApp Business (Official)",
              organizationId: orgId,
              wabaId: org.whatsappCloudSettings.wabaId,
            };
          }
        }
      } catch (e) {
        console.warn("[getStatus] Account resolution error:", e.message);
      }
    }

    if (waAccount && (waAccount.status === "connected" || waAccount.status === "syncing")) {
      return res.status(200).json({
        isCoexistence: true,
        sessions: [
          {
            sessionId: `coexist_${waAccount.phoneNumberId}`,
            organizationId: orgId,
            status: waAccount.status,
            qrCode: "",
            connectedPhone: waAccount.displayPhone || waAccount.phoneNumberId,
            connectedName: waAccount.businessName || "WhatsApp Business (Official)",
            isPrimary: true,
            label: isSalesRep ? "My WhatsApp Line" : "Official WhatsApp Line",
            isRepSession: Boolean(waAccount.userId),
            isCoexistence: true,
            phoneNumberId: waAccount.phoneNumberId,
            syncDeadline: waAccount.syncDeadline,
            historyProgress: waAccount.historyProgress,
          },
        ],
        isRepSession: isSalesRep,
        whatsappLineLimit: 1,
      });
    }

    // Default disconnected state
    return res.status(200).json({
      sessions: [
        {
          sessionId: orgId ? (isSalesRep ? `org_${orgId}_user_${req.user._id}` : `org_${orgId}`) : "device_1",
          organizationId: orgId,
          status: "disconnected",
          qrCode: "",
          connectedPhone: "",
          connectedName: "",
          isPrimary: true,
          label: isSalesRep ? "My WhatsApp Line" : "Company WhatsApp Line",
          isRepSession: isSalesRep,
          isCoexistence: true,
        },
      ],
      isRepSession: isSalesRep,
      whatsappLineLimit: 1,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Disconnect WhatsApp (Meta Cloud API)
// @route   POST /api/whatsapp/logout
// @access  Protected
export const logoutClient = async (req, res) => {
  try {
    const orgId = req.user?.organizationId
      ? req.user.organizationId.toString()
      : req.organization?._id
        ? req.organization._id.toString()
        : null;

    if (orgId) {
      const query = { organizationId: orgId };
      if (req.user?.role === "sales person") {
        query.userId = req.user._id;
      }
      await WAAccount.updateMany(query, { $set: { status: "disconnected" } });
    }

    res.status(200).json({
      message: "WhatsApp disconnected successfully.",
      sessionId: orgId ? `org_${orgId}` : "device_1",
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};


// @desc    Get all WhatsApp conversations
// @route   GET /api/whatsapp/conversations
// @access  Public
export const getConversations = async (req, res) => {
  try {
    const { ConversationModel, LeadModel } = getModels(req);
    const userRole = req.user?.role;
    const isSalesRep = userRole === "sales person";

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
    const skip = (page - 1) * limit;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const unreadOnly = req.query.unreadOnly === "true";

    const populateOptions = { path: "leadId" };
    let leadFilter = {};
    let mustFilterByLeadIds = false;

    if (isSalesRep) {
      // Security: Strictly enforce authenticated user's ID/name. Ignore req.query overrides.
      const matchArray = [
        String(req.user._id),
        new mongoose.Types.ObjectId(req.user._id),
      ];
      if (req.user.name) {
        matchArray.push(new RegExp("^" + req.user.name.trim() + "$", "i"));
      }
      populateOptions.match = {
        assignedTo: { $in: matchArray },
      };
      leadFilter.assignedTo = { $in: matchArray };
      mustFilterByLeadIds = true;
    } else if (req.query.userId || req.query.name) {
      // Admins and managers can filter by rep
      const matchArray = [];
      if (req.query.userId) {
        matchArray.push(String(req.query.userId));
        if (mongoose.Types.ObjectId.isValid(req.query.userId)) {
          matchArray.push(new mongoose.Types.ObjectId(req.query.userId));
        }
      }
      if (req.query.name) {
        matchArray.push(new RegExp("^" + req.query.name.trim() + "$", "i"));
      }
      populateOptions.match = {
        assignedTo: matchArray.length === 1 ? matchArray[0] : { $in: matchArray },
      };
      leadFilter.assignedTo = matchArray.length === 1 ? matchArray[0] : { $in: matchArray };
      mustFilterByLeadIds = true;
    }

    if (search) {
      mustFilterByLeadIds = true;
      const cleanPhone = search.replace(/\D/g, "");
      const searchConditions = [
        { name: { $regex: search, $options: "i" } },
      ];
      if (cleanPhone) {
        searchConditions.push({ phone: { $regex: cleanPhone, $options: "i" } });
      }
      if (leadFilter.$or) {
        leadFilter.$and = [{ $or: leadFilter.$or }, { $or: searchConditions }];
        delete leadFilter.$or;
      } else {
        leadFilter.$or = searchConditions;
      }
    }

    const conversationQuery = {};

    if (unreadOnly) {
      conversationQuery.unreadCount = { $gt: 0 };
    }

    if (
      mustFilterByLeadIds &&
      LeadModel &&
      typeof LeadModel.find === "function" &&
      mongoose.connection &&
      mongoose.connection.readyState === 1
    ) {
      try {
        const matchingLeadIds = await LeadModel.find(leadFilter).distinct("_id");
        conversationQuery.leadId = { $in: matchingLeadIds };
      } catch (err) {
        console.warn("[getConversations] Lead pre-filtering warning:", err.message);
      }
    }

    const total =
      typeof ConversationModel.countDocuments === "function"
        ? await ConversationModel.countDocuments(conversationQuery)
        : null;

    let query = ConversationModel.find(conversationQuery).populate(populateOptions);

    if (query && typeof query.sort === "function") {
      query = query.sort({ lastMessageTime: -1 });
    }
    if (query && typeof query.skip === "function") {
      query = query.skip(skip);
    }
    if (query && typeof query.limit === "function") {
      query = query.limit(limit);
    }

    let conversations = (await query) || [];

    // Filter out conversations where leadId is null (due to population match failure or deleted lead)
    if (isSalesRep || req.query.userId || req.query.name || search) {
      conversations = conversations.filter((c) => c.leadId != null);
    }

    const effectiveTotal = total !== null ? total : conversations.length;
    const hasMore = effectiveTotal > skip + conversations.length;

    res.status(200).json({
      success: true,
      conversations,
      total: effectiveTotal,
      page,
      limit,
      hasMore,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get messages for a specific lead
// @route   GET /api/whatsapp/conversation/:leadId
// @access  Public
export const getMessages = async (req, res) => {
  try {
    const { leadId } = req.params;
    if (!leadId) {
      return res.status(400).json({ message: "leadId is required." });
    }

    const { ConversationModel, MessageModel, LeadModel } = getModels(req);

    // 1. Try finding by LeadModel first
    let lead = null;
    if (mongoose.Types.ObjectId.isValid(leadId)) {
      lead = await LeadModel.findById(leadId).select("assignedTo phone").lean();
    }

    if (lead) {
      if (req.user?.role === "sales person") {
        const repId = req.user._id.toString();
        const repName = req.user.name;
        const isAssigned =
          lead.assignedTo?.toString() === repId ||
          (repName && lead.assignedTo === repName);
        if (!isAssigned) {
          return res.status(403).json({
            message: "Access denied. You are not assigned to this conversation.",
          });
        }
      }

      // Reset unread count for this conversation since the agent is loading it
      await ConversationModel.findOneAndUpdate({ leadId }, { unreadCount: 0 });

      const messages = await MessageModel.find({ leadId }).sort({ timestamp: 1 });
      return res.status(200).json(messages);
    }

    // 2. Fallback: check if leadId corresponds to a Prospect / Non-Lead Conversation
    const convConditions = [];
    if (mongoose.Types.ObjectId.isValid(leadId)) {
      convConditions.push({ _id: leadId });
      convConditions.push({ leadId });
    }
    const cleanPhone = String(leadId).replace(/\D/g, "");
    if (cleanPhone.length >= 10) {
      convConditions.push({ phone: cleanPhone });
      const last10 = cleanPhone.slice(-10);
      convConditions.push({ phone: "91" + last10 });
      convConditions.push({ phone: last10 });
    }

    const conversation = await ConversationModel.findOne({
      $or: convConditions,
    }).lean();

    if (!conversation) {
      return res.status(404).json({ message: "Lead not found." });
    }

    // If conversation is linked to a lead that wasn't found by direct ID
    if (conversation.leadId) {
      const linkedLead = await LeadModel.findById(conversation.leadId).select("assignedTo phone").lean();
      if (linkedLead) {
        if (req.user?.role === "sales person") {
          const repId = req.user._id.toString();
          const repName = req.user.name;
          const isAssigned =
            linkedLead.assignedTo?.toString() === repId ||
            (repName && linkedLead.assignedTo === repName);
          if (!isAssigned) {
            return res.status(403).json({
              message: "Access denied. You are not assigned to this conversation.",
            });
          }
        }

        await ConversationModel.findByIdAndUpdate(conversation._id, { unreadCount: 0 });
        const messages = await MessageModel.find({
          $or: [{ leadId: conversation.leadId }, { leadId: conversation._id }],
        }).sort({ timestamp: 1 });
        return res.status(200).json(messages);
      }
    }

    // Non-lead prospect conversation (isLead: false):
    if (req.user?.role === "sales person") {
      return res.status(403).json({
        message: "Access denied. You are not assigned to this prospect conversation.",
      });
    }

    // Reset unread count
    await ConversationModel.findByIdAndUpdate(conversation._id, { unreadCount: 0 });

    const messageConditions = [{ leadId: conversation._id }];
    if (conversation.phone) {
      messageConditions.push({ contactPhone: conversation.phone });
      messageConditions.push({ to: conversation.phone });
      messageConditions.push({ from: conversation.phone });
      const last10 = conversation.phone.slice(-10);
      if (last10 && last10 !== conversation.phone) {
        messageConditions.push({ contactPhone: last10 });
        messageConditions.push({ to: last10 });
        messageConditions.push({ from: last10 });
      }
    }

    const messages = await MessageModel.find({
      $or: messageConditions,
    }).sort({ timestamp: 1 });

    return res.status(200).json(messages);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Send manual WhatsApp message
// @route   POST /api/whatsapp/message/send
// @access  Protected
export const sendMessage = async (req, res) => {
  try {
    const { leadId, text, senderName } = req.body;
    if (!leadId || !text) {
      return res
        .status(400)
        .json({ message: "leadId and text are required fields." });
    }

    const { LeadModel, MessageModel, UserModel, ConversationModel } = getModels(req);
    let lead = null;
    let prospectConversation = null;

    if (mongoose.Types.ObjectId.isValid(leadId)) {
      lead = await LeadModel.findById(leadId).lean();
    }

    if (!lead) {
      const convQuery = [];
      if (mongoose.Types.ObjectId.isValid(leadId)) {
        convQuery.push({ _id: leadId });
      }
      const cleanP = String(leadId).replace(/\D/g, "");
      if (cleanP.length >= 10) {
        convQuery.push({ phone: cleanP });
        convQuery.push({ phone: "91" + cleanP.slice(-10) });
      }
      if (convQuery.length > 0) {
        prospectConversation = await ConversationModel.findOne({ $or: convQuery }).lean();
      }
      if (!prospectConversation) {
        return res.status(404).json({ message: "Lead not found." });
      }
    }

    const senderRole = req.user?.role;
    const orgId = req.user?.organizationId
      ? req.user.organizationId.toString()
      : req.organization?._id
        ? req.organization._id.toString()
        : null;

    if (prospectConversation) {
      if (senderRole === "sales person") {
        return res.status(403).json({
          message: "Access denied. Only managers can send messages to prospect conversations.",
        });
      }
      let targetSessionId = req.body.sessionId || (orgId ? `org_${orgId}` : null);
      const messageRecord = await sendMessageFromCRM(
        prospectConversation._id,
        text,
        senderName || req.user?.name || "Manager",
        {
          organizationId: orgId,
          tenantModels: req.tenantModels,
          sessionId: targetSessionId,
        }
      );
      return res.status(200).json(messageRecord);
    }

    // Check if conversation/lead belongs to a sales rep in the database
    let isRepOwned = false;
    if (lead.assignedTo && lead.assignedTo !== "Unassigned") {
      if (mongoose.Types.ObjectId.isValid(lead.assignedTo)) {
        const assignedUser = await UserModel.findById(lead.assignedTo).select("role").lean();
        if (assignedUser?.role === "sales person") isRepOwned = true;
      } else if (typeof lead.assignedTo === "string") {
        const assignedUser = await UserModel.findOne({ name: lead.assignedTo }).select("role").lean();
        if (assignedUser?.role === "sales person") isRepOwned = true;
      }
    }
    if (!isRepOwned) {
      const repMessage = await MessageModel.findOne({
        leadId,
        $or: [
          { salesRepId: { $ne: null } },
          { sessionId: { $regex: "_user_" } },
        ],
      }).select("_id").lean();
      if (repMessage) isRepOwned = true;
    }

    // ================================================================
    // ADMIN VIEW-ONLY ENFORCEMENT
    // Admins and Sales Managers have strictly VIEW-ONLY access to
    // sales representative conversations, regardless of request payload.
    // ================================================================
    if (senderRole === "sales manager" || senderRole === "super_admin") {
      if (isRepOwned) {
        return res.status(403).json({
          message:
            "Administrators have View-Only access to sales representative WhatsApp conversations. Only the assigned Sales Representative can send messages.",
        });
      }
    }

    // ================================================================
    // SALES REP ASSIGNMENT ENFORCEMENT
    // Sales reps can ONLY send messages to leads assigned to them.
    // ================================================================
    let targetSessionId = req.body.sessionId;
    if (senderRole === "sales person") {
      const repId = req.user._id.toString();
      const repName = req.user.name;
      const isAssigned =
        lead.assignedTo?.toString() === repId ||
        (repName && lead.assignedTo === repName);

      if (!isAssigned) {
        return res.status(403).json({
          message:
            "Access denied. You are only authorized to send messages to leads assigned to you.",
        });
      }

      // Always route to the sales rep's personal session
      targetSessionId = orgId ? `org_${orgId}_user_${repId}` : `user_${repId}`;
    } else if (orgId) {
      targetSessionId = `org_${orgId}`;
    }

    // ================================================================
    // META CLOUD API COEXISTENCE OUTBOUND ROUTING
    // ================================================================
    let waAccount = null;
    if (orgId) {
      if (senderRole === "sales person") {
        waAccount = await WAAccount.findOne({
          organizationId: orgId,
          userId: req.user._id,
          status: { $in: ["connected", "syncing"] },
        });
      }
      if (!waAccount) {
        waAccount = await WAAccount.findOne({
          organizationId: orgId,
          userId: null,
          status: { $in: ["connected", "syncing"] },
        });
      }
    }

    if (waAccount && waAccount.accessTokenEncrypted) {
      // 24-hour customer service window check
      const now = new Date();
      const serviceExpires = lead.serviceWindowExpiresAt
        ? new Date(lead.serviceWindowExpiresAt)
        : lead.lastCloudInboundAt
        ? new Date(new Date(lead.lastCloudInboundAt).getTime() + 24 * 60 * 60 * 1000)
        : null;

      const isWindowExpired = serviceExpires && now.getTime() > serviceExpires.getTime();

      if (isWindowExpired) {
        return res.status(400).json({
          success: false,
          windowExpired: true,
          message:
            "The 24-hour customer service window has expired. WhatsApp policy requires sending an approved template to initiate contact.",
        });
      }

      const accessToken = decryptApiKey(waAccount.accessTokenEncrypted);
      const cleanPhone = (lead.phone || "").replace(/\D/g, "");

      const sendResult = await sendTextMessage({
        phoneNumberId: waAccount.phoneNumberId,
        accessToken,
        toPhone: cleanPhone,
        textBody: text,
      });

      const messageRecord = await MessageModel.create({
        messageId: sendResult.metaMessageId || `out_cloud_${Date.now()}`,
        wamid: sendResult.metaMessageId || null,
        leadId,
        sender: senderName || req.user?.name || "Agent",
        senderName: senderName || req.user?.name || "Agent",
        direction: "outgoing",
        messageType: "text",
        text,
        timestamp: new Date(),
        source: "cloud_api",
        status: "sent",
        salesRepId: waAccount.userId || (senderRole === "sales person" ? req.user._id : null),
      });

      const { ConversationModel } = getModels(req);
      await ConversationModel.findOneAndUpdate(
        { leadId },
        {
          lastMessage: text,
          lastMessageTime: new Date(),
        },
        { upsert: true }
      );

      const io = getIO();
      if (io) {
        io.to(leadId.toString()).emit("new_message", messageRecord);
        if (orgId) {
          io.to(`org_${orgId}`).emit("conversation_updated", {
            leadId,
            lastMessage: text,
            lastMessageTime: new Date(),
          });
        }
      }

      return res.status(200).json(messageRecord);
    }

    // No active WhatsApp Cloud API connection found
    return res.status(400).json({
      success: false,
      message:
        "No active WhatsApp Cloud API connection found for this organization. Please connect your WhatsApp Business account via Meta Embedded Signup.",
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Send WhatsApp document (PDF/Word) with text/caption
// @route   POST /api/whatsapp/send-document
// @access  Protected / Tenant Webhook API
export const sendDocumentMessage = async (req, res) => {
  try {
    const file = req.file;
    const fileUrl = req.body?.fileUrl || req.body?.documentUrl;

    if (!file && !fileUrl) {
      return res.status(400).json({
        success: false,
        message: "A document file (.pdf, .docx, .doc) or valid fileUrl is required.",
      });
    }

    const phoneOrLeadId =
      req.body?.phone ||
      req.body?.phoneNumber ||
      req.body?.mobile ||
      req.body?.to ||
      req.body?.leadId;

    if (!phoneOrLeadId) {
      return res.status(400).json({
        success: false,
        message: "Recipient phone number or leadId is required.",
      });
    }

    // Resolve organization
    let orgId = req.user?.organizationId
      ? req.user.organizationId.toString()
      : req.organization?._id
        ? req.organization._id.toString()
        : null;

    if (!orgId) {
      const { Organization } = getMasterModels();
      const secretOrKey =
        req.headers["x-webhook-secret"] ||
        req.headers["x-api-key"] ||
        req.query?.secret ||
        req.query?.apiKey ||
        req.body?.secret ||
        req.body?.apiKey;

      if (secretOrKey) {
        const orgBySecret = await Organization.findOne({ webhookKey: secretOrKey });
        if (orgBySecret) {
          orgId = orgBySecret._id.toString();
          req.organization = orgBySecret;
          const { getTenantModels } = await import("../services/tenantManager.js");
          req.tenantModels = await getTenantModels(orgBySecret.tenantDbName);
        }
      }
    }

    if (!orgId) {
      return res.status(401).json({
        success: false,
        message: "Organization authentication required. Please provide a valid Bearer token, x-webhook-secret, or x-api-key.",
      });
    }

    const captionText = req.body?.caption || req.body?.text || req.body?.message || "";
    const senderName = req.body?.senderName || req.user?.name || req.organization?.name || "Organization";

    let targetSessionId = req.body?.sessionId;
    const senderRole = req.user?.role;
    let salesRepId = null;

    if (senderRole === "sales person" && req.user?._id) {
      salesRepId = req.user._id.toString();
      targetSessionId = `org_${orgId}_user_${salesRepId}`;
    } else if (orgId && !targetSessionId) {
      targetSessionId = `org_${orgId}`;
    }

    const documentData = file
      ? {
          filePath: file.path,
          fileName: req.body?.fileName || file.originalname,
          originalName: file.originalname,
          mimetype: file.mimetype,
          mediaUrl: `/uploads/documents/${file.filename}`,
        }
      : {
          fileUrl,
          fileName: req.body?.fileName || "document.pdf",
        };

    const result = await sendDocumentMessageFromCRM(
      phoneOrLeadId,
      documentData,
      captionText,
      senderName,
      {
        organizationId: orgId,
        tenantModels: req.tenantModels,
        sessionId: targetSessionId,
        salesRepId,
        recipientName: req.body?.recipientName || req.body?.name || "",
      }
    );

    return res.status(200).json({
      success: true,
      message: "WhatsApp document sent successfully",
      data: result,
    });
  } catch (error) {
    console.error("[WhatsApp sendDocumentMessage error]:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to send WhatsApp document",
    });
  }
};

// @desc    Toggle AI status for a lead
// @route   POST /api/whatsapp/ai/toggle
// @access  Public
export const toggleAI = async (req, res) => {
  try {
    const { leadId, aiEnabled } = req.body;
    if (leadId === undefined || aiEnabled === undefined) {
      return res
        .status(400)
        .json({ message: "leadId and aiEnabled are required fields." });
    }

    const { LeadModel } = getModels(req);

    const lead = await LeadModel.findById(leadId);
    if (!lead) {
      return res.status(404).json({ message: "Lead not found" });
    }

    // Role-based / lead assignment check: sales reps can only toggle AI for assigned leads
    if (req.user?.role === "sales person" && !req.user?.isOrgOwner) {
      if (!isLeadAssignedToUser(lead, req.user)) {
        return res.status(403).json({
          message: "Access denied: You are not assigned to this lead.",
        });
      }
    }

    lead.aiEnabled = aiEnabled;
    if (aiEnabled) {
      lead.aiPausedUntil = null;
    }
    await lead.save();

    // Cancel the in-memory pause timer if enabling AI
    if (aiEnabled) {
      try {
        const orgId = req.user?.organizationId || req.organization?._id;
        await clearAIPauseForLead(leadId, req.tenantModels, orgId);
      } catch (clearErr) {
        console.warn("Error clearing AI pause timer:", clearErr.message);
      }
    }

    res.status(200).json({
      message: `AI response state set to ${aiEnabled} for ${lead.name}`,
      lead,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Test AI Response without WhatsApp
// @route   POST /api/whatsapp/test-ai
// @access  Public
export const testAI = async (req, res) => {
  try {
    // Role check: sales reps cannot access test AI or reset leads
    if (req.user?.role === "sales person" && !req.user?.isOrgOwner) {
      return res.status(403).json({
        message: "Access denied: Only managers and administrators can access AI testing.",
      });
    }

    const { message, leadId, reset } = req.body;
    const { LeadModel, MessageModel } = getModels(req);

    if (!message && !reset) {
      return res.status(400).json({ message: "message is required." });
    }

    let lead;
    if (leadId) {
      lead = await LeadModel.findById(leadId);
      if (!lead) {
        return res.status(404).json({ message: "Lead not found" });
      }

      // Check lead assignment/ownership if caller is sales rep
      if (req.user?.role === "sales person" && !req.user?.isOrgOwner) {
        if (!isLeadAssignedToUser(lead, req.user)) {
          return res.status(403).json({
            message: "Access denied: You are not assigned to this lead.",
          });
        }
        if (reset) {
          return res.status(403).json({
            message: "Access denied: Sales representatives cannot reset lead data.",
          });
        }
      }
    } else {
      // Find or create dummy lead
      lead = await LeadModel.findOne({ phone: "0000000000" });
      if (!lead) {
        lead = await LeadModel.create({
          name: "Test User",
          phone: "0000000000",
          service: "General Enquiry",
          source: "Manual Entry",
        });
      }
    }

    if (!lead) {
      return res.status(404).json({ message: "Lead not found" });
    }

    if (reset) {
      await MessageModel.deleteMany({ leadId: lead._id });
      const resetQual = {
        city: "",
        intent: "",
        urgency: "Medium",
        interestScore: 0,
        preferredCallDate: "",
        preferredCallTime: "",
      };
      const configuredFields = req.organization?.aiSettings?.qualificationFields;
      if (Array.isArray(configuredFields) && configuredFields.length > 0) {
        for (const f of configuredFields) {
          if (f.key) resetQual[f.key] = "";
        }
      }
      await LeadModel.findByIdAndUpdate(lead._id, {
        aiQualification: resetQual,
        aiEnabled: true,
        disableAI: false,
      });

      try {
        const FollowupModel =
          req.tenantModels?.Followup || (await import("../models/Followup.js")).default;
        await FollowupModel.deleteMany({ leadId: lead._id });
      } catch (err) {
        console.warn("Error cleaning up test lead followups:", err.message);
      }

      return res.status(200).json({ message: "Test lead reset successfully." });
    }

    const { generateAIResponse } = await import("../ai/aiService.js");

    // Save incoming
    const incoming = await MessageModel.create({
      messageId: `test-in-${Date.now()}`,
      sender: lead.phone,
      leadId: lead._id,
      text: message,
      direction: "incoming",
      timestamp: new Date(),
    });

    const aiResponseResult = await generateAIResponse(
      lead._id,
      message,
      req.tenantModels,
      req.organization,
    );
    const aiResponseText =
      typeof aiResponseResult === "object" && aiResponseResult !== null
        ? aiResponseResult.reply
        : aiResponseResult;

    // Save outgoing
    const outgoing = await MessageModel.create({
      messageId: `test-out-${Date.now()}`,
      sender: "AI Agent",
      leadId: lead._id,
      text: aiResponseText,
      direction: "outgoing",
      timestamp: new Date(),
    });

    const updatedLead = await LeadModel.findById(lead._id);

    res.status(200).json({
      incoming,
      outgoing,
      aiQualification: updatedLead.aiQualification,
      qualificationFields: req.organization?.aiSettings?.qualificationFields || [],
      leadId: lead._id,
      sendServiceImages:
        typeof aiResponseResult === "object" && aiResponseResult !== null
          ? aiResponseResult.sendServiceImages || null
          : null,
      serviceImages:
        typeof aiResponseResult === "object" && aiResponseResult !== null
          ? aiResponseResult.serviceImagesToSend || []
          : [],
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getTestAIHistory = async (req, res) => {
  try {
    if (req.user?.role === "sales person" && !req.user?.isOrgOwner) {
      return res.status(403).json({
        message: "Access denied: Only managers and administrators can access AI testing.",
      });
    }

    const { LeadModel, MessageModel } = getModels(req);
    let lead = await LeadModel.findOne({ phone: "0000000000" });
    if (!lead) {
      lead = await LeadModel.create({
        name: "Test User",
        phone: "0000000000",
        service: "General Enquiry",
        source: "Manual Entry",
      });
    }

    const messages = await MessageModel.find({ leadId: lead._id }).sort({
      timestamp: 1,
    });

    res.status(200).json({
      leadId: lead._id,
      aiQualification: lead.aiQualification,
      qualificationFields: req.organization?.aiSettings?.qualificationFields || [],
      messages: messages.map((m) => ({
        text: m.text,
        role: m.direction === "incoming" ? "user" : "ai",
      })),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getGlobalSettings = async (req, res) => {
  try {
    const settings = await getSystemSettings(req.tenantModels);
    const orgId = req.user?.organizationId || req.organization?._id;
    let orgData = null;
    if (orgId) {
      const { Organization } = getMasterModels();
      orgData = await Organization.findById(orgId).select("name aiSettings").lean();
    }
    const companyName = orgData?.aiSettings?.companyName || orgData?.name || "";
    const primaryService = orgData?.aiSettings?.services?.[0]?.name || "";
    const effectiveTemplate =
      settings.welcomeMessageTemplate || orgData?.aiSettings?.welcomeMessageTemplate || "";
    const effectiveFallbackService =
      settings.welcomeMessageFallbackService || orgData?.aiSettings?.welcomeMessageFallbackService || "";

    const userRepEnabled = req.user?.aiAutoReplyEnabled !== false;
    const isMasterDisabled = !settings.globalAIEnabled;
    const effectiveAIEnabled = Boolean(settings.globalAIEnabled && userRepEnabled);

    let teamRepAISettings = [];
    const isManagerOrAdmin =
      req.user?.role === "sales manager" ||
      req.user?.role === "super_admin" ||
      req.user?.isOrgOwner;

    if (isManagerOrAdmin) {
      try {
        const { UserModel } = getModels(req);
        if (UserModel && typeof UserModel.find === "function") {
          const reps = await UserModel.find({
            role: "sales person",
            status: { $ne: "inactive" },
          })
            .select("name email phone aiAutoReplyEnabled")
            .lean();
          teamRepAISettings = (reps || []).map((r) => ({
            id: r._id.toString(),
            name: r.name,
            email: r.email,
            phone: r.phone,
            aiAutoReplyEnabled: r.aiAutoReplyEnabled !== false,
          }));
        }
      } catch (repErr) {
        console.warn("[getGlobalSettings] Error fetching rep AI statuses:", repErr.message);
      }
    }

    res.status(200).json({
      success: true,
      data: {
        ...settings,
        welcomeMessageTemplate: effectiveTemplate,
        welcomeMessageFallbackService: effectiveFallbackService,
        companyName,
        primaryService,
        defaultTemplate: DEFAULT_WELCOME_MESSAGE_TEMPLATE,
        repAIEnabled: userRepEnabled,
        isMasterDisabled,
        effectiveAIEnabled,
        teamRepAISettings,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Toggle individual sales representative AI Auto-Reply setting
// @route   POST /api/whatsapp/my-ai-toggle
// @access  Protected (Sales rep toggles own; Manager can toggle own or any rep)
export const toggleMyAIAutoReply = async (req, res) => {
  try {
    const isManagerOrAdmin =
      req.user?.role === "sales manager" ||
      req.user?.role === "super_admin" ||
      req.user?.isOrgOwner;

    let targetUserId = req.user?._id;

    if (req.body?.repId) {
      if (!isManagerOrAdmin && req.body.repId.toString() !== req.user?._id?.toString()) {
        return res.status(403).json({
          success: false,
          message: "Access forbidden: You can only manage your own AI auto-reply setting.",
        });
      }
      targetUserId = req.body.repId;
    }

    if (!targetUserId) {
      return res.status(400).json({ success: false, message: "User ID is required." });
    }

    const { UserModel } = getModels(req);
    const existingUser = await UserModel.findById(targetUserId);
    if (!existingUser) {
      return res.status(404).json({ success: false, message: "Representative not found." });
    }

    let newStatus;
    if (req.body?.enabled !== undefined) {
      newStatus = Boolean(req.body.enabled);
    } else if (req.body?.aiAutoReplyEnabled !== undefined) {
      newStatus = Boolean(req.body.aiAutoReplyEnabled);
    } else {
      newStatus = existingUser.aiAutoReplyEnabled === false ? true : false;
    }

    existingUser.aiAutoReplyEnabled = newStatus;
    if (typeof existingUser.save === "function") {
      await existingUser.save();
    } else if (typeof UserModel.findByIdAndUpdate === "function") {
      await UserModel.findByIdAndUpdate(targetUserId, { aiAutoReplyEnabled: newStatus });
    }

    // Also sync to master AuthUser if database is connected
    if (mongoose.connection?.readyState === 1) {
      try {
        const { AuthUser } = getMasterModels();
        if (AuthUser && typeof AuthUser.findByIdAndUpdate === "function") {
          await AuthUser.findByIdAndUpdate(targetUserId, {
            aiAutoReplyEnabled: newStatus,
          });
        }
      } catch (mErr) {
        console.warn("[toggleMyAIAutoReply] Error updating master AuthUser:", mErr.message);
      }
    }

    // Emit real-time notification
    try {
      const io = getIO();
      const orgId = req.user?.organizationId || req.organization?._id;
      if (io) {
        const payload = {
          userId: targetUserId.toString(),
          aiAutoReplyEnabled: newStatus,
        };
        io.to(`user_${targetUserId}`).emit("rep_ai_settings_updated", payload);
        if (orgId) {
          io.to(`org_${orgId}`).emit("rep_ai_settings_updated", payload);
        }
      }
    } catch (ioErr) {
      console.warn("[toggleMyAIAutoReply] Error emitting socket update:", ioErr.message);
    }

    res.status(200).json({
      success: true,
      data: {
        userId: targetUserId.toString(),
        aiAutoReplyEnabled: newStatus,
      },
      message: newStatus
        ? "AI auto-reply enabled for your assigned leads."
        : "AI auto-reply paused for your assigned leads.",
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const updateGlobalSettings = async (req, res) => {
  try {
    if (req.user?.role === "sales person" && !req.user?.isOrgOwner) {
      return res.status(403).json({
        success: false,
        message: "Access denied: Only managers or administrators can update global WhatsApp settings.",
      });
    }

    const updates = req.body || {};
    const updatedBy = req.user?.name || "Dashboard User";
    const orgId = req.user?.organizationId
      ? req.user.organizationId.toString()
      : req.organization?._id
        ? req.organization._id.toString()
        : null;
    const settings = await updateSystemSettings(updates, updatedBy, req.tenantModels, orgId);
    res.status(200).json({ success: true, data: settings });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    AI Chat Summarization — analyze and summarize a lead's WhatsApp conversation
// @route   POST /api/whatsapp/conversation/:leadId/summarize
// @access  Protected
export const summarizeConversation = async (req, res) => {
  try {
    const { leadId } = req.params;
    const { forceRefresh } = req.body;

    if (!leadId) {
      return res.status(400).json({ success: false, message: "leadId is required." });
    }

    const { ConversationModel, LeadModel } = getModels(req);

    // Security: Check lead existence and sales rep assignment
    const lead = await LeadModel.findById(leadId).select("assignedTo").lean();
    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found." });
    }

    if (req.user?.role === "sales person") {
      const repId = req.user._id.toString();
      const repName = req.user.name;
      const isAssigned =
        lead.assignedTo?.toString() === repId ||
        (repName && lead.assignedTo === repName);
      if (!isAssigned) {
        return res.status(403).json({
          success: false,
          message: "Access denied. You are not authorized to summarize this conversation.",
        });
      }
    }

    // Force refresh: clear any existing cached summary so the service re-generates
    if (forceRefresh) {
      await ConversationModel.findOneAndUpdate(
        { leadId },
        { $unset: { chatSummary: 1 } }
      );
    }

    const { summarizeChatConversation } = await import("../ai/aiService.js");
    const summary = await summarizeChatConversation({
      leadId,
      tenantModels: req.tenantModels,
      organization: req.organization,
    });

    res.status(200).json({ success: true, data: summary });
  } catch (error) {
    // console.error("[WhatsApp] summarizeConversation error:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get WhatsApp connection status for all sales reps (Admin/Manager overview)
// @route   GET /api/whatsapp/team-status
// @access  Protected (Admin / Sales Manager only)
export const getTeamWhatsAppStatuses = async (req, res) => {
  try {
    // Only admins and managers can access team WhatsApp statuses
    const role = (req.user?.role || "").toLowerCase().trim();
    const isManagerOrAdmin =
      role === "sales manager" ||
      role === "super_admin" ||
      role === "super admin" ||
      role === "admin" ||
      Boolean(req.user?.isOrgOwner);

    if (!isManagerOrAdmin) {
      return res.status(403).json({
        success: false,
        message: "Access denied: Manager or Administrator privileges required.",
      });
    }

    const orgId = req.user?.organizationId?.toString() || req.organization?._id?.toString();
    if (!orgId) {
      return res.status(400).json({ success: false, message: "Organization context is required." });
    }

    const { UserModel, WhatsAppSessionModel } = getModels(req);

    // Fetch all active sales reps (case-insensitive and handles spelling variations)
    const reps = await UserModel.find({
      role: { $regex: /^sales\s*(person|rep)/i },
      status: "active",
    })
      .select("name phone email _id")
      .lean();

    let accounts = [];
    if (mongoose.connection?.readyState === 1 || req.tenantModels?.WAAccount) {
      try {
        const AccountModel = req.tenantModels?.WAAccount || WAAccount;
        if (AccountModel && AccountModel.find) {
          accounts = await AccountModel.find({ organizationId: orgId }).lean();
        }
      } catch (e) {}
    }

    const result = await Promise.all(
      reps.map(async (rep) => {
        const repSessionId = `org_${orgId}_user_${rep._id.toString()}`;
        const repAccount = accounts.find(
          (a) => a.userId && a.userId.toString() === rep._id.toString()
        );
        let dbSession = null;
        try {
          if (WhatsAppSessionModel && WhatsAppSessionModel.findOne) {
            dbSession = await WhatsAppSessionModel.findOne({ sessionId: repSessionId })
              .select("status connectedPhone connectedName updatedAt errorMessage")
              .lean();
          }
        } catch (e) {}

        const status = repAccount?.status || dbSession?.status || "disconnected";
        const connectedPhone = repAccount?.displayPhone || dbSession?.connectedPhone || "";
        const connectedName = repAccount?.businessName || dbSession?.connectedName || "";

        return {
          userId: rep._id,
          name: rep.name || "Unknown",
          email: rep.email || "",
          profilePhone: rep.phone || "",
          sessionId: repSessionId,
          status,
          connectedPhone,
          connectedName,
          lastSeen: repAccount?.updatedAt || dbSession?.updatedAt || null,
          errorMessage: dbSession?.errorMessage || "",
          isCoexistence: true,
        };
      })
    );

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    // console.error("[WhatsApp] getTeamWhatsAppStatuses error:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};
