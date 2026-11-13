import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { searchCallRecords } from "../analytics/crmAnalyticsService.js";

/**
 * Creates Individual Call Record Search tool bound to authenticated tenant context
 */
export const createCallRecordsTool = ({ tenantModels }) => {
  return tool(
    async ({
      salespersonNameOrId,
      customerName,
      customerPhone,
      callType,
      callStatus,
      period = "all_time",
      startDate,
      endDate,
      leadId,
      recordingAvailable,
      source,
      page = 1,
      limit = 10,
    }) => {
      try {
        const result = await searchCallRecords({
          tenantModels,
          filters: {
            salespersonNameOrId,
            customerName,
            customerPhone,
            callType,
            callStatus,
            period,
            startDate,
            endDate,
            leadId,
            recordingAvailable,
            source,
          },
          pagination: { page, limit },
        });
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({ error: `Call search failed: ${err.message}` });
      }
    },
    {
      name: "search_call_records",
      description:
        "Searches individual call records and event logs. Filters by salesperson ID or name, customer phone or name, call type (incoming, outgoing, missed), call status (connected, missed, rejected, not-connected), date range (e.g. between November 1 and November 5), recording availability, and source. Supports pagination. Internal IDs are for tooling only; never expose MongoDB ObjectIds to the user. Always use resolved human names.",
      schema: z.object({
        salespersonNameOrId: z.string().optional().describe("Salesperson name or ID to filter calls by"),
        customerName: z.string().optional().describe("Customer or caller name"),
        customerPhone: z.string().optional().describe("Customer phone number or last 10 digits"),
        callType: z.enum(["incoming", "outgoing", "missed", "all"]).optional().describe("Type of call"),
        callStatus: z.enum(["connected", "missed", "rejected", "not-connected", "all"]).optional().describe("Outcome/status of call"),
        period: z.string().optional().describe("Period e.g. 'all_time', 'this_month', 'today', 'yesterday', 'last_month', 'custom'"),
        startDate: z.string().optional().describe("Start date in YYYY-MM-DD format"),
        endDate: z.string().optional().describe("End date in YYYY-MM-DD format"),
        leadId: z.string().optional().describe("Specific Lead ObjectId"),
        recordingAvailable: z.boolean().optional().describe("Whether call recording file is attached"),
        source: z.string().optional().describe("Call origin source e.g. Call, Dialer"),
        page: z.number().default(1).describe("Pagination page number (1-indexed)"),
        limit: z.number().default(10).describe("Number of records to return per page (1-25)"),
      }),
    }
  );
};

