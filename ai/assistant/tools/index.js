import { createDashboardAnalyticsTool } from "./dashboardAnalyticsTool.js";
import { createLeadSearchTool } from "./leadSearchTool.js";
import { createPhoneLookupTool } from "./phoneLookupTool.js";
import { createSalesPerformanceTool } from "./salesPerformanceTool.js";
import { createFollowupTool } from "./followupTool.js";
import { createWhatsAppAnalyticsTool } from "./whatsappAnalyticsTool.js";
import { createOrgConfigTool } from "./orgConfigTool.js";
import { createCRMRAGTool } from "./crmRAGTool.js";

/**
 * Metadata descriptor map for production tool execution guarantees
 */
export const TOOL_METADATA = {
  get_dashboard_kpis: { isReadOnly: true, sideEffect: false, timeoutMs: 6000 },
  get_salesperson_performance: { isReadOnly: true, sideEffect: false, timeoutMs: 7000 },
  search_leads: { isReadOnly: true, sideEffect: false, timeoutMs: 6000 },
  lookup_phone_number: { isReadOnly: true, sideEffect: false, timeoutMs: 5000 },
  get_followup_status: { isReadOnly: true, sideEffect: false, timeoutMs: 5000 },
  get_whatsapp_analytics: { isReadOnly: true, sideEffect: false, timeoutMs: 6000 },
  get_org_integrations_and_config: { isReadOnly: true, sideEffect: false, timeoutMs: 5000 },
  search_crm_documentation_and_features: { isReadOnly: true, sideEffect: false, timeoutMs: 7500 },
};

/**
 * Builds the modular tool suite bound strictly to authenticated tenant context
 */
export const buildAssistantTools = ({ tenantModels, organization, user }) => {
  const tools = [
    createDashboardAnalyticsTool({ tenantModels }),
    createLeadSearchTool({ tenantModels }),
    createPhoneLookupTool({ tenantModels }),
    createSalesPerformanceTool({ tenantModels }),
    createFollowupTool({ tenantModels }),
    createWhatsAppAnalyticsTool({ tenantModels }),
    createOrgConfigTool({ organization, tenantModels }),
    createCRMRAGTool({ organization }),
  ];

  const toolsByName = {};
  for (const t of tools) {
    t.metadata = TOOL_METADATA[t.name] || { isReadOnly: true, sideEffect: false, timeoutMs: 6000 };
    toolsByName[t.name] = t;
  }

  return { tools, toolsByName };
};
