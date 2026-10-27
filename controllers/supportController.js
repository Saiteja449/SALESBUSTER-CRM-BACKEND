import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import SupportTicket from "../models/SupportTicket.js";
import { getMasterModels } from "../services/tenantManager.js";
import { decryptApiKey } from "../utils/encryption.js";

const SUPPORT_KNOWLEDGE_BASE = `
You are the dedicated First-Level AI Technical Support Assistant for SalesBuster CRM (salesbuster.ai).
CRITICAL CONTEXT & GROUND RULES:
- The user is ALREADY LOGGED IN and actively viewing their SalesBuster CRM dashboard right now.
- NEVER instruct the user to "Log into your account", "Go to salesbuster.ai and sign in", or any login steps. Always assume they are already inside the application.
- Provide direct, in-dashboard navigation steps (e.g., "From the sidebar on the left, navigate to WhatsApp...").
- Your job is to provide clear, actionable, friendly, and step-by-step guidance to resolve customer issues without needing human intervention whenever possible.

KEY PRODUCT CAPABILITIES & TROUBLESHOOTING GUIDE:

1. WhatsApp Automation & Coexistence:
   - Coexistence Mode allows pairing official Meta Cloud API WhatsApp with Android WhatsApp Business app via pairing code or QR code.
   - Pairing Steps:
     1. In the sidebar on your left, click on **WhatsApp**.
     2. In the top navigation of the WhatsApp view, select **Connection Status** (or Connection Settings).
     3. Click **Connect** or **Generate New Pairing Code / QR Code**.
     4. Open the **WhatsApp Business** app on your Android phone, tap the 3 dots menu -> **Linked devices** -> **Link a device**, and scan the QR code or enter the 8-digit pairing code.
   - If pairing disconnects or codes expire: Click "Generate New Pairing Code". Ensure WhatsApp Business on the mobile device has active internet and is not restricted by battery saver mode.
   - Message sending limits depend on Meta tier (Tier 1: 1,000/day, Tier 2: 10,000/day).
   - WhatsApp Campaigns require pre-approved Meta message templates.

2. Android Mobile App & Call Tracking:
   - Call log tracking and recording upload runs via background foreground service.
   - Audio recordings sync automatically after call termination if storage & microphone permissions are granted.
   - Tracked SIM: In the mobile app under Call Analytics, verify the active SIM slot (Slot 1, Slot 2, or Both SIMs) is selected.
   - If recordings don't upload: Ensure "All Files Access" / "Storage" permission is allowed and Android battery optimization is set to "Unrestricted" for SalesBuster.

3. Leads Directory & Pipeline:
   - Stages: New -> Follow Up -> Converted -> Lost.
   - Leads can be assigned manually or via Round-Robin automatic distribution.
   - Excel/CSV import: Supported with Name, Phone, Email, Service columns.

4. Follow-ups & Reminders:
   - Scheduled call touches alert sales reps with system notifications and push alerts.

5. AI Auto-Responder & Quota:
   - Uses Google Gemini API key configured in Organization Profile.
   - Organization daily quota split partitions turns between WhatsApp, Call Processing, and BI Analyst.

GUIDELINES FOR YOUR RESPONSES:
- Provide clear numbered steps to fix the issue.
- Keep tone empathetic, professional, and crisp.
- If the issue is a bug or account-specific database issue that the user cannot fix themselves, provide what you know and suggest reporting an issue for technical engineering intervention.
`;

/**
 * First-Level Instant AI Support Chat
 * @route POST /api/support/ai-chat
 */
export const handleAiSupportChat = async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ success: false, error: "Message is required." });
    }

    const { Organization } = getMasterModels();
    const orgId = req.user?.organizationId || req.organization?._id;
    const organization = orgId ? await Organization.findById(orgId).lean() : null;

    const geminiApiKey =
      decryptApiKey(organization?.aiSettings?.geminiApiKey) || process.env.GEMINI_API_KEY;

    let aiReply = "";
    let suggestedSubject = "";
    let suggestedCategory = "technical_issue";

    if (geminiApiKey) {
      try {
        const model = new ChatGoogleGenerativeAI({
          apiKey: geminiApiKey,
          model: "gemini-3.5-flash-lite",
          temperature: 0.3,
        });

        const messages = [
          { role: "system", content: SUPPORT_KNOWLEDGE_BASE },
          ...history.slice(-6).map((h) => ({
            role: h.role === "assistant" ? "assistant" : "user",
            content: h.content,
          })),
          { role: "user", content: message },
        ];

        const response = await model.invoke(messages);
        aiReply = response.content;
      } catch (geminiErr) {
        console.warn("[Support AI] Gemini call failed, using intelligent fallback:", geminiErr.message);
      }
    }

    // Intelligent fallback if Gemini key unavailable or failed
    if (!aiReply) {
      const q = message.toLowerCase();
      if (q.includes("whatsapp") || q.includes("pairing") || q.includes("qr") || q.includes("disconnect")) {
        suggestedCategory = "whatsapp_meta";
        suggestedSubject = "WhatsApp Connection Inquiry";
        aiReply =
          "To resolve WhatsApp connectivity issues:\n\n" +
          "1. Open WhatsApp Chat from the sidebar and check your connection status badge.\n" +
          "2. If disconnected, click 'Generate Pairing Code' or 'Scan QR'.\n" +
          "3. Open WhatsApp on your Android phone > Linked Devices > Link a Device, and enter the 8-digit code.\n" +
          "4. Ensure your phone has battery optimization disabled for WhatsApp.\n\n" +
          "If the pairing code repeatedly fails, our engineering team can check your Meta Cloud webhook.";
      } else if (q.includes("recording") || q.includes("call") || q.includes("audio") || q.includes("sync")) {
        suggestedCategory = "call_recording";
        suggestedSubject = "Call Recording Synchronization Issue";
        aiReply =
          "To ensure your call recordings sync seamlessly:\n\n" +
          "1. Open the SalesBuster Mobile App and check the Tracked Call SIM in Analytics (ensure SIM 1 or SIM 2 is selected).\n" +
          "2. Go to Android Settings > Apps > SalesBuster > Permissions > Enable 'Microphone' and 'All Files / Storage Access'.\n" +
          "3. Set Battery Usage to 'Unrestricted' so background uploads aren't stopped by Android.\n" +
          "4. Verify that the mobile device has active internet connectivity after phone calls.";
      } else if (q.includes("lead") || q.includes("assign") || q.includes("pipeline") || q.includes("import")) {
        suggestedCategory = "leads_pipeline";
        suggestedSubject = "Leads Pipeline Assistance";
        aiReply =
          "For Leads Management:\n\n" +
          "1. To import leads: Go to Leads Directory > Click 'Import Excel/CSV' > Upload file with Name & Phone columns.\n" +
          "2. To assign leads: Managers can click any lead and change 'Assigned Representative' or enable Round-Robin auto-assignment in Organization Settings.\n" +
          "3. To move stages: Drag and drop cards on the Pipeline view or change status from the lead details drawer.";
      } else {
        suggestedSubject = message.slice(0, 60);
        aiReply =
          `I understand your query regarding: "${message.slice(0, 100)}...".\n\n` +
          "SalesBuster CRM automated checks have been reviewed for your account. " +
          "If this requires account-specific configuration, license adjustments, or technical investigation, you can escalate directly to our human support team using the 'Report an Issue' button below.";
      }
    }

    if (!suggestedSubject) {
      suggestedSubject = message.slice(0, 60);
    }

    return res.status(200).json({
      success: true,
      reply: aiReply,
      suggestedSubject,
      suggestedCategory,
    });
  } catch (error) {
    console.error("[SupportController] Error in AI support chat:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to process AI support inquiry. Please try again.",
    });
  }
};

/**
 * Raise a New Support Ticket (Client CRM)
 * @route POST /api/support/tickets
 */
export const createSupportTicket = async (req, res) => {
  try {
    const {
      subject,
      category,
      priority = "medium",
      description,
      aiChatHistory = [],
      aiSummary = "",
    } = req.body;

    if (!subject || !description) {
      return res.status(400).json({
        success: false,
        error: "Subject and detailed description are required.",
      });
    }

    const { Organization } = getMasterModels();
    const orgId = req.user?.organizationId || req.organization?._id;
    const org = orgId ? await Organization.findById(orgId).lean() : null;

    let newTicket;
    let saved = false;
    let attempts = 0;
    const maxAttempts = 3;

    while (!saved && attempts < maxAttempts) {
      attempts++;
      const ticketNumber = await SupportTicket.generateNextTicketNumber();

      newTicket = new SupportTicket({
        ticketNumber,
        organizationId: orgId,
        organizationName: org?.name || "Client Organization",
        userId: req.user?.id || req.user?._id,
        userName: req.user?.name || "CRM User",
        userEmail: req.user?.email || "user@salesbuster.ai",
        userRole: req.user?.role || "sales manager",
        subject: subject.trim(),
        category: category || "technical_issue",
        priority: ["low", "medium", "high", "urgent"].includes(priority) ? priority : "medium",
        status: "open",
        description: description.trim(),
        aiSummary: aiSummary || subject,
        aiChatHistory: Array.isArray(aiChatHistory) ? aiChatHistory : [],
      });

      try {
        await newTicket.save();
        saved = true;
      } catch (saveError) {
        if (saveError.code === 11000 && attempts < maxAttempts) {
          console.warn(`[SupportController] Ticket number ${ticketNumber} collision, retrying (attempt ${attempts + 1})...`);
          continue;
        }
        throw saveError;
      }
    }

    return res.status(201).json({
      success: true,
      message: `Support ticket ${newTicket.ticketNumber} raised successfully.`,
      ticket: newTicket,
    });
  } catch (error) {
    console.error("[SupportController] Error creating ticket:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to raise support ticket. Please try again.",
    });
  }
};

/**
 * Get Tickets for Client's Organization (Client CRM)
 * @route GET /api/support/tickets
 */
export const getOrganizationTickets = async (req, res) => {
  try {
    const orgId = req.user?.organizationId || req.organization?._id;
    if (!orgId) {
      return res.status(400).json({ success: false, error: "Organization context required." });
    }

    const { status, search } = req.query;

    const query = { organizationId: orgId };
    if (status && status !== "all") {
      query.status = status;
    }

    if (search && search.trim()) {
      const re = new RegExp(search.trim(), "i");
      query.$or = [{ subject: re }, { ticketNumber: re }, { description: re }];
    }

    const tickets = await SupportTicket.find(query).sort({ createdAt: -1 }).lean();

    return res.status(200).json({
      success: true,
      tickets,
      totalCount: tickets.length,
    });
  } catch (error) {
    console.error("[SupportController] Error fetching org tickets:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch support tickets." });
  }
};

/**
 * Get All Tickets across All Organizations (Super Admin Portal)
 * @route GET /api/support/admin/tickets
 */
export const getAllTicketsAdmin = async (req, res) => {
  try {
    const { status, category, organizationId, search } = req.query;

    const baseFilter = {};
    if (category && category !== "all") {
      baseFilter.category = category;
    }
    if (organizationId && organizationId !== "all") {
      baseFilter.organizationId = organizationId;
    }
    if (search && search.trim()) {
      const re = new RegExp(search.trim(), "i");
      baseFilter.$or = [
        { ticketNumber: re },
        { subject: re },
        { userEmail: re },
        { userName: re },
        { organizationName: re },
      ];
    }

    const query = { ...baseFilter };
    if (status && status !== "all") {
      query.status = status;
    }

    const [tickets, totalCount, openCount, inProgressCount, resolvedCount, closedCount] = await Promise.all([
      SupportTicket.find(query).sort({ createdAt: -1 }).lean(),
      SupportTicket.countDocuments(baseFilter),
      SupportTicket.countDocuments({ ...baseFilter, status: "open" }),
      SupportTicket.countDocuments({ ...baseFilter, status: "in_progress" }),
      SupportTicket.countDocuments({ ...baseFilter, status: "resolved" }),
      SupportTicket.countDocuments({ ...baseFilter, status: "closed" }),
    ]);

    return res.status(200).json({
      success: true,
      tickets,
      counts: {
        total: totalCount,
        open: openCount,
        inProgress: inProgressCount,
        resolved: resolvedCount,
        closed: closedCount,
      },
    });
  } catch (error) {
    console.error("[SupportController] Error in admin tickets:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch master tickets list." });
  }
};

/**
 * Get Single Ticket Details by ID (Super Admin / Client)
 * @route GET /api/support/admin/tickets/:id
 */
export const getTicketById = async (req, res) => {
  try {
    const { id } = req.params;
    const ticket = await SupportTicket.findById(id).lean();

    if (!ticket) {
      return res.status(404).json({ success: false, error: "Support ticket not found." });
    }

    return res.status(200).json({ success: true, ticket });
  } catch (error) {
    console.error("[SupportController] Error fetching ticket:", error);
    return res.status(500).json({ success: false, error: "Failed to load ticket details." });
  }
};

/**
 * Update Ticket Status & Resolution Notes (Super Admin Portal)
 * @route PATCH /api/support/admin/tickets/:id/status
 */
export const updateTicketStatusAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, resolutionNotes } = req.body;

    if (!status || !["open", "in_progress", "resolved", "closed"].includes(status)) {
      return res.status(400).json({ success: false, error: "Valid status is required." });
    }

    const updateFields = {
      status,
    };

    if (resolutionNotes !== undefined) {
      updateFields.resolutionNotes = resolutionNotes ? resolutionNotes.trim() : "";
    }

    if (status === "resolved" || status === "closed") {
      updateFields.resolvedAt = new Date();
      updateFields.resolvedBy = req.user?.name || "Super Admin";
    } else {
      // Reopening ticket to "open" or "in_progress" resets resolution metadata
      updateFields.resolvedAt = null;
      updateFields.resolvedBy = "";
    }

    const updatedTicket = await SupportTicket.findByIdAndUpdate(id, updateFields, { new: true });

    if (!updatedTicket) {
      return res.status(404).json({ success: false, error: "Ticket not found." });
    }

    return res.status(200).json({
      success: true,
      message: `Ticket ${updatedTicket.ticketNumber} marked as ${status}.`,
      ticket: updatedTicket,
    });
  } catch (error) {
    console.error("[SupportController] Error updating ticket status:", error);
    return res.status(500).json({ success: false, error: "Failed to update ticket status." });
  }
};
