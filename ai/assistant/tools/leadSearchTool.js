import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { escapeRegex, wrapUntrustedData } from "../securityUtils.js";

/**
 * Creates Lead Search tool bound to authenticated tenant context
 */
export const createLeadSearchTool = ({ tenantModels }) => {
  return tool(
    async ({
      searchTerm,
      status,
      source,
      service,
      priority,
      limit = 10,
    }) => {
      try {
        const { Lead: LeadModel } = tenantModels;
        if (!LeadModel) {
          return JSON.stringify({ error: "Lead model not found in tenant database" });
        }

        const filter = {};

        if (status) {
          filter.status = status;
        }

        if (source) {
          filter.source = source;
        }

        if (service && service.trim()) {
          const safeService = escapeRegex(service.trim());
          filter.$or = [
            { service: { $regex: safeService, $options: "i" } },
            { services: { $regex: safeService, $options: "i" } },
          ];
        }

        if (priority) {
          filter.priority = priority;
        }

        if (searchTerm && searchTerm.trim()) {
          const safeTerm = escapeRegex(searchTerm.trim());
          const safeRegex = new RegExp(safeTerm, "i");
          const searchConditions = [
            { name: { $regex: safeTerm, $options: "i" } },
            { company: { $regex: safeTerm, $options: "i" } },
            { notes: { $regex: safeTerm, $options: "i" } },
            { city: { $regex: safeTerm, $options: "i" } },
            { tags: { $in: [safeRegex] } },
          ];
          if (filter.$or) {
            filter.$and = [{ $or: filter.$or }, { $or: searchConditions }];
            delete filter.$or;
          } else {
            filter.$or = searchConditions;
          }
        }

        const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 10), 25);

        const totalMatching = await LeadModel.countDocuments(filter);
        const leads = await LeadModel.find(filter)
          .sort({ createdAt: -1 })
          .limit(safeLimit)
          .select("name phone company service status source priority assignedTo dealValue createdAt notes tags city")
          .lean();

        const formattedLeads = leads.map((l) => ({
          id: l._id.toString(),
          name: l.name || "Unnamed Lead",
          phone: l.phone,
          company: l.company || undefined,
          service: l.service,
          status: l.status,
          source: l.source,
          priority: l.priority,
          assignedTo: l.assignedTo ? String(l.assignedTo) : "Unassigned",
          dealValue: l.dealValue ? `₹${l.dealValue.toLocaleString("en-IN")}` : undefined,
          city: l.city || undefined,
          createdDateIST: new Date(l.createdAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }),
          notesSnippet: l.notes ? wrapUntrustedData(l.notes.slice(0, 120)) : undefined,
        }));

        return JSON.stringify({
          totalMatchingCount: totalMatching,
          showingCount: formattedLeads.length,
          leads: formattedLeads,
        });
      } catch (error) {
        return JSON.stringify({ error: `Lead search failed: ${error.message}` });
      }
    },
    {
      name: "search_leads",
      description:
        "Searches and filters CRM leads by name, keyword, status, source, service, or priority. Returns matching leads with details. Never invent leads; use this tool whenever looking for specific leads or customer records.",
      schema: z.object({
        searchTerm: z
          .string()
          .max(100)
          .optional()
          .describe("Search keyword matching lead name, company, city, tags, or notes"),
        status: z
          .enum(["New", "Missed Call", "Follow Up", "Not Interested", "Not Attended", "Price Issue", "Converted"])
          .optional()
          .describe("Filter by lead lifecycle status"),
        source: z
          .enum(["Email", "WhatsApp", "Meta Ads", "Website Form", "Website Chat", "Call", "Manual Entry", "Mobile App", "Excel Import"])
          .optional()
          .describe("Filter by lead origination source"),
        service: z
          .string()
          .max(100)
          .optional()
          .describe("Filter by service/product name or category"),
        priority: z
          .enum(["High", "Medium", "Low"])
          .optional()
          .describe("Filter by priority level"),
        limit: z
          .number()
          .min(1)
          .max(25)
          .default(10)
          .describe("Maximum number of leads to return (1-25)"),
      }),
    }
  );
};
