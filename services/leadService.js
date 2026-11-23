import mongoose from "mongoose";
import { toInternationalPhone } from "../utils/phoneUtils.js";
import { BadRequestError, ForbiddenError, ConflictError } from "../utils/AppError.js";

/**
 * Decoupled Lead Service for SalesBuster CRM.
 * Implements pure business logic, duplicate checks, round-robin assignments,
 * notifications, and real-time socket dispatches.
 */

/**
 * Checks for existing duplicate leads by phone or email within the tenant database.
 */
export const checkDuplicateLead = async ({ LeadModel, phone, email, excludeLeadId = null }) => {
  if (!phone && !email) return { isDuplicate: false };

  const conditions = [];
  if (phone) {
    const rawDigits = String(phone).replace(/\D/g, "");
    const intlPhone = toInternationalPhone(phone);
    conditions.push(
      { phone: phone },
      { phone: rawDigits },
      { phoneNormalized: intlPhone },
      { phoneNormalized: rawDigits }
    );
  }

  if (email && typeof email === "string" && email.trim()) {
    conditions.push({ email: email.trim().toLowerCase() });
  }

  if (conditions.length === 0) return { isDuplicate: false };

  const query = { $or: conditions };
  if (excludeLeadId) {
    query._id = { $ne: excludeLeadId };
  }

  const existingLead = await LeadModel.findOne(query).lean();
  if (!existingLead) return { isDuplicate: false };

  let duplicateMsg = `A lead with this phone number (${existingLead.phone}) already exists: "${existingLead.name || 'Unnamed'}".`;
  if (
    email &&
    existingLead.email &&
    existingLead.email.toLowerCase() === email.toLowerCase() &&
    existingLead.phone !== phone
  ) {
    duplicateMsg = `A lead with this email address (${existingLead.email}) already exists: "${existingLead.name || 'Unnamed'}".`;
  }

  return {
    isDuplicate: true,
    duplicateLead: existingLead,
    message: duplicateMsg,
  };
};

/**
 * Performs round-robin auto-assignment for a lead across eligible sales representatives.
 */
export const resolveLeadAssignment = async ({
  UserModel,
  AssignmentStateModel,
  requestedAssignedTo,
  creatorUser,
}) => {
  // 1. If creator is a sales person, assign to self
  if (creatorUser?.role === "sales person" || creatorUser?.role === "Sales Representative") {
    const selfId = (creatorUser._id || creatorUser.id).toString();
    return {
      assignedTo: selfId,
      assignedRepName: creatorUser.name || "Self",
    };
  }

  // 2. If already explicitly assigned to a valid user, preserve it
  if (requestedAssignedTo && requestedAssignedTo !== "Unassigned") {
    let repName = requestedAssignedTo;
    try {
      if (mongoose.Types.ObjectId.isValid(requestedAssignedTo)) {
        const u = await UserModel.findById(requestedAssignedTo).select("name").lean();
        if (u) repName = u.name;
      } else {
        const u = await UserModel.findOne({ name: requestedAssignedTo }).select("name").lean();
        if (u) repName = u.name;
      }
    } catch (_) {}

    return {
      assignedTo: requestedAssignedTo,
      assignedRepName: repName,
    };
  }

  // 3. Round-robin assignment among sales persons
  const reps = await UserModel.find({
    role: { $in: ["sales person", "Sales Representative", "sales_person"] },
  }).sort({ _id: 1 });

  if (!reps || reps.length === 0) {
    return {
      assignedTo: "Unassigned",
      assignedRepName: "Unassigned",
    };
  }

  let state = await AssignmentStateModel.findOne({ key: "leadAssignment" });
  if (!state) {
    state = await AssignmentStateModel.create({
      key: "leadAssignment",
      lastAssignedIndex: -1,
    });
  }

  let nextIndex = state.lastAssignedIndex + 1;
  if (nextIndex >= reps.length || nextIndex < 0) {
    nextIndex = 0;
  }

  const chosenRep = reps[nextIndex];
  state.lastAssignedIndex = nextIndex;
  await state.save();

  return {
    assignedTo: chosenRep._id.toString(),
    assignedRepName: chosenRep.name || "Sales Representative",
    assignedUser: chosenRep,
  };
};

/**
 * Core service to create a lead, dispatch notifications, and emit real-time socket events.
 */
export const createLeadCoreService = async ({
  tenantModels,
  leadData,
  creatorUser = null,
  organization = null,
  io = null,
  checkDuplicate = true,
}) => {
  const { Lead, User, AssignmentState, Notification } = tenantModels;

  // 1. Subscription check
  if (organization?.subscriptionEndDate) {
    const isExpired = new Date() > new Date(organization.subscriptionEndDate);
    if (isExpired) {
      throw new ForbiddenError(
        `Organization subscription expired on ${organization.subscriptionEndDate}. Lead creation is disabled.`
      );
    }
  }

  // 2. Duplicate phone / email check
  if (checkDuplicate) {
    const dupCheck = await checkDuplicateLead({
      LeadModel: Lead,
      phone: leadData.phone,
      email: leadData.email,
    });

    if (dupCheck.isDuplicate) {
      throw new ConflictError(dupCheck.message);
    }
  }

  // 3. Resolve lead assignment
  const { assignedTo, assignedRepName } = await resolveLeadAssignment({
    UserModel: User,
    AssignmentStateModel: AssignmentState,
    requestedAssignedTo: leadData.assignedTo,
    creatorUser,
  });

  leadData.assignedTo = assignedTo;
  if (!leadData.joinedAt) {
    leadData.joinedAt = new Date();
  }

  // 4. Persist lead document
  const lead = await Lead.create(leadData);

  // 5. In-App Notification
  if (Notification) {
    try {
      const targetUsers =
        assignedTo && assignedTo !== "Unassigned" ? [assignedTo] : [];

      await Notification.create({
        title: "New Lead Added",
        message: `Lead ${lead.name || lead.phone} has been captured and assigned to ${assignedRepName}.`,
        type: "new_lead",
        targetRoles: ["sales manager"],
        targetUsers,
      });
    } catch (nErr) {
      console.warn("[LeadService] Notification warning:", nErr.message);
    }
  }

  // 6. Real-time Socket.io dispatch
  const orgId = organization?._id?.toString() || creatorUser?.organizationId?.toString();
  if (io && orgId) {
    const room = `org_${orgId}`;
    const payload = {
      lead,
      source: lead.source || "Manual Entry",
      assignedRepName,
      message: `New lead: ${lead.name || lead.phone} assigned to ${assignedRepName}`,
      timestamp: new Date(),
    };

    io.to(room).emit("new_lead", payload);
    io.to(room).emit("whatsapp_new_lead", payload);
    io.to(room).emit("lead_updated", { leadId: lead._id, lead });
  }

  return { lead, assignedRepName };
};
