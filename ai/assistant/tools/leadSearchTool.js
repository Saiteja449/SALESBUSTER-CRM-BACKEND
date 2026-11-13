import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { searchLeadsAdvanced } from "../analytics/crmAnalyticsService.js";

/**
 * Creates Lead Search & Advanced Discovery tool bound to authenticated tenant context.
 * Used for both search_leads and search_leads_advanced.
 */
export const createLeadSearchTool = ({ tenantModels, toolName = "search_leads" }) => {
  return tool(
    async ({
      searchTerm,
      salespersonNameOrId,
      status,
      source,
      service,
      priority,
      period,
      startDate,
      endDate,
      callStatusFilter,
      followupStatusFilter,
      inactiveDays,
      unassignedOnly = false,
      page = 1,
      limit = 10,
    }) => {
      try {
        const result = await searchLeadsAdvanced({
          tenantModels,
          filters: {
            searchTerm,
            salespersonNameOrId,
            status,
            source,
            service,
            priority,
            period,
            startDate,
            endDate,
            callStatusFilter,
            followupStatusFilter,
            inactiveDays,
            unassignedOnly,
          },
          pagination: { page, limit },
        });
        return JSON.stringify(result);
      } catch (error) {
        return JSON.stringify({ error: `Lead search failed: ${error.message}` });
      }
    },
    {
      name: toolName,
      description:
        "Searches and filters CRM leads with rich multi-filter criteria: assigned salesperson name or ID, creation date range, last activity date, lead status (New, Missed Call, Follow Up, Converted, Lost), source (Call, WhatsApp, Meta Ads, etc.), service, priority, customer name or phone, call history status (has_calls, has_missed_calls, never_called), follow-up status (overdue, pending_today, no_followup), inactive days (e.g. leads not contacted for 7 days), or unassigned leads. Returns total matching counts and paginated leads with resolved human names. Internal IDs are for tooling only; never expose MongoDB ObjectIds to the user.",
      schema: z.object({
        searchTerm: z.string().optional().describe("Free-text search across name, company, notes, phone, city"),
        salespersonNameOrId: z.string().optional().describe("Filter by assigned salesperson name or ID (e.g. Shanmukh)"),
        status: z.string().optional().describe("Lead status filter (e.g. 'New', 'Converted', 'Missed Call', 'Follow Up', 'Not Interested')"),
        source: z.string().optional().describe("Lead acquisition source (e.g. 'Call', 'WhatsApp', 'Meta Ads', 'Website Form')"),
        service: z.string().optional().describe("Service inquiry filter (e.g. 'General Enquiry', specific service name)"),
        priority: z.enum(["High", "Medium", "Low", "all"]).optional().describe("Priority level"),
        period: z.string().optional().describe("Creation time period: 'all_time', 'this_month', 'last_month', 'today', 'yesterday', 'this_week', 'custom'"),
        startDate: z.string().optional().describe("Creation start date in YYYY-MM-DD format"),
        endDate: z.string().optional().describe("Creation end date in YYYY-MM-DD format"),
        callStatusFilter: z.enum(["has_calls", "has_missed_calls", "never_called", "all"]).optional().describe("Filter by call history interaction"),
        followupStatusFilter: z.enum(["overdue", "pending_today", "today", "has_pending", "completed", "no_followup", "no_pending_followup", "no_pending", "all"]).optional().describe("Filter by scheduled follow-up status: 'no_followup' (never had any followup), 'no_pending_followup' (no active pending followup), 'overdue', 'pending_today', or 'completed'"),
        inactiveDays: z.union([z.number(), z.string()]).optional().describe("Find leads with no activity or call for at least this many days (e.g. 7)"),
        unassignedOnly: z.boolean().default(false).describe("Set true to find leads with no assigned salesperson"),
        page: z.number().default(1).describe("Pagination page number (1-indexed)"),
        limit: z.number().default(10).describe("Number of leads per page (max 25)"),
      }),
    }
  );
};

export const createAdvancedLeadSearchTool = ({ tenantModels }) =>
  createLeadSearchTool({ tenantModels, toolName: "search_leads_advanced" });
