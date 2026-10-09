import { tool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * Normalizes phone string to clean digits, prioritizing last 10 digits
 */
const normalizePhoneNumber = (phoneStr) => {
  if (!phoneStr) return "";
  const digits = String(phoneStr).replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
};

/**
 * Creates Phone Lookup tool bound to authenticated tenant context
 */
export const createPhoneLookupTool = ({ tenantModels }) => {
  return tool(
    async ({ phone }) => {
      try {
        const { Lead: LeadModel, User: UserModel } = tenantModels;
        if (!LeadModel) {
          return JSON.stringify({ error: "Lead model not found in tenant database" });
        }

        const rawPhone = String(phone || "").trim();
        const normalized10 = normalizePhoneNumber(rawPhone);

        if (!normalized10 || normalized10.length < 5) {
          return JSON.stringify({
            registered: false,
            message: `The provided phone number '${rawPhone}' is invalid or too short.`,
          });
        }

        // 1. Check Leads collection
        const leadQuery = {
          $or: [
            { phoneNormalized: normalized10 },
            { phone: rawPhone },
            { phone: { $regex: normalized10 } },
          ],
        };

        const matchingLeads = await LeadModel.find(leadQuery)
          .select("name phone phoneNormalized company status service assignedTo createdAt lastMessage lastActivity")
          .lean();

        if (matchingLeads.length > 0) {
          const formattedLeads = matchingLeads.map((l) => ({
            type: "Customer Lead",
            id: l._id.toString(),
            name: l.name || "Unnamed",
            phone: l.phone,
            company: l.company || undefined,
            status: l.status,
            service: l.service,
            assignedTo: l.assignedTo ? String(l.assignedTo) : "Unassigned",
            registeredOnIST: new Date(l.createdAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }),
            lastActivityIST: l.lastActivity
              ? new Date(l.lastActivity).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })
              : undefined,
          }));

          return JSON.stringify({
            registered: true,
            foundIn: "Leads",
            count: formattedLeads.length,
            records: formattedLeads,
          });
        }

        // 2. Check internal Users collection (sales reps, managers)
        if (UserModel) {
          const userQuery = {
            $or: [
              { phone: rawPhone },
              { phone: { $regex: normalized10 } },
            ],
          };

          const matchingUsers = await UserModel.find(userQuery)
            .select("name email phone role status")
            .lean();

          if (matchingUsers.length > 0) {
            const formattedUsers = matchingUsers.map((u) => ({
              type: "Internal Team Member",
              id: u._id.toString(),
              name: u.name || "Unnamed",
              email: u.email,
              phone: u.phone,
              role: u.role,
              status: u.status,
            }));

            return JSON.stringify({
              registered: true,
              foundIn: "Team Members",
              count: formattedUsers.length,
              records: formattedUsers,
            });
          }
        }

        // 3. Not registered anywhere
        return JSON.stringify({
          registered: false,
          normalizedQueried: normalized10,
          originalQueried: rawPhone,
          message: `Phone number '${rawPhone}' (normalized: ${normalized10}) is NOT registered in your organization (neither in Leads nor in Team Members).`,
        });
      } catch (error) {
        return JSON.stringify({ error: `Phone lookup failed: ${error.message}` });
      }
    },
    {
      name: "lookup_phone_number",
      description:
        "Checks whether a given phone number is registered in the organization's CRM (in Leads or internal Team Members). Returns exact match details including lead status, assigned representative, and service.",
      schema: z.object({
        phone: z
          .string()
          .describe("Phone number to check (e.g., '+91 98765 43210', '9876543210', or partial)"),
      }),
    }
  );
};
