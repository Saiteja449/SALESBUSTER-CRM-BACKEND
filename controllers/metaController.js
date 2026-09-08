import Lead from "../models/Lead.js";
import User from "../models/User.js";
import AssignmentState from "../models/AssignmentState.js";
import { sendWelcomeEnquiryMessage } from "../whatsapp/whatsappService.js";

const getModels = (req) => ({
  LeadModel: req.tenantModels?.Lead || Lead,
  UserModel: req.tenantModels?.User || User,
  AssignmentStateModel: req.tenantModels?.AssignmentState || AssignmentState,
});

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
    const { LeadModel, UserModel, AssignmentStateModel } = getModels(req);

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

            const existingLead = await LeadModel.findOne({ $or: orConditions });
            if (existingLead) {
              console.log("Lead already exists from Meta Ads:", phone);
              continue;
            }

            const leadData = {
              name: name || "Unknown from Meta",
              phone: phone,
              email: email,
              city: city,
              service: "General Enquiry",
              notes: `Lead from Meta Ads (Form ID: ${formId})`,
              source: "Meta Ads",
              status: "New",
              assignedTo: "Unassigned",
              joinedAt: new Date(),
            };

            // Assignment logic
            const reps = await UserModel.find({ role: "sales person" }).sort({
              _id: 1,
            });
            if (reps && reps.length > 0) {
              let state = await AssignmentStateModel.findOne({
                key: "leadAssignment",
              });
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

            const newLead = await LeadModel.create(leadData);
            console.log(
              "Successfully created lead from Meta Ads:",
              leadData.phone
            );
            const orgId =
              req.organization?._id ||
              req.userTokenData?.organizationId ||
              req.body.organizationId ||
              req.query.organizationId ||
              null;

            sendWelcomeEnquiryMessage(newLead, {
              tenantModels: req.tenantModels,
              organizationId: orgId,
            }).catch((err) =>
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
