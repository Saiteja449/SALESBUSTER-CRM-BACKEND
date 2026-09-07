import Lead from "../models/Lead.js";
import User from "../models/User.js";
import AssignmentState from "../models/AssignmentState.js";
import { getIO } from "../socket/socket.js";
import { sendWelcomeEnquiryMessage } from "../whatsapp/whatsappService.js";

export const receiveMobileAppLead = async (req, res) => {
  try {
    const { name, phone, email, service } = req.body;

    const errors = [];
    if (!name || name.trim() === "") errors.push("Name is required");
    if (!phone || phone.trim() === "") errors.push("Phone number is required");

    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    const rawPhone = phone ? String(phone).trim() : "";
    const cleanDigits = rawPhone.replace(/\D/g, "");
    const last10Digits =
      cleanDigits.length >= 10 ? cleanDigits.slice(-10) : cleanDigits;
    let normalizedPhone = cleanDigits;
    if (normalizedPhone.length > 10 && normalizedPhone.startsWith("91")) {
      normalizedPhone = normalizedPhone.substring(2);
    }

    const orConditions = [
      { phone: rawPhone },
      { phone: cleanDigits },
      { phone: normalizedPhone },
    ];
    if (last10Digits.length >= 7) {
      orConditions.push({ phone: new RegExp(last10Digits + "$") });
    }
    if (email && typeof email === "string" && email.trim()) {
      orConditions.push({ email: new RegExp("^" + email.trim() + "$", "i") });
    }

    const existingLead = await Lead.findOne({ $or: orConditions });
    if (existingLead) {
      return res.status(200).json({
        success: true,
        message: "Lead received successfully from Mobile App (existing lead).",
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
      return match || "General Enquiry";
    };

    const leadData = {
      name: name,
      phone: phone,
      email: email || "",
      service: mapService(service),
      source: "Mobile App",
      status: "New",
      assignedTo: "Unassigned",
      joinedAt: new Date(),
    };

    const reps = await User.find({ role: "sales person" }).sort({ _id: 1 });
    if (reps && reps.length > 0) {
      let state = await AssignmentState.findOne({ key: "leadAssignment" });
      if (!state) {
        state = await AssignmentState.create({
          key: "leadAssignment",
          lastAssignedIndex: -1,
        });
      }

      let nextIndex = state.lastAssignedIndex + 1;
      if (nextIndex >= reps.length) {
        nextIndex = 0;
      }

      leadData.assignedTo = reps[nextIndex].name;
      state.lastAssignedIndex = nextIndex;
      await state.save();
    }

    const lead = await Lead.create(leadData);

    // Send automated WhatsApp welcome enquiry message asynchronously
    sendWelcomeEnquiryMessage(lead).catch((err) =>
      console.error("Error in sendWelcomeEnquiryMessage (mobile):", err),
    );

    const io = getIO();
    if (io) {
      io.emit("new_lead", lead);
    }

    res.status(201).json({
      success: true,
      message: "Lead received successfully from Mobile App.",
      leadId: lead._id,
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};
