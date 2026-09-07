import Lead from "../models/Lead.js";
import Message from "../models/Message.js";
import Conversation from "../models/Conversation.js";
import WhatsAppSession from "../models/WhatsAppSession.js";
import {
  connectWhatsApp,
  logoutWhatsApp,
  getWhatsAppStatus,
  sendMessageFromCRM,
  getSystemSettings,
  updateSystemSettings,
} from "../whatsapp/whatsappService.js";

const getModels = (req) => ({
  LeadModel: req.tenantModels?.Lead || Lead,
  MessageModel: req.tenantModels?.Message || Message,
  ConversationModel: req.tenantModels?.Conversation || Conversation,
  WhatsAppSessionModel: req.tenantModels?.WhatsAppSession || WhatsAppSession,
});

// @desc    Connect WhatsApp (starts Baileys client initialization)
// @route   POST /api/whatsapp/connect
// @access  Public
export const connectClient = async (req, res) => {
  try {
    const { sessionId } = req.body;
    connectWhatsApp(sessionId);
    res.status(200).json({ message: "WhatsApp connection worker started." });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get WhatsApp connection status
// @route   GET /api/whatsapp/status
// @access  Public
export const getStatus = async (req, res) => {
  try {
    const { WhatsAppSessionModel } = getModels(req);
    const memoryStatuses = getWhatsAppStatus(); // Now returns an array
    const dbSessions = await WhatsAppSessionModel.find();

    const result = memoryStatuses.map((mem) => {
      const db = dbSessions.find((s) => s.sessionId === mem.sessionId);
      const status = mem.status || db?.status || "disconnected";
      return {
        sessionId: mem.sessionId,
        status: status,
        qrCode: status === "qr" ? mem.qrCode || db?.qrCode || "" : "",
        connectedPhone: mem.connectedPhone || db?.connectedPhone || "",
        connectedName: mem.connectedName || db?.connectedName || "",
      };
    });

    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Disconnect WhatsApp and delete credentials
// @route   POST /api/whatsapp/logout
// @access  Public
export const logoutClient = async (req, res) => {
  try {
    const { sessionId } = req.body;
    await logoutWhatsApp(sessionId);
    res
      .status(200)
      .json({ message: "WhatsApp disconnected and logged out successfully." });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get current active QR code image string
// @route   GET /api/whatsapp/qr
// @access  Public
export const getQR = async (req, res) => {
  try {
    const statusData = getWhatsAppStatus();
    res.status(200).json({ qrCode: statusData.qrCode });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all WhatsApp conversations
// @route   GET /api/whatsapp/conversations
// @access  Public
export const getConversations = async (req, res) => {
  try {
    const { role, name } = req.query;
    const { ConversationModel } = getModels(req);

    const populateOptions = { path: "leadId" };

    if (role === "Sales Representative" && name) {
      populateOptions.match = {
        assignedTo: { $regex: new RegExp("^" + name + "$", "i") },
      };
    }

    let conversations = await ConversationModel.find()
      .populate(populateOptions)
      .sort({ lastMessageTime: -1 });

    // Filter out conversations where leadId is null (due to population match failure)
    if (role === "Sales Representative" && name) {
      conversations = conversations.filter((c) => c.leadId != null);
    }

    res.status(200).json(conversations);
  } catch (error) {
    res.status(500).json({ message: error.message });
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

    const { ConversationModel, MessageModel } = getModels(req);

    // Reset unread count for this conversation since the agent is loading it
    await ConversationModel.findOneAndUpdate({ leadId }, { unreadCount: 0 });

    const messages = await MessageModel.find({ leadId }).sort({ timestamp: 1 });
    res.status(200).json(messages);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Send manual WhatsApp message
// @route   POST /api/whatsapp/message/send
// @access  Public
export const sendMessage = async (req, res) => {
  try {
    const { leadId, text, senderName } = req.body;
    if (!leadId || !text) {
      return res
        .status(400)
        .json({ message: "leadId and text are required fields." });
    }

    const messageRecord = await sendMessageFromCRM(leadId, text, senderName);
    res.status(200).json(messageRecord);
  } catch (error) {
    res.status(500).json({ message: error.message });
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
    const lead = await LeadModel.findByIdAndUpdate(
      leadId,
      { aiEnabled },
      { new: true },
    );

    if (!lead) {
      return res.status(404).json({ message: "Lead not found" });
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
    const { message, leadId, reset } = req.body;
    const { LeadModel, MessageModel } = getModels(req);

    if (!message && !reset) {
      return res.status(400).json({ message: "message is required." });
    }

    let lead;
    if (leadId) {
      lead = await LeadModel.findById(leadId);
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
      await LeadModel.findByIdAndUpdate(lead._id, {
        aiQualification: {
          liftType: "",
          clientType: "General",
          propertyType: "",
          numberOfFloors: "",
          capacity: "",
          constructionStage: "",
          doorType: "",
          machineRoomAvailable: "",
          propertySize: "",
          issueDescription: "",
          preferredVisitDate: "",
          preferredCallDate: "",
          preferredCallTime: "",
          city: "",
          intent: "",
          budget: "",
          urgency: "",
          interestScore: 0,
        },
        aiEnabled: true,
        disableAI: false,
      });
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

    const aiResponseText = await generateAIResponse(lead._id, message);

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
      leadId: lead._id,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getTestAIHistory = async (req, res) => {
  try {
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
    const settings = await getSystemSettings();
    res.status(200).json({ success: true, data: settings });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const updateGlobalSettings = async (req, res) => {
  try {
    const updates = req.body || {};
    const updatedBy = req.user?.name || "Dashboard User";
    const settings = await updateSystemSettings(updates, updatedBy);
    res.status(200).json({ success: true, data: settings });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
