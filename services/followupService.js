import mongoose from "mongoose";
import { NotFoundError, BadRequestError } from "../utils/AppError.js";

const cleanText = (val, fallback = "") => {
  if (val === null || val === undefined) return fallback;
  const str = String(val).trim();
  if (
    !str ||
    str.toLowerCase() === "null" ||
    str.toLowerCase() === "undefined" ||
    str.toLowerCase() === "none" ||
    str.toLowerCase() === "n/a"
  ) {
    return fallback;
  }
  return str;
};

/**
 * Queries followups with role-based scoping and query filters.
 */
export const queryFollowupsService = async ({ tenantModels, user, query = {} }) => {
  const { Followup, Lead } = tenantModels;
  let filter = {};

  // Role scoping: sales representatives only see follow-ups for their assigned leads or self-authored
  if (user?.role === "sales person") {
    const repId = user._id || user.id;
    const repName = user.name;
    const repConditions = [String(repId)];

    if (mongoose.Types.ObjectId.isValid(repId)) {
      repConditions.push(new mongoose.Types.ObjectId(repId));
    }
    if (repName) {
      repConditions.push(new RegExp("^" + repName + "$", "i"));
    }

    let assignedLeadIds = [];
    if (Lead) {
      const assignedLeads = await Lead.find({
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

  if (query.leadId) {
    filter.leadId = query.leadId;
  }
  if (query.date) {
    filter.date = query.date;
  }
  if (query.done !== undefined) {
    filter.done = query.done === "true" || query.done === true;
  }

  const limit = query.limit ? Math.min(500, Math.max(1, parseInt(query.limit, 10))) : 0;
  let queryExec = Followup.find(filter).sort({ createdAt: -1 }).lean();
  if (limit > 0) {
    queryExec = queryExec.limit(limit);
  }

  const followups = await queryExec;
  return followups.map((f) => ({
    ...f,
    id: f._id ? f._id.toString() : f.id,
    leadId: f.leadId ? f.leadId.toString() : f.leadId,
  }));
};

/**
 * Creates or updates an active Follow-up, dispatches notifications, and triggers socket events.
 */
export const createFollowupService = async ({
  tenantModels,
  data,
  creatorUser = null,
  organizationId = null,
  io = null,
}) => {
  const { Followup, Lead, Notification } = tenantModels;

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
    isAI,
  } = data;

  const sanitizedNotes = cleanText(notes, "Follow-up scheduled by AI Agent");
  const sanitizedTime = cleanText(time, "10:00 AM");
  const sanitizedPriority = cleanText(priority, "Medium");
  const defaultAuthor =
    creatorUser?.name ||
    (creatorUser?.role === "sales person" ? "Sales Representative" : "AI Agent");
  const sanitizedAuthor = cleanText(author, defaultAuthor);
  const sanitizedType = cleanText(type, "Call");

  const isAiAuthor =
    isAI ||
    (sanitizedAuthor &&
      (sanitizedAuthor.toLowerCase().includes("ai") ||
        sanitizedAuthor.toLowerCase().includes("bot") ||
        sanitizedAuthor.toLowerCase().includes("agent")));

  let savedFollowup = null;

  // Prevent duplicate open AI follow-up cards for the same lead
  if (isAiAuthor && leadId) {
    let existingAi = await Followup.findOne({
      leadId,
      author: "AI Agent",
      done: false,
    });
    if (!existingAi) {
      existingAi = await Followup.findOne({
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
      savedFollowup = await existingAi.save();

      try {
        await Followup.deleteMany({
          _id: { $ne: savedFollowup._id },
          leadId,
          author: "AI Agent",
        });
      } catch (delErr) {
        console.warn("[FollowupService] Duplicate cleanup warning:", delErr.message);
      }
    }
  }

  if (!savedFollowup) {
    savedFollowup = await Followup.create({
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
  }

  // Notify sales managers for new followups
  if (Notification && sanitizedType !== "Lead Edited") {
    try {
      await Notification.create({
        title: "New Follow-up Scheduled",
        message: `A follow-up was scheduled for lead ${leadName || 'Lead'} by ${sanitizedAuthor}.`,
        type: "system",
        targetRoles: ["sales manager"],
      });
    } catch (nErr) {
      console.warn("[FollowupService] Notification warning:", nErr.message);
    }
  }

  // Socket notification for AI-scheduled follow-ups
  if (isAiAuthor && io) {
    try {
      let leadDoc = null;
      if (leadId && Lead) {
        try {
          leadDoc = await Lead.findById(leadId).lean();
        } catch (_) {}
      }

      const alertPayload = {
        followup: {
          id: savedFollowup._id ? savedFollowup._id.toString() : savedFollowup.id,
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

      const cleanOrgId = organizationId ? String(organizationId).replace(/^org_/, "") : null;
      if (cleanOrgId) {
        io.to(`org_${cleanOrgId}_admins`).emit("ai_new_followup", alertPayload);
      }

      const assignedUserId = leadDoc?.assignedTo
        ? (typeof leadDoc.assignedTo === "object" ? leadDoc.assignedTo._id || leadDoc.assignedTo.id : leadDoc.assignedTo).toString()
        : null;
      if (assignedUserId) {
        io.to(`user_${assignedUserId}`).emit("ai_new_followup", alertPayload);
      }
    } catch (socketErr) {
      console.warn("[FollowupService] Socket error:", socketErr.message);
    }
  }

  return savedFollowup;
};

/**
 * Updates an existing Follow-up by ID.
 */
export const updateFollowupService = async ({ tenantModels, followupId, updateData }) => {
  const { Followup } = tenantModels;
  const followup = await Followup.findById(followupId);

  if (!followup) {
    throw new NotFoundError("Followup not found");
  }

  if (updateData.done !== undefined) {
    followup.done = updateData.done;
  }
  if (updateData.notes !== undefined) {
    followup.notes = updateData.notes;
  }
  if (updateData.date !== undefined) {
    followup.date = updateData.date;
  }
  if (updateData.time !== undefined) {
    followup.time = updateData.time;
  }
  if (updateData.priority !== undefined) {
    followup.priority = updateData.priority;
  }
  if (updateData.type !== undefined) {
    followup.type = updateData.type;
  }

  return await followup.save();
};

/**
 * Fetches joined AI follow-ups with lead profiles and search filtering.
 */
export const queryAIFollowupsService = async ({ tenantModels, user, search = "" }) => {
  const { Followup, Lead, User } = tenantModels;
  let leadFilter = {};

  if (user?.role === "sales person") {
    const repId = user._id || user.id;
    const repName = user.name;
    const repConditions = [String(repId)];
    if (mongoose.Types.ObjectId.isValid(repId)) {
      repConditions.push(new mongoose.Types.ObjectId(repId));
    }
    if (repName) {
      repConditions.push(new RegExp("^" + repName + "$", "i"));
    }
    leadFilter.assignedTo = { $in: repConditions };
  }

  const leads = await Lead.find(leadFilter).lean();
  if (!leads || leads.length === 0) {
    return [];
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

  let repNameMap = new Map();
  if (repIdsToLookup.size > 0 && User) {
    try {
      const users = await User.find({
        _id: { $in: Array.from(repIdsToLookup) },
      })
        .select("name")
        .lean();
      users.forEach((u) => repNameMap.set(u._id.toString(), u.name));
    } catch (_) {}
  }

  const leadIds = Array.from(leadMap.keys());
  const followups = await Followup.find({
    leadId: { $in: leadIds },
    author: "AI Agent",
    done: false,
  })
    .sort({ createdAt: -1 })
    .lean();

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

  const cleanSearch = String(search || "").trim().toLowerCase();
  return cleanSearch
    ? result.filter(
        (item) =>
          item.lead.name?.toLowerCase().includes(cleanSearch) ||
          item.lead.phone?.includes(cleanSearch) ||
          item.lead.service?.toLowerCase().includes(cleanSearch) ||
          item.lead.city?.toLowerCase().includes(cleanSearch) ||
          item.notes?.toLowerCase().includes(cleanSearch),
      )
    : result;
};

/**
 * Marks an AI follow-up as handled and cleans up pending duplicates for that lead.
 */
export const handleAIFollowupService = async ({
  tenantModels,
  followupId,
  handledBy = "Representative",
  organizationId = null,
  io = null,
}) => {
  const { Followup } = tenantModels;
  const followup = await Followup.findById(followupId);

  if (!followup) {
    throw new NotFoundError("AI Follow-up not found");
  }

  followup.done = true;
  await followup.save();

  if (followup.leadId) {
    await Followup.updateMany(
      {
        leadId: followup.leadId,
        author: "AI Agent",
        done: false,
      },
      { $set: { done: true } },
    );
  }

  if (io && organizationId) {
    try {
      const cleanOrgId = String(organizationId).replace(/^org_/, "");
      io.to(`org_${cleanOrgId}`).emit("ai_followup_resolved", {
        followupId: followup._id.toString(),
        leadId: followup.leadId ? followup.leadId.toString() : "",
        handledBy,
        done: true,
      });
    } catch (socketErr) {
      console.warn("[FollowupService] Socket resolve error:", socketErr.message);
    }
  }

  return { id: followup._id.toString(), done: true };
};

export default {
  queryFollowupsService,
  createFollowupService,
  updateFollowupService,
  queryAIFollowupsService,
  handleAIFollowupService,
};
