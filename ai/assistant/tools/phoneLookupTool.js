import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { escapeRegex } from "../securityUtils.js";
import { buildOwnerDirectory } from "../analytics/ownerResolver.js";

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

        const ownerDir = await buildOwnerDirectory({ tenantModels });

        const rawPhone = String(phone || "").trim();
        const normalized10 = normalizePhoneNumber(rawPhone);

        if (!normalized10 || normalized10.length < 5) {
          return JSON.stringify({
            registered: false,
            message: `The provided phone number '${rawPhone}' is invalid or too short.`,
          });
        }

        const safeRawPhone = escapeRegex(rawPhone);
        const isTenDigits = normalized10.length === 10;
        const phoneEndRegex = new RegExp(`${escapeRegex(normalized10)}$`);

        // 1. Check Leads collection
        const leadQuery = {
          $or: [
            { phoneNormalized: normalized10 },
            { phone: rawPhone },
            { phone: phoneEndRegex },
          ],
        };

        const rawLeads = await LeadModel.find(leadQuery)
          .select("name phone phoneNormalized company status service assignedTo createdAt lastMessage lastActivity")
          .lean();
        const matchingLeads = Array.isArray(rawLeads) ? rawLeads : [];

        const formattedLeads = matchingLeads.map((l) => {
          const owner = ownerDir.resolveOwner(l.assignedTo);
          const displayName = (l.name && l.name.trim()) || (l.company && l.company.trim()) || l.phone || "Customer";
          return {
            type: "Customer Lead",
            leadId: l._id ? l._id.toString() : "",
            displayName,
            name: displayName,
            phone: l.phone,
            company: l.company || undefined,
            status: l.status,
            service: l.service,
            assignedTo: owner.name,
            assignedToId: owner.id,
            registeredOnIST: l.createdAt
              ? new Date(l.createdAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })
              : undefined,
            lastActivityIST: l.lastActivity
              ? new Date(l.lastActivity).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })
              : undefined,
          };
        });

        // 2. Always check internal Users collection (sales reps, managers)
        let formattedUsers = [];
        if (UserModel && typeof UserModel.find === "function") {
          try {
            const userQuery = {
              $or: [
                { phone: rawPhone },
                { phone: phoneEndRegex },
              ],
            };

            const rawUsers = await UserModel.find(userQuery)
              .select("name email phone role status")
              .lean();
            const matchingUsers = Array.isArray(rawUsers) ? rawUsers : [];

            formattedUsers = matchingUsers.map((u) => ({
              type: "Internal Team Member",
              salespersonId: u._id ? u._id.toString() : (u.id || ""),
              name: u.name || u.email || "Team member",
              email: u.email,
              phone: u.phone,
              role: u.role,
              status: u.status,
            }));
          } catch (_) {}
        }

        const totalFound = formattedLeads.length + formattedUsers.length;
        const allRecords = [...formattedLeads, ...formattedUsers];

        if (totalFound > 0) {
          const bothMatch = formattedLeads.length > 0 && formattedUsers.length > 0;
          const foundIn = bothMatch
            ? "Both Leads and Team Members"
            : formattedLeads.length > 0
            ? "Leads"
            : "Team Members";

          return JSON.stringify({
            success: true,
            registered: true,
            exactMatch: isTenDigits,
            isPartialMatch: !isTenDigits,
            matchesBothLeadAndTeamMember: bothMatch,
            hasMultipleCustomerMatches: formattedLeads.length > 1,
            foundIn,
            count: totalFound,
            leadCount: formattedLeads.length,
            teamCount: formattedUsers.length,
            records: allRecords,
            leads: formattedLeads,
            teamMembers: formattedUsers,
            message: bothMatch
              ? `Phone '${rawPhone}' matched BOTH a Customer Lead (${formattedLeads[0].name}) and an Internal Team Member (${formattedUsers[0].name}).`
              : formattedLeads.length > 1
              ? `Phone '${rawPhone}' matched ${formattedLeads.length} separate Customer Leads (${formattedLeads.map((l) => l.name).join(", ")}).`
              : `Found ${totalFound} record(s) matching phone '${rawPhone}'.`,
          });
        }

        // 3. Not registered anywhere
        return JSON.stringify({
          success: true,
          registered: false,
          exactMatch: isTenDigits,
          isPartialMatch: !isTenDigits,
          matchesBothLeadAndTeamMember: false,
          count: 0,
          records: [],
          normalizedQueried: normalized10,
          originalQueried: rawPhone,
          message: `Phone number '${rawPhone}' was not found in Leads or Team Members.`,
        });
      } catch (error) {
        return JSON.stringify({ error: `Phone lookup failed: ${error.message}` });
      }
    },
    {
      name: "lookup_phone_number",
      description:
        "Checks whether a given phone number is registered in the organization's CRM (in Leads or internal Team Members). Returns exact match details including lead status, assigned representative, and service. IDs are strictly internal; never show MongoDB ObjectIds to the user.",
      schema: z.object({
        phone: z
          .string()
          .describe("Phone number to check (e.g., '+91 98765 43210', '9876543210', or partial)"),
      }),
    }
  );
};
