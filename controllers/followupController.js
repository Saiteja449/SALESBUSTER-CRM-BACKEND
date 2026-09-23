import mongoose from "mongoose";
import Followup from "../models/Followup.js";
import Notification from "../models/Notification.js";
import Lead from "../models/Lead.js";
import { getIO } from "../socket/socket.js";

const getModels = (req) => ({
  FollowupModel: req.tenantModels?.Followup || Followup,
  NotificationModel: req.tenantModels?.Notification || Notification,
  LeadModel: req.tenantModels?.Lead || Lead,
});

const isLeadAssignedToUser = (lead, user) => {
  if (!lead || !user) return false;
  const assigned = String(lead.assignedTo || "").trim();
  const userId = String(user._id || user.id || "").trim();
  const userName = user.name ? user.name.trim().toLowerCase() : "";
  if (assigned === userId) return true;
  if (userName && assigned.toLowerCase() === userName) return true;
  return false;
};

// @desc    Get all followups
// @route   GET /api/followups
// @access  Protected
export const getFollowups = async (req, res) => {
  try {
    const { FollowupModel, LeadModel } = getModels(req);
    let filter = {};

    if (req.user?.role === "sales person") {
      const repId = req.user._id || req.user.id;
      const repName = req.user.name;
      const repConditions = [String(repId)];
      if (mongoose.Types.ObjectId.isValid(repId)) {
        repConditions.push(new mongoose.Types.ObjectId(repId));
      }
      if (repName) {
        repConditions.push(new RegExp("^" + repName + "$", "i"));
      }

      let assignedLeadIds = [];
      if (LeadModel) {
        const assignedLeads = await LeadModel.find({
          assignedTo: { $in: repConditions },
        }).select("_id");
        assignedLeadIds = assignedLeads.map((l) => l._id.toString());
      }

      filter = {
        $or: [
          { leadId: { $in: assignedLeadIds } },
          { author: repName || String(repId) },
        ],
      };
    }

    const followups = await FollowupModel.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, data: followups });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Create a followup
// @route   POST /api/followups
// @access  Protected
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

    const { FollowupModel, LeadModel } = getModels(req);

    // If sales rep, enforce that the lead is assigned to them
    if (req.user?.role === "sales person" && leadId && LeadModel) {
      const lead = await LeadModel.findById(leadId);
      if (lead && !isLeadAssignedToUser(lead, req.user)) {
        return res.status(403).json({
          success: false,
          message: "Access forbidden: You can only schedule follow-ups for leads assigned to you",
        });
      }
    }

    const cleanText = (val, fallback = "") => {
      if (val === null || val === undefined) return fallback;
      const str = String(val).trim();
      if (!str || str.toLowerCase() === "null" || str.toLowerCase() === "undefined" || str.toLowerCase() === "none" || str.toLowerCase() === "n/a") return fallback;
      return str;
    };

    const sanitizedNotes = cleanText(notes, "Follow-up scheduled by AI Agent");
    const sanitizedTime = cleanText(time, "10:00 AM");
    const sanitizedPriority = cleanText(priority, "Medium");
    const defaultAuthor = req.user?.name || (req.user?.role === "sales person" ? "Sales Representative" : "AI Agent");
    const sanitizedAuthor = cleanText(author, defaultAuthor);
    const sanitizedType = cleanText(type, "Call");

    // If followup was created by AI, check if one already exists for this lead to prevent duplicates
    const isAiAuthor =
      req.body.isAI ||
      (sanitizedAuthor &&
        (sanitizedAuthor.toLowerCase().includes("ai") ||
          sanitizedAuthor.toLowerCase().includes("bot") ||
          sanitizedAuthor.toLowerCase().includes("agent")));

    let createdFollowup = null;
    if (isAiAuthor && leadId) {
      let existingAi = await FollowupModel.findOne({
        leadId,
        author: "AI Agent",
        done: false,
      });
      if (!existingAi) {
        existingAi = await FollowupModel.findOne({
          leadId,
          done: false,
        });
      }
      if (existingAi) {
        existingAi.type = sanitizedType;
        existingAi.date = date;
        existingAi.time = sanitizedTime;
        existingAi.priority = sanitizedPriority;
        existingAi.notes = sanitizedNotes;
        existingAi.author = sanitizedAuthor;
        existingAi.done = false;
        createdFollowup = await existingAi.save();

        try {
          await FollowupModel.deleteMany({
            _id: { $ne: createdFollowup._id },
            leadId,
            author: "AI Agent",
          });
        } catch (delErr) {
          console.warn("[Followup Controller] Duplicate cleanup warning:", delErr.message);
        }
      }
    }

    if (!createdFollowup) {
      const followup = new FollowupModel({
        leadId,
        leadName,
        type: sanitizedType,
        date,
        time: sanitizedTime,
        priority: sanitizedPriority,
        notes: sanitizedNotes,
        author: sanitizedAuthor,
        done: done !== undefined ? done : false,
      });
      createdFollowup = await followup.save();
    }

    if (sanitizedType !== "Lead Edited") {
      await NotificationModel.create({
        title: "New Follow-up Scheduled",
        message: `A follow-up was scheduled for lead ${leadName} by ${sanitizedAuthor}.`,
        type: "system",
        targetRoles: ["sales manager"],
      });
    }

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
          const assignedUserId = leadDoc?.assignedTo
            ? (typeof leadDoc.assignedTo === "object" ? leadDoc.assignedTo._id || leadDoc.assignedTo.id : leadDoc.assignedTo).toString()
            : null;

          if (orgId) {
            const cleanOrgId = String(orgId).replace(/^org_/, "");
            io.to(`org_${cleanOrgId}_admins`).emit("ai_new_followup", alertPayload);
          }
          if (assignedUserId) {
            io.to(`user_${assignedUserId}`).emit("ai_new_followup", alertPayload);
          }
          console.log(`[DEBUG] Emitted ai_new_followup from createFollowup for ${leadName} to leadership and assigned rep`);
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
// @access  Protected
export const updateFollowup = async (req, res) => {
  try {
    const { FollowupModel, LeadModel } = getModels(req);
    const followup = await FollowupModel.findById(req.params.id);

    if (!followup) {
      return res.status(404).json({ success: false, message: "Followup not found" });
    }

    // Role check: sales reps can only update followups for leads assigned to them
    if (req.user?.role === "sales person" && followup.leadId && LeadModel) {
      const lead = await LeadModel.findById(followup.leadId);
      if (lead && !isLeadAssignedToUser(lead, req.user)) {
        return res.status(403).json({
          success: false,
          message: "Access forbidden: You can only update follow-ups for leads assigned to you",
        });
      }
    }

    followup.done =
      req.body.done !== undefined ? req.body.done : followup.done;

    const updatedFollowup = await followup.save();
    res.json({ success: true, data: updatedFollowup });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};
