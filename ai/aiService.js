import {
  GoogleGenerativeAIEmbeddings,
  ChatGoogleGenerativeAI,
} from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

// Initialize Qdrant Vector Store Lazily
let qdrantVectorStore = null;

const initVectorStore = async () => {
  if (qdrantVectorStore) return qdrantVectorStore;

  try {
    const qdrantUrl = process.env.CLUSTER_ENDPOINT;
    const qdrantApiKey = process.env.QDRANT_API_KEY;

    if (!qdrantUrl || !qdrantApiKey) {
      console.warn(
        "QDRANT_URL or QDRANT_API_KEY not found in .env. RAG context will be empty.",
      );
      return null;
    }

    const client = new QdrantClient({
      url: qdrantUrl,
      apiKey: qdrantApiKey,
    });

    const embeddings = new GoogleGenerativeAIEmbeddings({
      apiKey: process.env.GEMINI_API_KEY,
      model: "gemini-embedding-2",
    });

    qdrantVectorStore = new QdrantVectorStore(embeddings, {
      client,
      collectionName: "kranthi_kb",
    });

    return qdrantVectorStore;
  } catch (e) {
    console.warn("Qdrant Vector store initialization failed:", e.message);
    return null;
  }
};

// Define Structured Output Schema
const qualificationSchema = z.object({
  reply: z
    .string()
    .describe(
      "Your reply text to the user. Provide comprehensive answers and guide the user naturally without forcing unnecessary questions.",
    ),
  qualification: z
    .object({
      liftType: z
        .string()
        .default("")
        .describe(
          "Type of elevator product: 'Passenger Lift', 'MRL Lift', 'Hydraulic Lift', 'Hospital Bed Lift', 'Elevator Maintenance & AMC', 'Elevator Modernization', or empty string.",
        ),
      clientType: z
        .string()
        .default("General")
        .describe(
          "Role/Segment of the lead: 'Building Owner / Villa Owner', 'Builder / Developer', 'Architect / Consultant', 'Hospital / Healthcare Admin', 'Facility / Society Manager (RWA)', or 'General'.",
        ),
      propertyType: z
        .string()
        .default("")
        .describe(
          "Type of building: 'Apartment', 'Villa / Independent House', 'Commercial Office', 'Shopping Mall / Complex', 'Hotel', 'Hospital / Healthcare Center', 'Warehouse / Industrial Unit'. Return empty string if not mentioned.",
        ),
      numberOfFloors: z
        .string()
        .default("")
        .describe(
          "Number of floors or stops (e.g., 'G+2', 'G+3', '4 Floors', '8 Stops'). Return empty string if not mentioned.",
        ),
      capacity: z
        .string()
        .default("")
        .describe(
          "Passenger capacity or weight load (e.g., '4-6 Persons', '8-10 Persons', '13 Persons', '1000 kg', '2-10 Tons', 'Stretcher Bed'). Return empty string if not mentioned.",
        ),
      constructionStage: z
        .string()
        .default("")
        .describe(
          "Project stage: 'Under Construction (Shaft Planned/Ready)', 'Existing Building (Retrofit/New Lift)', 'Modernization (Replacing Old Lift)', or 'Operational (AMC/Service)'. Return empty string if not mentioned.",
        ),
      doorType: z
        .string()
        .default("")
        .describe(
          "Door preference: 'Automatic (Center Opening)', 'Automatic (Telescopic)', 'Manual', or empty string if not mentioned.",
        ),
      machineRoomAvailable: z
        .string()
        .default("")
        .describe(
          "Machine room availability: 'Yes', 'No' (MRL recommended), or 'Unknown'.",
        ),
      propertySize: z
        .string()
        .default("")
        .describe("Approximate building or shaft dimensions if mentioned."),
      issueDescription: z
        .string()
        .default("")
        .describe(
          "Specific requirement or query (e.g., 'G+3 residential lift installation', 'AMC for hospital bed lift', 'space-saving lift for villa').",
        ),
      preferredVisitDate: z
        .string()
        .default("")
        .describe("Preferred date for site visit / shaft inspection."),
      preferredCallDate: z
        .string()
        .default("")
        .describe(
          "Preferred callback date when lead requests pricing or consultation.",
        ),
      preferredCallTime: z
        .string()
        .default("")
        .describe(
          "Preferred callback time (e.g., '11:00 AM', 'after 5 PM', 'morning').",
        ),
      city: z
        .string()
        .default("")
        .describe(
          "City or neighborhood (e.g., 'Hyderabad', 'Chinthal', 'Kukatpally', 'Gachibowli', 'Secunderabad').",
        ),
      intent: z
        .string()
        .default("")
        .describe(
          "Primary intent: 'Passenger Lift', 'MRL Lift', 'Hydraulic Lift', 'Hospital Bed Lift', 'Elevator Maintenance & AMC', 'Elevator Modernization', 'Price Enquiry', 'General Enquiry'.",
        ),
      urgency: z
        .string()
        .default("Medium")
        .describe("High, Medium, or Low urgency based on context."),
      interestScore: z
        .number()
        .default(5)
        .describe("1 to 10 interest score based on engagement."),
    })
    .default({
      liftType: "",
      clientType: "General",
      propertyType: "",
      numberOfFloors: "",
      capacity: "",
      constructionStage: "",
      doorType: "",
      machineRoomAvailable: "",
      propertySize: "",
      issueDescription: "",
      preferredVisitDate: "",
      preferredCallDate: "",
      preferredCallTime: "",
      city: "",
      intent: "",
      urgency: "Medium",
      interestScore: 5,
    }),
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

export const generateAIResponse = async (leadId, incomingText, tenantModels = null) => {
  try {
    const LeadModel = tenantModels?.Lead || Lead;
    const UserModel = tenantModels?.User || User;
    const AssignmentStateModel = tenantModels?.AssignmentState || AssignmentState;
    const NotificationModel = tenantModels?.Notification || Notification;
    const MessageModel = tenantModels?.Message || Message;
    const AILogModel = tenantModels?.AILog || AILog;
    const FollowupModel = tenantModels?.Followup || Followup;

    const geminiApiKey = process.env.GEMINI_API_KEY;

    if (!geminiApiKey) {
      console.error(
        "GEMINI_API_KEY is not defined in the environment variables.",
      );
    }

    const lead = await LeadModel.findById(leadId);
    if (!lead) {
      throw new Error(`Lead not found with ID: ${leadId}`);
    }

    // Auto-assign representative if currently Unassigned or not set
    let assignedRep = lead.assignedTo;
    if (!assignedRep || assignedRep === "Unassigned") {
      const representatives = await UserModel.find({ role: "sales person" }).sort({
        _id: 1,
      });
      if (representatives && representatives.length > 0) {
        let state = await AssignmentStateModel.findOne({ key: "leadAssignment" });
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

        // Create Lead Notification
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
      apiKey: process.env.GEMINI_API_KEY,
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

    // RAG Context Retrieval from Qdrant
    const vs = await initVectorStore();
    let ragContext = "";
    if (vs) {
      const userIntent = lead.aiQualification?.intent || lead.service || "";
      const finalSearchQuery = userIntent
        ? `${userIntent} ${optimizedSearchQuery}`
        : optimizedSearchQuery;

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
          console.log("rerankRes.data", rerankRes.data);
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
    }

    const systemPrompt = `You are a friendly, human sales representative working at Kranthi Elevators. 

COMPANY OVERVIEW & PRODUCTS (KRANTHI ELEVATORS):
Kranthi Elevators designs, manufactures, installs, and maintains advanced, precision-engineered elevator solutions in and around Hyderabad across residential, commercial, industrial, and healthcare segments.
4 CORE PRODUCT LINES:
1. PASSENGER LIFT: Safe, smooth, and quiet vertical transportation for apartments, offices, shopping complexes, and hotels. Capacity: 4–20 Persons. Speed: 0.5 to 2.0 m/s. Doors: Automatic / Manual. Safety: Emergency alarm, Overload protection, Door sensors, Power backup.
2. MRL LIFTS (Machine Room Less): Modern, space-saving design with all major mechanical components integrated within the lift shaft (no rooftop machine room required). Capacity: 4–16 Persons. Speed: 0.5 to 1.75 m/s. Doors: Automatic. Ideal for modern apartments and space-constrained commercial buildings. Low maintenance, high energy efficiency. Safety: Emergency alarm, Overload protection, Door sensors, Automatic rescue device (ARD).
3. HYDRAULIC LIFTS: Smooth, powerful lifting with strong load capacity and smooth start/stop. Capacity: 2–10 Tons / 2–15 Persons. Speed: Up to 1.0 m/s. Doors: Manual / Automatic. Cost-effective and easy to install for low-rise buildings: Villas, Warehouses, Industrial units, and small commercial spaces. Safety: Emergency lowering system, Overload protection, Door safety, Power backup.
4. HOSPITAL BED LIFTS: Specially designed for hospitals, nursing homes, healthcare centers, and medical institutes to transport patients, stretchers, and medical equipment smoothly and without vibration. Capacity: 10–26 Persons / 800–2000 kg. Speed: 0.5 to 1.5 m/s. Doors: Automatic (Center Opening). Built with hygienic stainless steel interiors. Safety: Emergency alarm & intercom, ARD, Overload protection, Door safety sensors, Power backup.

LIFECYCLE & MAINTENANCE SERVICES:
Kranthi Elevators supports the entire elevator lifecycle: Planning, Custom Engineering, Installation, Preventative Maintenance, AMC Contracts, and 24/7 Breakdown Support handled by our experienced technical team.

KNOWLEDGE BASE CONTEXT:
${ragContext || "(General Knowledge Base Active)"}

LEAD CONTEXT:
Name: ${lead.name} | Phone: ${lead.phone} | Rep: ${assignedRep}
Total Conversation Turns: ${totalMessagesCount}
Already Collected:
- Lift / Product Type: ${lead.aiQualification?.liftType || "Missing"}
- Client Role: ${lead.aiQualification?.clientType || "Missing"}
- Building Type: ${lead.aiQualification?.propertyType || "Missing"}
- Number of Floors: ${lead.aiQualification?.numberOfFloors || "Missing"}
- Capacity / Load: ${lead.aiQualification?.capacity || "Missing"}
- Construction Stage: ${lead.aiQualification?.constructionStage || "Missing"}
- Door Type: ${lead.aiQualification?.doorType || "Missing"}
- Machine Room Provision: ${lead.aiQualification?.machineRoomAvailable || "Missing"}
- City / Neighborhood: ${lead.aiQualification?.city || "Missing"}
- Preferred Call Date/Time: ${lead.aiQualification?.preferredCallDate || ""} ${lead.aiQualification?.preferredCallTime || ""}
- Preferred Visit Date: ${lead.aiQualification?.preferredVisitDate || "Missing"}

HISTORY:
${chatHistoryLog || "(None)"}

LAST AGENT MSG: "${lastAgentMessageText}"
USER MSG: "${incomingText}"

CRITICAL RULES:
1. HUMAN TONE: Communicate EXACTLY like a real human. Be warm, polite, and conversational. NEVER mention that you are an AI or bot.
2. PACING: Ask at most 1-2 friendly questions per message (e.g. building type, number of floors, and location) to gather data naturally without overwhelming the user.
3. FIRST MESSAGE REQUIREMENT: If this is the first interaction (Total Conversation Turns is 1 or 0) and the user has not mentioned a specific product, you MUST introduce Kranthi Elevators and list our 4 core product lines as a numbered list:
1. Passenger Lift (Apartments, Offices, Hotels)
2. MRL Lifts (Machine Room Less - Space Saving)
3. Hydraulic Lifts (Villas, Warehouses & Low-Rise)
4. Hospital Bed Lifts (Hospitals & Healthcare Facilities)

IMPORTANT: Ask the user to reply with the number of the product they need, or describe their building!

4. STRICT PRICING RULE (MANDATORY):
The chatbot must NOT provide, guess, estimate, negotiate, or invent pricing, since no pricing figures are published on the website and all lifts are customized to building specs.
When a customer asks about pricing, quotation, cost, charges, rates, or budget:
• State: "Pricing depends on the lift model, capacity, number of stops/floors, and site requirements. We will arrange for our team to contact you with the pricing details and proposal."
• Ask: "Please share your preferred date and time for our team to call you."
• Extract their callback date/time into 'preferredCallDate' and 'preferredCallTime'.

5. ELEVATOR LIFECYCLE & MAINTENANCE (FAQ Q5 & Q9):
If a user asks about maintenance, servicing, or AMC:
• Clarify that Kranthi Elevators supports the entire elevator lifecycle — planning, installation, preventative maintenance, and ongoing AMC support with our experienced technical team.
• Note their requirement and schedule a callback for commercial AMC terms.

6. ELEVATOR MODERNIZATION / REPLACEMENT:
If a user asks to modernize or replace an old lift:
• Confirm we can assist in upgrading or replacing old elevators with our modern energy-efficient MRL or Passenger lifts, and arrange an engineering site visit.

7. PASSIVE EXTRACTION: Always extract 'Lift Type', 'Client Type', 'Property Type', 'Number of Floors', 'Capacity', 'Construction Stage', 'Door Type', 'Machine Room Available', 'City', 'Preferred Call/Visit Date & Time', and 'Intent' into the JSON schema whenever mentioned.
8. CONTEXT AWARENESS: Always use LEAD CONTEXT and HISTORY. Never re-ask for details already collected above.
9. MEDIA ATTACHMENTS: If user sends an image/video/drawing, respond: "Thank you for sharing the media! I can only read text messages right now. Could you please describe your building requirements or lift query in text?"
10. HUMAN HANDOFF: If the user asks for human support, says 'yes' to human assistance, or is off-topic, politely transfer them and set disableAI=true.
11. WHATSAPP FORMATTING: Keep messages short (maximum 50-60 words), clean bullet points, bold key terms (*term*), and emojis.
12. OUTPUT: Respond purely via the structured JSON schema.`;

    let parsed = null;
    let lastError = null;

    console.log("Generating AI response with Gemini...");

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
      console.warn("Model Gemini failed. Error message:", e.message);
    }

    if (!parsed) {
      console.error(
        "All AI models failed. Using hard fallback.",
        lastError?.message,
      );
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

    await AILogModel.create({
      leadId,
      prompt: systemPrompt + "\n\nUser Message: " + incomingText,
      response: JSON.stringify(parsed, null, 2),
      model: "openrouter/auto (OpenRouter + Qdrant)",
      tokensUsed: 0,
    });

    const updatePayload = {};

    if (parsed.qualification) {
      const aiData = parsed.qualification || {};
      const prevQual = lead.aiQualification || {};

      updatePayload.lastMessage = incomingText;
      updatePayload.lastActivity = new Date();
      updatePayload.aiQualification = {
        liftType: aiData.liftType || prevQual.liftType || "",
        clientType: aiData.clientType || prevQual.clientType || "General",
        propertyType: aiData.propertyType || prevQual.propertyType || "",
        numberOfFloors: aiData.numberOfFloors || prevQual.numberOfFloors || "",
        capacity: aiData.capacity || prevQual.capacity || "",
        constructionStage:
          aiData.constructionStage || prevQual.constructionStage || "",
        doorType: aiData.doorType || prevQual.doorType || "",
        machineRoomAvailable:
          aiData.machineRoomAvailable || prevQual.machineRoomAvailable || "",
        propertySize: aiData.propertySize || prevQual.propertySize || "",
        issueDescription:
          aiData.issueDescription || prevQual.issueDescription || "",
        preferredVisitDate:
          aiData.preferredVisitDate || prevQual.preferredVisitDate || "",
        preferredCallDate:
          aiData.preferredCallDate || prevQual.preferredCallDate || "",
        preferredCallTime:
          aiData.preferredCallTime || prevQual.preferredCallTime || "",
        city: aiData.city || prevQual.city || "",
        intent: aiData.intent || prevQual.intent || "",
        urgency: aiData.urgency || prevQual.urgency || "Medium",
        interestScore: aiData.interestScore ?? prevQual.interestScore ?? 0,
      };

      const validServices = [
        "General Enquiry",
        "Passenger Lift",
        "MRL Lift",
        "Hydraulic Lift",
        "Hospital Bed Lift",
        "Elevator Maintenance & AMC",
        "Elevator Modernization",
      ];
      const rawIntent = aiData.intent || aiData.liftType || "";

      let matchedService = validServices.find(
        (s) => s.toLowerCase() === rawIntent.toLowerCase(),
      );

      // Only attempt fallback keyword matching if the lead does not already have a specific service identified
      const currentService = lead.service || "";
      const isAlreadyIdentified =
        currentService && currentService !== "General Enquiry";

      if (!matchedService && !isAlreadyIdentified) {
        const combinedText = `${rawIntent} ${incomingText}`.toLowerCase();

        // Priority 0: Check if user replied with just a number (1-6)
        const matchNumber =
          incomingText.trim().match(/^(?:option\s*|#)?([1-6])\.?$/i) ||
          incomingText.match(/\b([1-6])\b/);
        if (matchNumber) {
          const num = matchNumber[1];
          const CORE_SERVICES_MAP = {
            1: "Passenger Lift",
            2: "MRL Lift",
            3: "Hydraulic Lift",
            4: "Hospital Bed Lift",
            5: "Elevator Maintenance & AMC",
            6: "Elevator Modernization",
          };
          matchedService = CORE_SERVICES_MAP[num];
        }

        // Priority 1: Keyword matching for elevator product lines
        if (!matchedService) {
          if (
            combinedText.includes("mrl") ||
            combinedText.includes("machine room less") ||
            combinedText.includes("no machine room")
          ) {
            matchedService = "MRL Lift";
          } else if (
            combinedText.includes("hydraulic") ||
            combinedText.includes("villa lift") ||
            combinedText.includes("home lift") ||
            combinedText.includes("warehouse lift") ||
            combinedText.includes("cargo") ||
            combinedText.includes("industrial lift")
          ) {
            matchedService = "Hydraulic Lift";
          } else if (
            combinedText.includes("hospital") ||
            combinedText.includes("bed lift") ||
            combinedText.includes("stretcher") ||
            combinedText.includes("clinic") ||
            combinedText.includes("medical")
          ) {
            matchedService = "Hospital Bed Lift";
          } else if (
            combinedText.includes("moderniz") ||
            combinedText.includes("modernis") ||
            combinedText.includes("upgrade lift") ||
            combinedText.includes("upgrade elevator") ||
            combinedText.includes("replace lift") ||
            combinedText.includes("replacement")
          ) {
            matchedService = "Elevator Modernization";
          } else if (
            combinedText.includes("maintenance") ||
            combinedText.includes("amc") ||
            combinedText.includes("service") ||
            combinedText.includes("repair") ||
            combinedText.includes("breakdown")
          ) {
            matchedService = "Elevator Maintenance & AMC";
          } else if (
            combinedText.includes("passenger") ||
            combinedText.includes("apartment lift") ||
            combinedText.includes("office lift") ||
            combinedText.includes("residential lift") ||
            combinedText.includes("elevator") ||
            combinedText.includes("lift")
          ) {
            matchedService = "Passenger Lift";
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
