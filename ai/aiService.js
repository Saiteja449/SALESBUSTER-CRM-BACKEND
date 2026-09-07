import {
  GoogleGenerativeAIEmbeddings,
  ChatGoogleGenerativeAI,
} from "@langchain/google-genai";
import { QdrantVectorStore } from "@langchain/qdrant";
import { VoyageAIClient } from "voyageai";
import { QdrantClient } from "@qdrant/js-client-rest";
import { z } from "zod";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

import Lead from "../models/Lead.js";
import Message from "../models/Message.js";
import AILog from "../models/AILog.js";
import Followup from "../models/Followup.js";
import Notification from "../models/Notification.js";
import User from "../models/User.js";
import AssignmentState from "../models/AssignmentState.js";
import Organization, { getDefaultAISettings } from "../models/Organization.js";
import { getMasterModels } from "../services/tenantManager.js";
import { getOrgCollectionName } from "../services/knowledgeService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

// In-memory cache for Qdrant vector stores per collection
const vectorStoresMap = new Map();

/**
 * Connects or returns cached Qdrant Vector Store for the organization's collection
 */
export const getVectorStoreForOrg = async (organization) => {
  const collectionName = getOrgCollectionName(organization);

  if (vectorStoresMap.has(collectionName)) {
    return vectorStoresMap.get(collectionName);
  }

  try {
    const qdrantUrl = process.env.CLUSTER_ENDPOINT;
    const qdrantApiKey = process.env.QDRANT_API_KEY;
    const geminiApiKey = process.env.GEMINI_API_KEY;

    if (!qdrantUrl || !qdrantApiKey || !geminiApiKey) {
      console.warn("Qdrant or Gemini API keys missing. RAG context will be empty.");
      return null;
    }

    const client = new QdrantClient({
      url: qdrantUrl,
      apiKey: qdrantApiKey,
    });

    // Check if the collection exists
    const collectionsRes = await client.getCollections();
    const exists = collectionsRes.collections?.some((c) => c.name === collectionName);

    if (!exists) {
      if (collectionName === "kranthi_kb") {
        console.warn("Collection 'kranthi_kb' not found in Qdrant.");
      }
      return null;
    }

    const embeddings = new GoogleGenerativeAIEmbeddings({
      apiKey: geminiApiKey,
      model: "gemini-embedding-2",
    });

    const store = new QdrantVectorStore(embeddings, {
      client,
      collectionName,
    });

    vectorStoresMap.set(collectionName, store);
    return store;
  } catch (e) {
    console.warn(`Qdrant store initialization failed for '${collectionName}':`, e.message);
    return null;
  }
};

/**
 * Resolves the Organization document from passed context or tenant models
 */
export const resolveOrganization = async (organizationContext, tenantModels = null) => {
  if (organizationContext && typeof organizationContext === "object" && organizationContext.name) {
    return organizationContext;
  }

  const { Organization: MasterOrg } = getMasterModels();

  if (typeof organizationContext === "string") {
    try {
      const org = await MasterOrg.findById(organizationContext);
      if (org) return org;
    } catch (err) {}
  }

  const dbName = tenantModels?.db?.name;
  if (dbName) {
    try {
      const org = await MasterOrg.findOne({ tenantDbName: dbName });
      if (org) return org;
    } catch (err) {}
  }

  // Fallback to Kranthi Elevators or first registered organization
  try {
    let org = await MasterOrg.findOne({ name: /kranthi/i });
    if (!org) {
      org = await MasterOrg.findOne();
    }
    if (org) return org;
  } catch (err) {}

  return null;
};

/**
 * Dynamically builds a Zod Structured Output schema based on the organization's qualification schema
 */
export const buildQualificationSchema = (configuredFields = [], orgName = "") => {
  const shape = {
    city: z
      .string()
      .default("")
      .describe("City, neighborhood, or location of the lead if mentioned."),
    intent: z
      .string()
      .default("")
      .describe("Primary intent or service requested by the user."),
    urgency: z
      .enum(["High", "Medium", "Low"])
      .default("Medium")
      .describe("High, Medium, or Low urgency based on context."),
    interestScore: z
      .number()
      .default(5)
      .describe("1 to 10 interest score based on engagement."),
    preferredCallDate: z
      .string()
      .default("")
      .describe("Preferred callback date when lead requests pricing or consultation."),
    preferredCallTime: z
      .string()
      .default("")
      .describe("Preferred callback time (e.g., '11:00 AM', 'after 5 PM')."),
  };

  if (configuredFields && configuredFields.length > 0) {
    for (const f of configuredFields) {
      if (!f.key || shape[f.key]) continue;

      const desc =
        (f.description || f.label || f.key) +
        (f.options && f.options.length
          ? `. Allowed options: ${f.options.join(", ")}`
          : "");

      if (f.type === "number") {
        shape[f.key] = z.number().default(0).describe(desc);
      } else if (f.type === "boolean") {
        shape[f.key] = z.boolean().default(false).describe(desc);
      } else {
        shape[f.key] = z.string().default("").describe(desc);
      }
    }
  } else if (/kranthi|elevator/i.test(orgName)) {
    shape.liftType = z
      .string()
      .default("")
      .describe(
        "Type of elevator product: 'Passenger Lift', 'MRL Lift', 'Hydraulic Lift', 'Hospital Bed Lift', 'Elevator Maintenance & AMC', 'Elevator Modernization', or empty string.",
      );
    shape.clientType = z
      .string()
      .default("General")
      .describe(
        "Role/Segment of the lead: 'Building Owner / Villa Owner', 'Builder / Developer', 'Architect / Consultant', 'Hospital / Healthcare Admin', 'Facility / Society Manager (RWA)', or 'General'.",
      );
    shape.propertyType = z
      .string()
      .default("")
      .describe(
        "Type of building: 'Apartment', 'Villa / Independent House', 'Commercial Office', 'Shopping Mall / Complex', 'Hotel', 'Hospital / Healthcare Center', 'Warehouse / Industrial Unit'.",
      );
    shape.numberOfFloors = z
      .string()
      .default("")
      .describe("Number of floors or stops (e.g., 'G+2', 'G+3', '4 Floors', '8 Stops').");
    shape.capacity = z
      .string()
      .default("")
      .describe("Passenger capacity or weight load (e.g., '4-6 Persons', '1000 kg', '2-10 Tons').");
    shape.constructionStage = z
      .string()
      .default("")
      .describe(
        "Project stage: 'Under Construction (Shaft Planned/Ready)', 'Existing Building (Retrofit/New Lift)', 'Modernization (Replacing Old Lift)', or 'Operational (AMC/Service)'.",
      );
    shape.doorType = z
      .string()
      .default("")
      .describe("Door preference: 'Automatic (Center Opening)', 'Automatic (Telescopic)', 'Manual', or empty.");
    shape.machineRoomAvailable = z
      .string()
      .default("")
      .describe("Machine room availability: 'Yes', 'No' (MRL recommended), or 'Unknown'.");
    shape.propertySize = z
      .string()
      .default("")
      .describe("Approximate building or shaft dimensions if mentioned.");
    shape.issueDescription = z
      .string()
      .default("")
      .describe("Specific requirement or problem description.");
    shape.preferredVisitDate = z
      .string()
      .default("")
      .describe("Preferred date for site visit / shaft inspection.");
  }

  return z.object({
    reply: z
      .string()
      .describe(
        "Your reply text to the user. Provide comprehensive answers and guide the user naturally without forcing unnecessary questions.",
      ),
    qualification: z.object(shape).default({}),
    tags: z
      .array(z.string())
      .default([])
      .describe("Relevant tags (e.g., 'Hot Lead', 'Interested')."),
    disableAI: z
      .boolean()
      .default(false)
      .describe(
        "Set to true if user asks for human/support, confirms 'yes' to support team offer, or if AI cannot answer.",
      ),
    summary: z
      .string()
      .default("")
      .describe("One sentence summary of the conversation so far."),
    sentiment: z
      .string()
      .default("Neutral")
      .describe("Positive, Neutral, or Negative."),
    probabilityOfConversion: z
      .number()
      .default(50)
      .describe("0 to 100 estimated probability."),
    nextAction: z.string().default("").describe("Next step for the sales team."),
    triggerActions: z
      .object({
        createFollowUp: z
          .boolean()
          .default(false)
          .describe("Set true if user asked for a callback."),
        followUpNotes: z.string().default("").describe("Notes for the callback."),
        followUpDate: z
          .string()
          .default("")
          .describe("Date string for follow up if requested."),
        addNote: z
          .string()
          .default("")
          .describe("Any specific notes for the CRM lead record."),
      })
      .default({
        createFollowUp: false,
        followUpNotes: "",
        followUpDate: "",
        addNote: "",
      }),
  });
};

/**
 * Dynamically constructs the system prompt customized to the organization
 */
export const buildSystemPrompt = ({
  organization,
  effectiveSettings,
  lead,
  assignedRep,
  totalMessagesCount,
  chatHistoryLog,
  lastAgentMessageText,
  incomingText,
  ragContext,
}) => {
  const companyName =
    effectiveSettings.companyName || organization?.name || "Our Company";
  const businessDesc =
    effectiveSettings.businessDescription ||
    "We provide high-quality products and professional services tailored to our clients.";
  const agentPersona =
    effectiveSettings.agentPersona || "friendly, human sales representative";
  const services = effectiveSettings.services || [];
  const qualFields = effectiveSettings.qualificationFields || [];

  let servicesBlock = "";
  if (services.length > 0) {
    servicesBlock =
      "CORE PRODUCTS & SERVICES:\n" +
      services
        .map((s, idx) => {
          const sName = typeof s === "string" ? s : s.name;
          const sDesc =
            typeof s === "object" && s.description ? `: ${s.description}` : "";
          return `${idx + 1}. ${sName}${sDesc}`;
        })
        .join("\n");
  }

  let qualGoalsBlock = "";
  if (qualFields.length > 0) {
    qualGoalsBlock =
      "LEAD QUALIFICATION GOALS (Gather naturally across turns):\n" +
      qualFields
        .map((f, idx) => {
          const opts =
            f.options && f.options.length
              ? ` (Allowed Options: ${f.options.join(", ")})`
              : "";
          const req = f.required ? " [MANDATORY]" : "";
          return `${idx + 1}. ${f.label || f.key}: ${f.description || f.label || f.key}${opts}${req}`;
        })
        .join("\n");
  }

  const prevQual = lead.aiQualification || {};
  let alreadyCollectedBlock = "";
  if (qualFields.length > 0) {
    alreadyCollectedBlock = qualFields
      .map((f) => {
        const val = prevQual[f.key];
        return `- ${f.label || f.key}: ${val ? String(val) : "Missing"}`;
      })
      .join("\n");
  } else {
    alreadyCollectedBlock = Object.entries(prevQual)
      .filter(([k]) => !["_id", "__v"].includes(k))
      .map(([k, v]) => `- ${k}: ${v || "Missing"}`)
      .join("\n");
  }

  if (prevQual.city && !alreadyCollectedBlock.includes("City")) {
    alreadyCollectedBlock += `\n- City: ${prevQual.city}`;
  }
  if (prevQual.intent && !alreadyCollectedBlock.includes("Intent")) {
    alreadyCollectedBlock += `\n- Intent: ${prevQual.intent}`;
  }
  if (prevQual.preferredCallDate || prevQual.preferredCallTime) {
    alreadyCollectedBlock += `\n- Callback: ${prevQual.preferredCallDate || ""} ${prevQual.preferredCallTime || ""}`;
  }

  const customRules =
    effectiveSettings.customInstructions ||
    `1. HUMAN TONE: Communicate EXACTLY like a real human. Be warm, polite, and conversational. NEVER mention that you are an AI or bot.
2. PACING: Ask at most 1-2 friendly questions per message to gather data naturally without overwhelming the user.
3. PRICING RULE: Do NOT invent, guess, or negotiate pricing. State that pricing depends on individual specifications, and schedule a callback with our team.
4. HUMAN HANDOFF: If the user asks for human support or says 'yes' to human assistance, politely transfer them and set disableAI=true.
5. WHATSAPP FORMATTING: Keep messages short (maximum 50-60 words), clean bullet points, bold key terms (*term*), and emojis.`;

  return `You are a ${agentPersona} working at ${companyName}.

COMPANY OVERVIEW & VALUE PROPOSITION:
${businessDesc}

${servicesBlock}

${qualGoalsBlock ? `${qualGoalsBlock}\n` : ""}KNOWLEDGE BASE CONTEXT:
${ragContext || "(General Knowledge Base Active)"}

LEAD CONTEXT:
Name: ${lead.name} | Phone: ${lead.phone} | Rep: ${assignedRep}
Total Conversation Turns: ${totalMessagesCount}
Already Collected:
${alreadyCollectedBlock || "(None)"}

HISTORY:
${chatHistoryLog || "(None)"}

LAST AGENT MSG: "${lastAgentMessageText}"
USER MSG: "${incomingText}"

CRITICAL RULES:
${customRules}

FIRST MESSAGE REQUIREMENT:
If this is the first interaction (Total Conversation Turns is 1 or 0) and the user has not mentioned a specific product or requirement, you MUST introduce ${companyName}, briefly present our core services as a numbered list, and invite them to pick an option or describe their need!

OUTPUT:
Respond purely via the structured JSON schema.`;
};

/**
 * Main AI response generation entrypoint
 */
export const generateAIResponse = async (
  leadId,
  incomingText,
  tenantModels = null,
  organizationContext = null,
) => {
  try {
    const LeadModel = tenantModels?.Lead || Lead;
    const UserModel = tenantModels?.User || User;
    const AssignmentStateModel =
      tenantModels?.AssignmentState || AssignmentState;
    const NotificationModel = tenantModels?.Notification || Notification;
    const MessageModel = tenantModels?.Message || Message;
    const AILogModel = tenantModels?.AILog || AILog;
    const FollowupModel = tenantModels?.Followup || Followup;

    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      console.error("GEMINI_API_KEY is not defined in environment variables.");
    }

    const lead = await LeadModel.findById(leadId);
    if (!lead) {
      throw new Error(`Lead not found with ID: ${leadId}`);
    }

    // Resolve Organization
    const organization = await resolveOrganization(organizationContext, tenantModels);
    const defaults = getDefaultAISettings(organization?.name || "");

    // Check if AI setup has been completed for this organization
    const isConfigured =
      organization?.aiSettings?.isAiConfigured !== undefined
        ? organization.aiSettings.isAiConfigured
        : defaults.isAiConfigured;

    if (!isConfigured) {
      console.warn(
        `[AI Service] AI response paused for ${organization?.name || "organization"}: AI setup is incomplete.`
      );
      return "Thank you for reaching out! Our team is currently finalizing our automated assistant. A sales representative will be with you shortly.";
    }

    const effectiveSettings = {
      companyName:
        organization?.aiSettings?.companyName ||
        defaults.companyName ||
        organization?.name ||
        "Our Company",
      businessDescription:
        organization?.aiSettings?.businessDescription ||
        defaults.businessDescription,
      agentPersona:
        organization?.aiSettings?.agentPersona || defaults.agentPersona,
      customInstructions:
        organization?.aiSettings?.customInstructions ||
        defaults.customInstructions,
      services:
        organization?.aiSettings?.services &&
        organization.aiSettings.services.length > 0
          ? organization.aiSettings.services
          : defaults.services,
      qualificationFields:
        organization?.aiSettings?.qualificationFields &&
        organization.aiSettings.qualificationFields.length > 0
          ? organization.aiSettings.qualificationFields
          : defaults.qualificationFields,
      qdrantCollection:
        organization?.aiSettings?.qdrantCollection ||
        defaults.qdrantCollection,
    };

    // Auto-assign representative if unassigned
    let assignedRep = lead.assignedTo;
    if (!assignedRep || assignedRep === "Unassigned") {
      const representatives = await UserModel.find({
        role: "sales person",
      }).sort({ _id: 1 });
      if (representatives && representatives.length > 0) {
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
        if (nextIndex >= representatives.length) nextIndex = 0;

        assignedRep = representatives[nextIndex].name;
        state.lastAssignedIndex = nextIndex;
        await state.save();

        lead.assignedTo = assignedRep;
        await lead.save();

        const assignedAgent = await UserModel.findOne({ name: assignedRep });
        const targetUsers = assignedAgent ? [assignedAgent._id] : [];
        await NotificationModel.create({
          title: "Lead Assigned by AI",
          message: `Lead ${lead.name} has been assigned to ${assignedRep}.`,
          type: "lead_update",
          targetRoles: ["sales manager"],
          targetUsers: targetUsers,
        });
      } else {
        assignedRep = "Our team";
      }
    }

    const modelGeminiPrimary = new ChatGoogleGenerativeAI({
      model: "gemini-3.1-flash-lite",
      temperature: 0,
      maxOutputTokens: 1500,
      apiKey: geminiApiKey,
    });

    // History
    const totalMessagesCount = await MessageModel.countDocuments({ leadId });
    const historyDocs = await MessageModel.find({ leadId })
      .sort({ timestamp: -1 })
      .limit(8);
    const history = historyDocs.reverse();
    const formattedHistory = history.map((msg) => ({
      role: msg.direction === "incoming" ? "user" : "model",
      text: msg.text,
    }));
    const chatHistoryLog = formattedHistory
      .map((h) => `${h.role === "user" ? "Customer" : "AI Agent"}: ${h.text}`)
      .join("\n");

    const lastAgentMessage = [...formattedHistory]
      .reverse()
      .find((h) => h.role === "model");
    const lastAgentMessageText = lastAgentMessage
      ? lastAgentMessage.text
      : "(none — this is the first message to this lead)";

    // LLM Query Rewriting for Better RAG
    let optimizedSearchQuery = incomingText.trim();
    if (chatHistoryLog && incomingText.split(" ").length < 6) {
      try {
        const rewritePrompt = `Given the following conversation history and the latest user message, rewrite the latest message into a standalone, detailed search query that can be used to search a vector database. Only return the search query and nothing else. Do not answer the question.
History:
${chatHistoryLog}
Latest Message: ${incomingText}`;
        const rewriteRes = await modelGeminiPrimary.invoke([
          ["user", rewritePrompt],
        ]);
        if (rewriteRes && rewriteRes.content) {
          optimizedSearchQuery = rewriteRes.content.trim();
        }
      } catch (err) {
        console.warn(
          "Query rewrite failed, falling back to original text.",
          err.message,
        );
      }
    }

    // Dynamic RAG Context Retrieval from Organization Qdrant Vector Store
    const vs = await getVectorStoreForOrg(organization);
    let ragContext = "";
    if (vs) {
      const userIntent = lead.aiQualification?.intent || lead.service || "";
      const finalSearchQuery = userIntent
        ? `${userIntent} ${optimizedSearchQuery}`
        : optimizedSearchQuery;

      try {
        const results = await vs.similaritySearch(finalSearchQuery, 15);
        const documents = results.map((r) => r.pageContent);

        if (documents.length > 0 && process.env.VOYAGE_API_KEY) {
          try {
            const voyageClient = new VoyageAIClient({
              apiKey: process.env.VOYAGE_API_KEY,
            });
            const rerankRes = await voyageClient.rerank({
              query: finalSearchQuery,
              documents: documents,
              model: "rerank-2.5",
              topK: 5,
            });
            if (rerankRes.data) {
              ragContext = rerankRes.data
                .map((item) => item.document || documents[item.index])
                .join("\n\n");
            } else {
              ragContext = documents.slice(0, 5).join("\n\n");
            }
          } catch (rerankError) {
            console.warn("Voyage reranking failed:", rerankError.message);
            ragContext = documents.slice(0, 5).join("\n\n");
          }
        } else if (documents.length > 0) {
          ragContext = documents.slice(0, 5).join("\n\n");
        }
      } catch (searchErr) {
        console.warn("Qdrant similarity search warning:", searchErr.message);
      }
    }

    // Build Dynamic Qualification Schema & System Prompt
    const qualificationSchema = buildQualificationSchema(
      effectiveSettings.qualificationFields,
      effectiveSettings.companyName,
    );

    const systemPrompt = buildSystemPrompt({
      organization,
      effectiveSettings,
      lead,
      assignedRep,
      totalMessagesCount,
      chatHistoryLog,
      lastAgentMessageText,
      incomingText,
      ragContext,
    });

    let parsed = null;
    let lastError = null;

    console.log(`Generating AI response with Gemini for ${effectiveSettings.companyName}...`);

    try {
      const structuredModel =
        modelGeminiPrimary.withStructuredOutput(qualificationSchema);
      parsed = await structuredModel.invoke([
        ["system", systemPrompt],
        ["user", incomingText],
      ]);
      console.log("Success with model: Gemini");
    } catch (e) {
      lastError = e;
      console.warn("Model Gemini structured output failed. Error:", e.message);
    }

    if (!parsed) {
      console.error("All AI attempts failed. Using fallback.", lastError?.message);
      parsed = {
        reply:
          "I'm sorry, but I'm unable to assist with this request right now. I'll connect you with one of our team members, who will continue assisting you shortly.",
        disableAI: true,
        summary: "System failure. Handoff to human.",
        qualification: {},
        tags: [],
        sentiment: "Neutral",
        probabilityOfConversion: 50,
        nextAction: "Contact lead manually due to AI failure",
        triggerActions: {
          createFollowUp: false,
          followUpNotes: "",
          followUpDate: "",
          addNote: "",
        },
      };
    }

    // Record AI Log
    await AILogModel.create({
      leadId,
      prompt: systemPrompt + "\n\nUser Message: " + incomingText,
      response: JSON.stringify(parsed, null, 2),
      model: "gemini-3.1-flash-lite (Dynamic Multi-Tenant RAG)",
      tokensUsed: 0,
    });

    const updatePayload = {};

    if (parsed.qualification) {
      const aiData = parsed.qualification || {};
      const prevQual = lead.aiQualification || {};

      updatePayload.lastMessage = incomingText;
      updatePayload.lastActivity = new Date();

      // Deep merge dynamic qualification fields
      const mergedQual = { ...prevQual };
      for (const [key, val] of Object.entries(aiData)) {
        if (val !== undefined && val !== null && val !== "") {
          mergedQual[key] = val;
        }
      }
      updatePayload.aiQualification = mergedQual;

      // Dynamic Service Matching against configured services
      const services = effectiveSettings.services || [];
      const rawIntent = aiData.intent || aiData.service || aiData.liftType || "";
      let matchedService = null;

      // 1. Direct name match
      if (rawIntent) {
        matchedService = services.find(
          (s) => s.name.toLowerCase() === rawIntent.toLowerCase(),
        )?.name;
      }

      // 2. Numbered option matching (e.g. user typed "1" or "option 2")
      if (!matchedService) {
        const matchNumber =
          incomingText.trim().match(/^(?:option\s*|#)?([1-9][0-9]?)\.?$/i) ||
          incomingText.match(/\b([1-9][0-9]?)\b/);
        if (matchNumber) {
          const num = parseInt(matchNumber[1], 10);
          if (num >= 1 && num <= services.length) {
            matchedService = services[num - 1].name;
          }
        }
      }

      // 3. Keyword / partial matching
      if (!matchedService) {
        const combinedText = `${rawIntent} ${incomingText}`.toLowerCase();
        for (const s of services) {
          if (combinedText.includes(s.name.toLowerCase())) {
            matchedService = s.name;
            break;
          }
          if (s.keywords && s.keywords.length > 0) {
            const kwMatch = s.keywords.some((kw) =>
              combinedText.includes(kw.toLowerCase()),
            );
            if (kwMatch) {
              matchedService = s.name;
              break;
            }
          }
        }
      }

      if (matchedService) {
        updatePayload.service = matchedService;
      }

      const resolvedCity = aiData.city || prevQual.city;
      if (resolvedCity) updatePayload.city = resolvedCity;
    }

    if (parsed.tags && parsed.tags.length > 0) {
      const currentTags = lead.aiTags || [];
      const newTags = new Set([...currentTags, ...parsed.tags]);
      updatePayload.aiTags = Array.from(newTags);
    }

    if (parsed.summary) updatePayload.conversationSummary = parsed.summary;
    if (parsed.sentiment) updatePayload.sentiment = parsed.sentiment;
    if (parsed.probabilityOfConversion)
      updatePayload.probabilityOfConversion = parsed.probabilityOfConversion;
    if (parsed.nextAction) updatePayload.nextAction = parsed.nextAction;

    if (parsed.disableAI) {
      updatePayload.aiEnabled = false;
      await NotificationModel.create({
        title: "AI Disabled - Human Takeover Needed",
        message: `AI has been disabled for ${lead.name} (${lead.phone}) because they requested human support or the AI reached its limit.`,
        type: "lead_update",
        targetRoles: ["sales manager", "sales person"],
      });
    }

    await LeadModel.findByIdAndUpdate(leadId, updatePayload);

    // Trigger actions: follow-up
    if (
      parsed.triggerActions?.createFollowUp &&
      parsed.triggerActions?.followUpDate
    ) {
      const existingFollowUp = await FollowupModel.findOne({
        leadId,
        date: parsed.triggerActions.followUpDate,
      });

      if (!existingFollowUp) {
        await FollowupModel.create({
          leadId,
          leadName: lead.name,
          type: "WhatsApp",
          date: parsed.triggerActions.followUpDate,
          time: "10:00 AM",
          priority:
            parsed.qualification?.urgency === "High" ? "High" : "Medium",
          notes:
            parsed.triggerActions.followUpNotes ||
            "Follow-up scheduled by AI Agent",
          author: "AI Agent",
        });

        await NotificationModel.create({
          title: "Followup Created by AI",
          message: `AI Agent created a follow-up task for lead ${lead.name} on ${parsed.triggerActions.followUpDate}.`,
          type: "lead_update",
          targetRoles: ["sales manager", "sales person"],
        });
      }
    }

    // Trigger actions: CRM note
    if (parsed.triggerActions?.addNote) {
      await LeadModel.findByIdAndUpdate(leadId, {
        $set: {
          notes:
            (lead.notes || "") +
            "\n\n[AI Note]: " +
            parsed.triggerActions.addNote,
        },
      });
    }

    return (
      parsed.reply ||
      "I'm sorry, but I'm unable to assist with this request right now. I'll connect you with one of our team members, who will continue assisting you shortly."
    );
  } catch (error) {
    console.error("Error in AI Service generateAIResponse:", error);
    return "I'm sorry, but I'm unable to assist with this request right now. I'll connect you with one of our team members, who will continue assisting you shortly.";
  }
};
