import Lead from "../models/Lead.js";
import User from "../models/User.js";
import AssignmentState from "../models/AssignmentState.js";
import { sendWelcomeEnquiryMessage } from "../whatsapp/whatsappService.js";

// Meta requires a verification webhook setup.
export const verifyMetaWebhook = (req, res) => {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("META WEBHOOK_VERIFIED");
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  } else {
    return res.status(400).send("Missing parameters");
  }
};

export const receiveMetaWebhook = async (req, res) => {
  try {
    const body = req.body;

    // Check if it's a page event
    if (body.object === "page") {
      for (const entry of body.entry) {
        for (const change of entry.changes) {
          if (change.field === "leadgen") {
            const leadgenId = change.value.leadgen_id;
            const formId = change.value.form_id;

            // We have the leadgenId, we need to fetch the actual lead details from Graph API
            const accessToken = process.env.META_ACCESS_TOKEN;
            if (!accessToken) {
              console.error("META_ACCESS_TOKEN is missing in env");
              return res.sendStatus(500);
            }

            const graphApiUrl = `https://graph.facebook.com/v19.0/${leadgenId}?access_token=${accessToken}`;
            const response = await fetch(graphApiUrl);
            const data = await response.json();

            if (data.error) {
              console.error(
                "Error fetching lead from Meta Graph API:",
                data.error
              );
              continue;
            }

            // Parse field data
            // Meta returns field_data as an array: [{name: "email", values: ["test@test.com"]}, ...]
            let email = "";
            let phone = "";
            let name = "";
            let city = "";

            const fieldData = data.field_data || [];
            fieldData.forEach((field) => {
              if (field.name === "email") email = field.values[0];
              if (field.name === "phone_number") phone = field.values[0];
              if (field.name === "full_name") name = field.values[0];
              if (field.name === "city") city = field.values[0];
            });

            // Basic fallback for phone
            if (!phone) {
              console.error("Phone number missing from Meta Lead", data.id);
              continue;
            }

            // Check if lead already exists
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
              console.log("Lead already exists from Meta Ads:", phone);
              continue;
            }

            const leadData = {
              name: name || "Unknown from Meta",
              phone: phone,
              email: email,
              city: city,
              service: "General Enquiry", // Can be mapped to specific form if needed
              notes: `Lead from Meta Ads (Form ID: ${formId})`,
              source: "Meta Ads",
              status: "New",
              assignedTo: "Unassigned",
              joinedAt: new Date(),
            };

            // Assignment logic
            const reps = await User.find({ role: "sales person" }).sort({
              _id: 1,
            });
            if (reps && reps.length > 0) {
              let state = await AssignmentState.findOne({
                key: "leadAssignment",
              });
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

            const newLead = await Lead.create(leadData);
            console.log(
              "Successfully created lead from Meta Ads:",
              leadData.phone
            );
            sendWelcomeEnquiryMessage(newLead).catch((err) =>
              console.error("Error in sendWelcomeEnquiryMessage (meta):", err)
            );
          }
        }
      }
      return res.status(200).send("EVENT_RECEIVED");
    } else {
      return res.sendStatus(404);
    }
  } catch (error) {
    console.error("Error in receiveMetaWebhook:", error);
    return res.status(500).send("INTERNAL_SERVER_ERROR");
  }
};
