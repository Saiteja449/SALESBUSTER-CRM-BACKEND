import mongoose from "mongoose";
import Followup from "../models/Followup.js";
import Notification from "../models/Notification.js";
import Lead from "../models/Lead.js";
import User from "../models/User.js";
import { getIO } from "../socket/socket.js";

const getModels = (req) => ({
  FollowupModel: req.tenantModels?.Followup || Followup,
  NotificationModel: req.tenantModels?.Notification || Notification,
  LeadModel: req.tenantModels?.Lead || Lead,
  UserModel: req.tenantModels?.User || User,
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


    followup.done =
      req.body.done !== undefined ? req.body.done : followup.done;

    const updatedFollowup = await followup.save();
    res.json({ success: true, data: updatedFollowup });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Get pending AI Follow-ups with joined Lead details (Optimized for Mobile & Web)
// @route   GET /api/followups/ai
// @access  Protected
export const getAIFollowups = async (req, res) => {
  try {
    const { FollowupModel, LeadModel, UserModel } = getModels(req);
    let leadFilter = {};

    // 1. Role-based scoping: Sales representatives see ONLY their assigned leads
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
      leadFilter.assignedTo = { $in: repConditions };
    }

    // 2. Fetch leads in scope
    const leads = await LeadModel.find(leadFilter).lean();
    if (!leads || leads.length === 0) {
      return res.json({ success: true, count: 0, data: [] });
    }

    const leadMap = new Map();
    const repIdsToLookup = new Set();
    leads.forEach((l) => {
      const idStr = l._id ? l._id.toString() : String(l.id);
      leadMap.set(idStr, l);
      if (
        l.assignedTo &&
        typeof l.assignedTo === "string" &&
        mongoose.Types.ObjectId.isValid(l.assignedTo)
      ) {
        repIdsToLookup.add(l.assignedTo);
      }
    });

    // Lookup rep names for managers if UserModel exists
    let repNameMap = new Map();
    if (repIdsToLookup.size > 0 && UserModel) {
      try {
        const users = await UserModel.find({
          _id: { $in: Array.from(repIdsToLookup) },
        })
          .select("name")
          .lean();
        users.forEach((u) => repNameMap.set(u._id.toString(), u.name));
      } catch (uErr) {}
    }

    // 3. Find active AI followups for these leads
    const leadIds = Array.from(leadMap.keys());
    const query = {
      leadId: { $in: leadIds },
      author: "AI Agent",
      done: false,
    };

    const followups = await FollowupModel.find(query)
      .sort({ createdAt: -1 })
      .lean();

    // 4. Deduplicate so only the latest active immediate action per lead is returned
    const seenLeads = new Set();
    const result = [];

    for (const f of followups) {
      const lId = f.leadId ? f.leadId.toString() : "";
      if (!seenLeads.has(lId) && leadMap.has(lId)) {
        seenLeads.add(lId);
        const lead = leadMap.get(lId);

        let assignedRepName = "Unassigned";
        if (lead.assignedTo) {
          const assignedStr = String(lead.assignedTo);
          assignedRepName = repNameMap.get(assignedStr) || lead.assignedTo;
        }

        result.push({
          id: f._id ? f._id.toString() : f.id,
          leadId: lId,
          type: f.type || "WhatsApp",
          date: f.date,
          time: f.time || "",
          priority: f.priority || "Medium",
          notes: f.notes || "",
          author: f.author || "AI Agent",
          done: f.done || false,
          createdAt: f.createdAt,
          lead: {
            id: lId,
            name: lead.name || "Customer",
            phone: lead.phone || "",
            email: lead.email || "",
            service:
              lead.service ||
              (Array.isArray(lead.services)
                ? lead.services.join(", ")
                : "General Enquiry"),
            status: lead.status || "New",
            city: lead.city || lead.aiQualification?.city || "",
            assignedTo: lead.assignedTo || "Unassigned",
            assignedRepName,
            aiQualification: lead.aiQualification || null,
            createdAt: lead.createdAt,
          },
        });
      }
    }

    // 5. Optional search filtering by customer name, phone, notes, city, or service
    const search = req.query?.search
      ? String(req.query.search).trim().toLowerCase()
      : "";
    const filteredResult = search
      ? result.filter(
          (item) =>
            item.lead.name?.toLowerCase().includes(search) ||
            item.lead.phone?.includes(search) ||
            item.lead.service?.toLowerCase().includes(search) ||
            item.lead.city?.toLowerCase().includes(search) ||
            item.notes?.toLowerCase().includes(search),
        )
      : result;

    res.json({
      success: true,
      count: filteredResult.length,
      data: filteredResult,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Mark an AI follow-up as handled and resolve active AI actions for the lead
// @route   PUT /api/followups/ai/:id/handle
// @access  Protected
export const handleAIFollowup = async (req, res) => {
  try {
    const { FollowupModel, LeadModel } = getModels(req);
    const followup = await FollowupModel.findById(req.params.id);

    if (!followup) {
      return res
        .status(404)
        .json({ success: false, message: "AI Follow-up not found" });
    }


    // Mark current followup as done
    followup.done = true;
    await followup.save();

    // Also mark any other pending AI followups for this lead as done to prevent stale cards
    if (followup.leadId) {
      await FollowupModel.updateMany(
        {
          leadId: followup.leadId,
          author: "AI Agent",
          done: false,
        },
        { $set: { done: true } },
      );
    }

    // Real-time socket broadcast
    try {
      const io = getIO();
      if (io) {
        const payload = {
          followupId: followup._id.toString(),
          leadId: followup.leadId ? followup.leadId.toString() : "",
          handledBy: req.user?.name || "Representative",
          done: true,
        };
        const orgId = req.user?.organizationId || req.organizationId;
        if (orgId) {
          const cleanOrgId = String(orgId).replace(/^org_/, "");
          io.to(`org_${cleanOrgId}`).emit("ai_followup_resolved", payload);
        }
        io.emit("ai_followup_resolved", payload);
      }
    } catch (socketErr) {
      console.warn(
        "[Followup Controller] Socket emit error:",
        socketErr.message,
      );
    }

    res.json({
      success: true,
      message: "AI follow-up marked as handled successfully",
      data: { id: followup._id.toString(), done: true },
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

