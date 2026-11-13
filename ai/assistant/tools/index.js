import { createDashboardAnalyticsTool } from "./dashboardAnalyticsTool.js";
import { createLeadSearchTool, createAdvancedLeadSearchTool } from "./leadSearchTool.js";
import { createPhoneLookupTool } from "./phoneLookupTool.js";
import { createSalesPerformanceTool } from "./salesPerformanceTool.js";
import { createFollowupTool } from "./followupTool.js";
import {
  createWhatsAppAnalyticsTool,
  createWhatsAppConnectionStatusTool,
  createSearchConversationsTool,
  createConversationMessagesTool,
  createSummarizeConversationTool,
} from "./whatsappAnalyticsTool.js";
import { createOrgConfigTool } from "./orgConfigTool.js";
import { createCRMRAGTool } from "./crmRAGTool.js";
import { createClarificationTool } from "./clarificationTool.js";
import { createEmailReportTools } from "./emailReportTool.js";
import { createCRMOverviewTool } from "./crmOverviewTool.js";
import { createCallRecordsTool } from "./callRecordsTool.js";
import { createMissedCallAnalyticsTool } from "./missedCallAnalyticsTool.js";
import { createConversionAnalyticsTool } from "./conversionAnalyticsTool.js";
import { createRecordingAnalyticsTool } from "./recordingAnalyticsTool.js";

/**
 * Metadata descriptor map for production tool execution guarantees
 */
export const TOOL_METADATA = {
  get_crm_overview: { isReadOnly: true, sideEffect: false, timeoutMs: 7000 },
  get_dashboard_kpis: { isReadOnly: true, sideEffect: false, timeoutMs: 6000 },
  get_salesperson_analytics: { isReadOnly: true, sideEffect: false, timeoutMs: 7000 },
  get_salesperson_performance: { isReadOnly: true, sideEffect: false, timeoutMs: 7000 },
  search_leads_advanced: { isReadOnly: true, sideEffect: false, timeoutMs: 7000 },
  search_leads: { isReadOnly: true, sideEffect: false, timeoutMs: 6000 },
  search_call_records: { isReadOnly: true, sideEffect: false, timeoutMs: 7000 },
  get_missed_call_analytics: { isReadOnly: true, sideEffect: false, timeoutMs: 7000 },
  get_followup_analytics: { isReadOnly: true, sideEffect: false, timeoutMs: 6000 },
  get_followup_status: { isReadOnly: true, sideEffect: false, timeoutMs: 5000 },
  get_conversion_analytics: { isReadOnly: true, sideEffect: false, timeoutMs: 6000 },
  get_recording_analytics: { isReadOnly: true, sideEffect: false, timeoutMs: 6000 },
  get_whatsapp_analytics: { isReadOnly: true, sideEffect: false, timeoutMs: 6000 },
  get_whatsapp_connection_status: { isReadOnly: true, sideEffect: false, timeoutMs: 6000 },
  search_whatsapp_conversations: { isReadOnly: true, sideEffect: false, timeoutMs: 6000 },
  get_conversation_messages: { isReadOnly: true, sideEffect: false, timeoutMs: 6000 },
  summarize_whatsapp_conversation: { isReadOnly: true, sideEffect: false, timeoutMs: 7000 },
  lookup_phone_number: { isReadOnly: true, sideEffect: false, timeoutMs: 5000 },
  get_org_integrations_and_config: { isReadOnly: true, sideEffect: false, timeoutMs: 5000 },
  search_crm_documentation_and_features: { isReadOnly: true, sideEffect: false, timeoutMs: 7500 },
  ask_clarification: { isReadOnly: true, sideEffect: false, timeoutMs: 3000 },
  compose_salesperson_report_email: { isReadOnly: false, sideEffect: true, timeoutMs: 8000 },
  confirm_send_email_report: { isReadOnly: false, sideEffect: true, timeoutMs: 10000 },
};

/**
 * Builds the modular tool suite bound strictly to authenticated tenant context.
 * Exposes single preferred canonical tools to the LLM while retaining 100% backward compatibility
 * in toolsByName for legacy workflows and tests.
 */
export const buildAssistantTools = ({ tenantModels, organization, user, socket }) => {
  const { composeTool, confirmTool } = createEmailReportTools({
    tenantModels,
    organization,
    user,
    socket,
  });

  // 1. Preferred Canonical Tools exposed to Gemini
  const canonicalTools = [
    createCRMOverviewTool({ tenantModels }),
    createMissedCallAnalyticsTool({ tenantModels }),
    createCallRecordsTool({ tenantModels }),
    createSalesPerformanceTool({ tenantModels, toolName: "get_salesperson_analytics" }),
    createAdvancedLeadSearchTool({ tenantModels }),
    createFollowupTool({ tenantModels, toolName: "get_followup_analytics" }),
    createConversionAnalyticsTool({ tenantModels }),
    createRecordingAnalyticsTool({ tenantModels }),
    createWhatsAppAnalyticsTool({ tenantModels, organization }),
    createWhatsAppConnectionStatusTool({ tenantModels, organization }),
    createSearchConversationsTool({ tenantModels }),
    createConversationMessagesTool({ tenantModels }),
    createSummarizeConversationTool({ tenantModels }),
    createPhoneLookupTool({ tenantModels }),
    createOrgConfigTool({ organization, tenantModels }),
    createCRMRAGTool({ organization }),
    createClarificationTool(),
    composeTool,
    confirmTool,
  ];

  // 2. Legacy overlapping tools preserved for backward compatibility
  const legacyTools = [
    createDashboardAnalyticsTool({ tenantModels }),
    createSalesPerformanceTool({ tenantModels, toolName: "get_salesperson_performance" }),
    createLeadSearchTool({ tenantModels }),
    createFollowupTool({ tenantModels, toolName: "get_followup_status" }),
  ];

  const allTools = [...canonicalTools, ...legacyTools];
  const toolsByName = {};
  for (const t of allTools) {
    t.metadata = TOOL_METADATA[t.name] || { isReadOnly: true, sideEffect: false, timeoutMs: 6000 };
    toolsByName[t.name] = t;
  }

  return {
    tools: canonicalTools,
    toolsByName,
    allTools,
  };
};
