import Lead from "../models/Lead.js";
import User from "../models/User.js";
import AssignmentState from "../models/AssignmentState.js";
import Notification from "../models/Notification.js";
import { getMasterModels, getTenantModels } from "../services/tenantManager.js";
import { getIO } from "../socket/socket.js";
import { sendWelcomeEnquiryMessage } from "../whatsapp/whatsappService.js";

export const receiveWebsiteLead = async (req, res) => {
  try {
    // 1. Resolve Organization & Tenant Models if not already bound
    let organization = req.organization || null;
    let tenantModels = req.tenantModels || null;

    if (!organization) {
      const explicitOrgId =
        req.params?.orgId ||
        req.query?.orgId ||
        req.query?.organizationId ||
        req.body?.organizationId ||
        req.body?.orgId ||
        req.headers?.["x-organization-id"] ||
        req.headers?.["x-org-id"];

      const apiKey =
        req.headers?.["x-api-key"] ||
        req.headers?.["x-webhook-secret"] ||
        req.query?.apiKey ||
        req.body?.apiKey;

      const { Organization } = getMasterModels();

      if (explicitOrgId) {
        try {
          organization = await Organization.findById(explicitOrgId);
        } catch (e) {}
      } else if (apiKey) {
        try {
          organization = await Organization.findOne({ webhookKey: apiKey });
        } catch (e) {}
      }

      if (organization) {
        req.organization = organization;
        tenantModels = getTenantModels(organization.tenantDbName);
        req.tenantModels = tenantModels;
      }
    }

    const orgId =
      organization?._id ||
      req.body?.organizationId ||
      req.query?.orgId ||
      null;

    // Check account status if organization is known
    if (organization) {
      if (organization.status === "inactive" || organization.status === "suspended") {
        return res.status(403).json({
          success: false,
          message: "Organization account is inactive or suspended.",
        });
      }
      if (organization.subscriptionEndDate && new Date() > new Date(organization.subscriptionEndDate)) {
        return res.status(403).json({
          success: false,
          message: "Organization subscription has expired.",
        });
      }
    }

    // 2. Support various naming conventions from website form submissions
    const rawName =
      req.body.name || req.body.fullName || req.body.full_name || "";
    const rawMobile =
      req.body.mobile ||
      req.body.phone ||
      req.body.mobileNumber ||
      req.body.phoneNumber ||
      req.body.mobile_number ||
      "";
    const rawEmail =
      req.body.email || req.body.emailAddress || req.body.email_address || "";
    const rawLocation =
      req.body.location ||
      req.body.state ||
      req.body.city ||
      req.body.selectState ||
      req.body.select_your_state ||
      "";
    const rawService =
      req.body.service ||
      req.body.serviceRequired ||
      req.body.service_required ||
      req.body.requirement ||
      "";
    const rawMessage =
      req.body.message ||
      req.body.additionalDetails ||
      req.body.details ||
      req.body.requirements ||
      req.body.notes ||
      req.body.additional_details ||
      "";

    const name = String(rawName).trim();
    const mobile = String(rawMobile).trim();
    const email = String(rawEmail).trim();
    const location = String(rawLocation).trim();
    const service = String(rawService).trim();
    const message = String(rawMessage).trim();

    const errors = [];
    if (!name) errors.push("Full Name is required");
    if (!mobile) errors.push("Mobile Number is required");

    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    const cleanDigits = mobile.replace(/\D/g, "");
    const last10Digits =
      cleanDigits.length >= 10 ? cleanDigits.slice(-10) : cleanDigits;
    let normalizedPhone = cleanDigits;
    if (normalizedPhone.length > 10 && normalizedPhone.startsWith("91")) {
      normalizedPhone = normalizedPhone.substring(2);
    }

    const orConditions = [
      { phone: mobile },
      { phone: cleanDigits },
      { phone: normalizedPhone },
    ];
    if (last10Digits.length >= 7) {
      orConditions.push({ phone: new RegExp(last10Digits + "$") });
      orConditions.push({ phoneNormalized: last10Digits });
    }
    if (email) {
      orConditions.push({ email: new RegExp("^" + email + "$", "i") });
    }

    const LeadModel = req.tenantModels?.Lead || Lead;
    const UserModel = req.tenantModels?.User || User;
    const AssignmentStateModel =
      req.tenantModels?.AssignmentState || AssignmentState;
    const NotificationModel = req.tenantModels?.Notification || Notification;

    // 3. Duplicate lead check
    const existingLead = await LeadModel.findOne({ $or: orConditions });
    if (existingLead) {
      if (message) {
        existingLead.notes = existingLead.notes
          ? `${existingLead.notes} | [New Website Submission: ${message}]`
          : message;
        existingLead.lastActivity = new Date();
        await existingLead.save();
      }

      const io = getIO();
      if (io && orgId) {
        io.to(`org_${orgId}`).emit("conversation_updated", {
          leadId: existingLead._id,
          status: existingLead.status,
          lead: existingLead,
        });
      }

      return res.status(200).json({
        success: true,
        message: "Form submitted successfully. We will contact you soon!",
        leadId: existingLead._id,
        isExisting: true,
      });
    }

    // 4. Dynamic & Generic Service Mapping
    const resolveService = (incoming) => {
      if (!incoming || incoming.toLowerCase().includes("select from")) {
        return "General Enquiry";
      }
      // Check against organization services catalog if configured
      const orgServices = organization?.aiSettings?.services || [];
      if (orgServices.length > 0) {
        const found = orgServices.find(
          (s) =>
            s.name.toLowerCase() === incoming.toLowerCase() ||
            (s.keywords &&
              s.keywords.some((kw) =>
                incoming.toLowerCase().includes(kw.toLowerCase()),
              )),
        );
        if (found) return found.name;
      }
      return incoming;
    };

    const notesParts = [];
    if (message) notesParts.push(message);
    if (location) notesParts.push(`Location: ${location}`);

    const resolvedService = resolveService(service);

    const leadData = {
      name: name,
      phone: mobile,
      email: email,
      city: location,
      service: resolvedService,
      notes: notesParts.length > 0 ? notesParts.join(" | ") : "Website Inquiry",
      source: "Website Form",
      status: "New",
      assignedTo: "Unassigned",
      joinedAt: new Date(),
    };

    // 5. Round-robin assignment among sales reps
    const reps = await UserModel.find({ role: "sales person" }).sort({ _id: 1 });
    if (reps && reps.length > 0) {
      let state = await AssignmentStateModel.findOne({ key: "leadAssignment" });
      if (!state) {
        state = await AssignmentStateModel.create({
          key: "leadAssignment",
          lastAssignedIndex: -1,
        });
      }

      let nextIndex = state.lastAssignedIndex + 1;
      if (nextIndex >= reps.length) {
        nextIndex = 0;
      }

      leadData.assignedTo = reps[nextIndex]._id.toString();
      state.lastAssignedIndex = nextIndex;
      await state.save();
    }

    // 6. Create Lead
    const lead = await LeadModel.create(leadData);

    // 7. In-App CRM Notification
    if (NotificationModel) {
      NotificationModel.create({
        title: "New Website Lead",
        message: `New website lead received: ${lead.name} (${lead.phone}) for ${lead.service}.`,
        type: "lead_create",
        targetRoles: ["sales manager"],
        targetUsers:
          lead.assignedTo && lead.assignedTo !== "Unassigned"
            ? [lead.assignedTo]
            : [],
      }).catch((notifErr) =>
        console.error("Error creating website lead notification:", notifErr),
      );
    }

    // 8. Real-time Socket.IO Broadcast to CRM clients
    const io = getIO();
    if (io && orgId) {
      io.to(`org_${orgId}`).emit("new_lead", { lead });
      io.to(`org_${orgId}`).emit("conversation_updated", {
        leadId: lead._id,
        status: lead.status,
        lead,
      });
    }

    // 9. Send automated WhatsApp welcome enquiry message asynchronously
    sendWelcomeEnquiryMessage(lead, {
      tenantModels: req.tenantModels,
      organizationId: orgId,
    }).catch((err) =>
      console.error("Error in sendWelcomeEnquiryMessage (website):", err),
    );

    return res.status(201).json({
      success: true,
      message: "Form submitted successfully. We will contact you soon!",
      leadId: lead._id,
    });
  } catch (error) {
    console.error("Error in receiveWebsiteLead:", error);
    res.status(400).json({ success: false, message: error.message });
  }
};
