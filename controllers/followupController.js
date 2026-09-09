import Followup from "../models/Followup.js";
import Notification from "../models/Notification.js";
import { getIO } from "../socket/socket.js";

const getModels = (req) => ({
  FollowupModel: req.tenantModels?.Followup || Followup,
  NotificationModel: req.tenantModels?.Notification || Notification,
});

// @desc    Get all followups
// @route   GET /api/followups
// @access  Public / Protected
export const getFollowups = async (req, res) => {
  try {
    const { FollowupModel } = getModels(req);
    const followups = await FollowupModel.find().sort({ createdAt: -1 });
    res.json({ success: true, data: followups });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Create a followup
// @route   POST /api/followups
// @access  Public / Protected
export const createFollowup = async (req, res) => {
  try {
    const {
      leadId,
      leadName,
      type,
      date,
      time,
      priority,
      notes,
      author,
      done,
    } = req.body;

    const cleanText = (val, fallback = "") => {
      if (val === null || val === undefined) return fallback;
      const str = String(val).trim();
      if (!str || str.toLowerCase() === "null" || str.toLowerCase() === "undefined" || str.toLowerCase() === "none" || str.toLowerCase() === "n/a") return fallback;
      return str;
    };

    const sanitizedNotes = cleanText(notes, "Follow-up scheduled by AI Agent");
    const sanitizedTime = cleanText(time, "10:00 AM");
    const sanitizedPriority = cleanText(priority, "Medium");
    const sanitizedAuthor = cleanText(author, "AI Agent");
    const sanitizedType = cleanText(type, "Call");

    const followup = new FollowupModel({
      leadId,
      leadName,
      type: sanitizedType,
      date,
      time: sanitizedTime,
      priority: sanitizedPriority,
      notes: sanitizedNotes,
      author: sanitizedAuthor,
      done,
    });
    const createdFollowup = await followup.save();

    if (sanitizedType !== "Lead Edited") {
      await NotificationModel.create({
        title: "New Follow-up Scheduled",
        message: `A follow-up was scheduled for lead ${leadName} by ${sanitizedAuthor}.`,
        type: "system",
        targetRoles: ["sales manager"],
      });
    }

    // If followup was created by AI, emit real-time socket alert
    const isAiAuthor =
      req.body.isAI ||
      (sanitizedAuthor &&
        (sanitizedAuthor.toLowerCase().includes("ai") ||
          sanitizedAuthor.toLowerCase().includes("bot") ||
          sanitizedAuthor.toLowerCase().includes("agent")));

    if (isAiAuthor) {
      try {
        const io = getIO();
        if (io) {
          let leadDoc = null;
          if (leadId) {
            try {
              const LeadModel = req.tenantModels?.Lead || (await import("../models/Lead.js")).default;
              leadDoc = await LeadModel.findById(leadId);
            } catch (err) {}
          }

          const alertPayload = {
            followup: {
              id: createdFollowup._id ? createdFollowup._id.toString() : createdFollowup.id,
              leadId: leadId ? leadId.toString() : "",
              leadName: leadName || leadDoc?.name || "Customer",
              type: sanitizedType,
              date,
              time: sanitizedTime,
              priority: sanitizedPriority,
              notes: sanitizedNotes,
              author: sanitizedAuthor,
            },
            lead: leadDoc
              ? {
                  id: leadDoc._id.toString(),
                  name: leadDoc.name,
                  phone: leadDoc.phone,
                  service: leadDoc.service,
                  assignedTo: leadDoc.assignedTo,
                }
              : {
                  id: leadId ? leadId.toString() : "",
                  name: leadName,
                },
            message: sanitizedNotes,
            assignedRepName: "Sales Representative",
            timestamp: new Date(),
          };

          const orgId = req.user?.organizationId || req.organizationId;
          if (orgId) {
            const cleanOrgId = String(orgId).replace(/^org_/, "");
            io.to(`org_${cleanOrgId}`).emit("ai_new_followup", alertPayload);
          } else {
            io.emit("ai_new_followup", alertPayload);
          }
          console.log(`[DEBUG] Emitted ai_new_followup from createFollowup for ${leadName}`);
        }
      } catch (socketErr) {
        console.warn("[Followup Controller] Socket emit error:", socketErr.message);
      }
    }

    res.status(201).json({ success: true, data: createdFollowup });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Update a followup
// @route   PUT /api/followups/:id
// @access  Public / Protected
export const updateFollowup = async (req, res) => {
  try {
    const { FollowupModel } = getModels(req);
    const followup = await FollowupModel.findById(req.params.id);

    if (followup) {
      followup.done =
        req.body.done !== undefined ? req.body.done : followup.done;

      const updatedFollowup = await followup.save();
      res.json({ success: true, data: updatedFollowup });
    } else {
      res.status(404).json({ success: false, message: "Followup not found" });
    }
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};
