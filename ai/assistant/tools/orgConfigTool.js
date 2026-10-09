import { tool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * Creates Organization Configuration & Integrations tool bound to authenticated tenant context
 */
export const createOrgConfigTool = ({ organization, tenantModels }) => {
  return tool(
    async () => {
      try {
        if (!organization) {
          return JSON.stringify({ error: "Organization context not available" });
        }

        const { WhatsAppSession: SessionModel } = tenantModels;

        // 1. WhatsApp Cloud API Status
        const cloud = organization.whatsappCloudSettings || {};
        const isCloudConfigured = Boolean(cloud.isConfigured);
        const cloudDetails = isCloudConfigured
          ? {
              status: "Connected",
              type: "Meta WhatsApp Cloud API (Official)",
              displayPhoneNumber: cloud.displayPhoneNumber || "Configured",
              verifiedName: cloud.verifiedName || organization.name,
              qualityRating: cloud.qualityRating || "UNKNOWN",
              messagingLimitTier: cloud.messagingLimitTier || "TIER_1K",
            }
          : { status: "Not Connected" };

        // 2. WhatsApp Baileys / QR Sessions
        let baileysSessionsCount = 0;
        let baileysActiveNumbers = [];
        if (SessionModel) {
          const sessions = await SessionModel.find({
            status: { $in: ["connected", "authenticated"] },
          })
            .select("sessionId phoneNumber status")
            .lean();
          baileysSessionsCount = sessions.length;
          baileysActiveNumbers = sessions.map((s) => s.phoneNumber || s.sessionId);
        }

        // 3. AI / Gemini Integration
        const ai = organization.aiSettings || {};
        const isAiConfigured = Boolean(ai.isAiConfigured);
        const knowledgeDocsCount = Array.isArray(ai.knowledgeDocs) ? ai.knowledgeDocs.length : 0;
        const catalogServicesCount = Array.isArray(ai.services) ? ai.services.length : 0;

        // 4. Subscription & Workspace
        const subscriptionPlan = organization.subscriptionPlan || "monthly";
        const totalSeats = organization.seats || 1;
        const expiryDateIST = organization.subscriptionEndDate
          ? new Date(organization.subscriptionEndDate).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })
          : "N/A";
        const orgStatus = organization.status || "active";

        return JSON.stringify({
          organizationName: organization.name,
          workspaceStatus: orgStatus,
          subscription: {
            plan: subscriptionPlan,
            seatsAllocated: totalSeats,
            subscriptionExpiresOnIST: expiryDateIST,
          },
          integrations: {
            metaWhatsAppCloudAPI: cloudDetails,
            whatsappWebDeviceSessions: {
              activeConnectedSessions: baileysSessionsCount,
              lineLimit: organization.whatsappLineLimit || 1,
              connectedNumbers: baileysActiveNumbers,
            },
            googleGeminiAI: {
              status: isAiConfigured ? "Configured & Active" : "Not Configured",
              knowledgeBaseDocumentsIndexed: knowledgeDocsCount,
              catalogProductsServicesCount: catalogServicesCount,
              dailyQuotaLimit: ai.dailyAiUsage?.dailyQuotaLimit || 1500,
              usedTodayCalls: ai.dailyAiUsage?.totalApiCalls || 0,
            },
          },
        });
      } catch (error) {
        return JSON.stringify({ error: `Organization config query failed: ${error.message}` });
      }
    },
    {
      name: "get_org_integrations_and_config",
      description:
        "Returns active integrations (WhatsApp Cloud API, WhatsApp Web devices, Gemini AI, Knowledge Base docs) and subscription details for this organization. Answers: 'Which integrations are connected to our organization?' and 'What is our subscription status?'.",
      schema: z.object({}),
    }
  );
};
