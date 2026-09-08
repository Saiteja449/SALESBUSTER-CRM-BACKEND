import Lead from "../models/Lead.js";
import User from "../models/User.js";
import AssignmentState from "../models/AssignmentState.js";
import { sendWelcomeEnquiryMessage } from "../whatsapp/whatsappService.js";

export const receiveWebsiteLead = async (req, res) => {
  try {
    // Support various naming conventions from the website form
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
    // Email is optional on the website form (no asterisk on the UI)
    if (!location) errors.push("State / Location is required");
    if (!service || service.toLowerCase().includes("select from")) {
      errors.push("Service is required");
    }

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
    }
    if (email) {
      orConditions.push({ email: new RegExp("^" + email + "$", "i") });
    }

    const LeadModel = req.tenantModels?.Lead || Lead;
    const UserModel = req.tenantModels?.User || User;
    const AssignmentStateModel = req.tenantModels?.AssignmentState || AssignmentState;

    const existingLead = await LeadModel.findOne({ $or: orConditions });
    if (existingLead) {
      return res.status(200).json({
        success: true,
        message: "Form submitted successfully. We will contact you soon!",
        leadId: existingLead._id,
      });
    }

    const mapService = (incomingService) => {
      if (!incomingService) return "General Enquiry";
      const valid = [
        "General Enquiry",
        "Passenger Lift",
        "MRL Lift",
        "Hydraulic Lift",
        "Hospital Bed Lift",
        "Elevator Maintenance & AMC",
        "Elevator Modernization",
      ];
      const match = valid.find(
        (v) => v.toLowerCase() === incomingService.trim().toLowerCase(),
      );
      if (match) return match;

      const s = incomingService.toLowerCase();
      if (
        s.includes("mrl") ||
        s.includes("machine room less") ||
        s.includes("no machine room")
      )
        return "MRL Lift";
      if (
        s.includes("hydraulic") ||
        s.includes("villa") ||
        s.includes("home lift") ||
        s.includes("warehouse") ||
        s.includes("cargo") ||
        s.includes("industrial")
      )
        return "Hydraulic Lift";
      if (
        s.includes("hospital") ||
        s.includes("bed lift") ||
        s.includes("stretcher") ||
        s.includes("clinic") ||
        s.includes("medical")
      )
        return "Hospital Bed Lift";
      if (
        s.includes("moderniz") ||
        s.includes("modernis") ||
        s.includes("upgrade lift") ||
        s.includes("replace lift") ||
        s.includes("replacement")
      )
        return "Elevator Modernization";
      if (
        s.includes("maintenance") ||
        s.includes("amc") ||
        s.includes("servicing") ||
        s.includes("breakdown") ||
        s.includes("repair")
      )
        return "Elevator Maintenance & AMC";
      if (
        s.includes("passenger") ||
        s.includes("apartment") ||
        s.includes("office") ||
        s.includes("elevator") ||
        s.includes("lift")
      )
        return "Passenger Lift";
      return "General Enquiry";
    };

    const notesParts = [];
    if (message) notesParts.push(message);
    if (location) notesParts.push(`State: ${location}`);

    const leadData = {
      name: name,
      phone: mobile,
      email: email,
      city: location,
      service: mapService(service),
      notes: notesParts.length > 0 ? notesParts.join(" | ") : "Website Inquiry",
      source: "Website Form",
      status: "New",
      assignedTo: "Unassigned",
      joinedAt: new Date(),
    };

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

    const lead = await LeadModel.create(leadData);

    // Send automated WhatsApp welcome enquiry message asynchronously
    const orgId =
      req.organization?._id ||
      req.userTokenData?.organizationId ||
      req.body.organizationId ||
      req.query.organizationId ||
      null;

    sendWelcomeEnquiryMessage(lead, {
      tenantModels: req.tenantModels,
      organizationId: orgId,
    }).catch((err) =>
      console.error("Error in sendWelcomeEnquiryMessage (website):", err),
    );

    // Return a structured response that is easy for the website to consume
    res.status(201).json({
      success: true,
      message: "Form submitted successfully. We will contact you soon!",
      leadId: lead._id,
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};
