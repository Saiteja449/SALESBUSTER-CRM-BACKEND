import { createDashboardAnalyticsTool } from "./dashboardAnalyticsTool.js";
import { createLeadSearchTool } from "./leadSearchTool.js";
import { createPhoneLookupTool } from "./phoneLookupTool.js";
import { createSalesPerformanceTool } from "./salesPerformanceTool.js";
import { createFollowupTool } from "./followupTool.js";
import { createWhatsAppAnalyticsTool } from "./whatsappAnalyticsTool.js";
import { createOrgConfigTool } from "./orgConfigTool.js";
import { createCRMRAGTool } from "./crmRAGTool.js";

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
    toolsByName[t.name] = t;
  }

  return { tools, toolsByName };
};
