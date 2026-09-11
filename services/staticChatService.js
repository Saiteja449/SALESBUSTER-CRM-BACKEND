import { QdrantClient } from "@qdrant/js-client-rest";
import { QdrantVectorStore } from "@langchain/qdrant";
import { GoogleGenerativeAIEmbeddings, ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { VoyageAIClient } from "voyageai";
import mongoose from "mongoose";
import { getTenantModels } from "./tenantManager.js";
import { getIO } from "../socket/socket.js";

const COLLECTION_NAME = "salesbuster_kb";
export const TARGET_TENANT_DB = process.env.SALESBUSTER_TENANT_DB || "sb_tenant_salesbuster_9f3f71";
const CALENDLY_URL = process.env.CALENDLY_URL || "https://calendly.com/team-salesbuster/30min";

// In-memory conversation session store with TTL cleanup
const sessions = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Cleanup stale sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastActive > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}, 60 * 60 * 1000);

let cachedVectorStore = null;

/**
 * Connects and caches Qdrant vector store
 */
const getVectorStore = async () => {
  if (cachedVectorStore) return cachedVectorStore;

  const qdrantUrl = process.env.CLUSTER_ENDPOINT;
  const qdrantApiKey = process.env.QDRANT_API_KEY;
  const geminiApiKey = process.env.GEMINI_API_KEY;

  if (!qdrantUrl || !qdrantApiKey || !geminiApiKey) {
    throw new Error("Missing QDRANT or GEMINI credentials in environment");
  }

  const client = new QdrantClient({
    url: qdrantUrl,
    apiKey: qdrantApiKey,
  });

  const embeddings = new GoogleGenerativeAIEmbeddings({
    apiKey: geminiApiKey,
    model: "gemini-embedding-2",
  });

  cachedVectorStore = await QdrantVectorStore.fromExistingCollection(embeddings, {
    client,
    collectionName: COLLECTION_NAME,
  });

  return cachedVectorStore;
};

/**
 * Normalizes phone number to 10 digits
 */
const normalizePhone = (phoneStr) => {
  if (!phoneStr) return "";
  const cleanDigits = String(phoneStr).replace(/\D/g, "");
  if (cleanDigits.length > 10 && cleanDigits.startsWith("91")) {
    return cleanDigits.substring(2);
  }
  return cleanDigits.length >= 10 ? cleanDigits.slice(-10) : cleanDigits;
};

/**
 * Maps requirement to appropriate service category
 */
const mapService = (requirement) => {
  if (!requirement || typeof requirement !== "string") return "General Enquiry";
  const req = requirement.toLowerCase();
  if (req.includes("call") || req.includes("recording") || req.includes("dialer") || req.includes("audio")) {
    return "Call Recording & AI";
  }
  if (req.includes("whatsapp") || req.includes("broadcast") || req.includes("template") || req.includes("bot")) {
    return "WhatsApp Automation";
  }
  if (req.includes("lead") || req.includes("capture") || req.includes("pipeline") || req.includes("meta ads")) {
    return "Lead Management";
  }
  if (req.includes("demo") || req.includes("meeting") || req.includes("consultation")) {
    return "Product Demo";
  }
  return "General Enquiry";
};

/**
 * Saves or updates a Lead, Conversation, and Messages directly into sb_tenant_salesbuster_9f3f71
 */
export const syncWebsiteLeadToCRM = async ({
  sessionId,
  leadData,
  appointmentDetails = null,
}) => {
  try {
    const tenantModels = getTenantModels(TARGET_TENANT_DB);
    const { Lead, User, AssignmentState, Conversation, Message, Notification } = tenantModels;

    const session = sessions.get(sessionId) || { messages: [] };
    const currentLeadData = {
      ...(session.leadData || {}),
      ...(leadData || {}),
    };
    session.leadData = currentLeadData;

    const rawName = (currentLeadData.name || "").trim();
    const rawCompany = (currentLeadData.company || "").trim();
    const rawPhone = (currentLeadData.phone || currentLeadData.mobile || "").trim();
    const rawEmail = (currentLeadData.email || "").trim();
    const rawRequirement = (currentLeadData.requirement || "").trim();

    // Only proceed to create/update lead if at least phone, email, or a real name is provided
    if (!rawPhone && !rawEmail && !rawName) {
      return null;
    }

    const cleanPhone = normalizePhone(rawPhone);

    // Build matching query for existing lead
    const orConditions = [];
    if (session.leadId && mongoose.Types.ObjectId.isValid(session.leadId)) {
      orConditions.push({ _id: session.leadId });
    }
    if (cleanPhone) {
      orConditions.push({ phone: cleanPhone });
      orConditions.push({ phone: rawPhone });
      if (cleanPhone.length >= 7) {
        orConditions.push({ phone: new RegExp(cleanPhone + "$") });
      }
    }
    if (rawEmail) {
      orConditions.push({ email: new RegExp("^" + rawEmail + "$", "i") });
    }

    let existingLead = null;
    if (orConditions.length > 0) {
      existingLead = await Lead.findOne({ $or: orConditions });
    }

    let lead = null;
    let isNewLead = false;

    if (existingLead) {
      lead = existingLead;
      let updated = false;
      if (rawName && (!lead.name || lead.name === "Website Visitor")) {
        lead.name = rawName;
        updated = true;
      }
      if (rawCompany && !lead.company) {
        lead.company = rawCompany;
        updated = true;
      }
      if (rawEmail && !lead.email) {
        lead.email = rawEmail;
        updated = true;
      }
      if (cleanPhone && (!lead.phone || lead.phone === "N/A")) {
        lead.phone = cleanPhone;
        updated = true;
      }
      if (rawRequirement && !lead.notes?.includes(rawRequirement)) {
        lead.notes = lead.notes ? `${lead.notes} | Req: ${rawRequirement}` : `Requirement: ${rawRequirement}`;
        updated = true;
      }
      if (appointmentDetails) {
        lead.status = "Converted";
        if (appointmentDetails.appointmentDate) lead.appointmentDate = appointmentDetails.appointmentDate;
        if (appointmentDetails.appointmentTime) lead.appointmentTime = appointmentDetails.appointmentTime;
        if (!lead.tags?.includes("Demo Booked")) {
          lead.tags = [...(lead.tags || []), "Demo Booked"];
        }
        updated = true;
      }
      if (updated) {
        await lead.save();
      }
    } else {
      isNewLead = true;

      // Assign round-robin to active sales rep
      let assignedTo = "Unassigned";
      try {
        const reps = await User.find({ role: "sales person" }).sort({ _id: 1 });
        if (reps && reps.length > 0) {
          let state = await AssignmentState.findOne({ key: "leadAssignment" });
          if (!state) {
            state = await AssignmentState.create({
              key: "leadAssignment",
              lastAssignedIndex: -1,
            });
          }
          let nextIndex = state.lastAssignedIndex + 1;
          if (nextIndex >= reps.length) nextIndex = 0;
          assignedTo = reps[nextIndex]._id.toString();
          state.lastAssignedIndex = nextIndex;
          await state.save();
        }
      } catch (assignErr) {
        console.warn("[StaticChat] Auto-assignment warning:", assignErr.message);
      }

      const notesParts = [];
      if (rawRequirement) notesParts.push(`Requirement: ${rawRequirement}`);
      if (rawCompany) notesParts.push(`Company: ${rawCompany}`);

      const newLeadPayload = {
        name: rawName || (rawCompany ? `${rawCompany} Contact` : "Website Visitor"),
        company: rawCompany || "",
        phone: cleanPhone || rawPhone || "N/A",
        email: rawEmail || "",
        service: mapService(rawRequirement),
        source: "Website Chat",
        status: appointmentDetails ? "Converted" : "New",
        assignedTo,
        joinedAt: new Date(),
        notes: notesParts.length > 0 ? notesParts.join(" | ") : "Inquiry from Website Floating Chat",
        aiQualification: {
          company: rawCompany,
          requirement: rawRequirement,
          capturedAt: new Date().toISOString(),
          chatSessionId: sessionId,
        },
        tags: ["Website Chat", ...(appointmentDetails ? ["Demo Booked"] : [])],
        appointmentDate: appointmentDetails?.appointmentDate || "",
        appointmentTime: appointmentDetails?.appointmentTime || "",
      };

      lead = await Lead.create(newLeadPayload);
    }

    session.leadId = lead._id.toString();

    // 2. Upsert Conversation
    const lastSessionMsg = session.messages[session.messages.length - 1];
    const lastMsgText = lastSessionMsg ? lastSessionMsg.text : "Website inquiry initiated.";

    await Conversation.findOneAndUpdate(
      { leadId: lead._id },
      {
        leadId: lead._id,
        lastMessage: lastMsgText,
        lastMessageTime: new Date(),
        $inc: { unreadCount: 1 },
      },
      { upsert: true, new: true }
    );

    // 3. Sync Messages
    for (const msg of session.messages) {
      if (msg.savedToCRM) continue;

      const msgId = msg.messageId || `wchat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      try {
        await Message.findOneAndUpdate(
          { messageId: msgId },
          {
            messageId: msgId,
            leadId: lead._id,
            sender: msg.role === "user" ? (lead.name || "Website Visitor") : "SalesBuster AI",
            senderName: msg.role === "user" ? (lead.name || "Website Visitor") : "SalesBuster AI",
            direction: msg.role === "user" ? "incoming" : "outgoing",
            messageType: "text",
            text: msg.text,
            aiGenerated: msg.role !== "user",
            timestamp: msg.timestamp || new Date(),
            status: "delivered",
          },
          { upsert: true }
        );
        msg.savedToCRM = true;
      } catch (mErr) {
        console.warn("[StaticChat] Message sync warning:", mErr.message);
      }
    }

    // 4. Create Notification for new lead or booked demo
    if (isNewLead || appointmentDetails) {
      try {
        const notifTitle = appointmentDetails
          ? "🎉 Demo Meeting Booked (Website Chat)"
          : "🚀 New Website Chat Lead";
        const notifMessage = appointmentDetails
          ? `${lead.name}${lead.company ? ' from ' + lead.company : ''} scheduled a demo via Calendly.`
          : `New enquiry received from ${lead.name}${lead.company ? ' (' + lead.company + ')' : ''} via Website Chat.`;

        await Notification.create({
          title: notifTitle,
          message: notifMessage,
          type: "new_lead",
          targetRoles: ["sales manager"],
          targetUsers: lead.assignedTo && lead.assignedTo !== "Unassigned" ? [lead.assignedTo] : [],
        });
      } catch (nErr) {
        console.warn("[StaticChat] Notification create error:", nErr.message);
      }

      // 5. Real-time Socket.IO emission
      try {
        const io = getIO();
        if (io) {
          io.emit("new_lead", {
            lead,
            source: "Website Chat",
            tenantDb: TARGET_TENANT_DB,
          });
          io.emit("notification", {
            title: isNewLead ? "New Website Chat Lead" : "Demo Booked",
            message: `${lead.name}${lead.company ? ' (' + lead.company + ')' : ''}`,
            type: "new_lead",
            leadId: lead._id,
          });
        }
      } catch (sErr) {
        console.warn("[StaticChat] Socket.IO emission error:", sErr.message);
      }
    }

    return lead;
  } catch (error) {
    console.error("[StaticChat] CRM sync error:", error);
    return null;
  }
};

/**
 * Handle incoming chat message for SalesBuster static website
 */
export const handleStaticChatMessage = async ({ sessionId, message, clientLeadDetails = null }) => {
  if (!message || typeof message !== "string" || !message.trim()) {
    throw new Error("Message text is required");
  }

  const trimmedMessage = message.trim();
  const effectiveSessionId =
    sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  // Retrieve or initialize session
  let session = sessions.get(effectiveSessionId);
  if (!session) {
    session = {
      messages: [],
      leadData: { name: "", company: "", phone: "", email: "", requirement: "" },
      leadId: null,
      lastActive: Date.now(),
    };
    sessions.set(effectiveSessionId, session);
  }
  session.lastActive = Date.now();

  // Merge client provided lead details if available
  if (clientLeadDetails && typeof clientLeadDetails === "object") {
    session.leadData = {
      ...session.leadData,
      ...clientLeadDetails,
    };
  }

  // 1. Retrieve RAG context from Qdrant
  let retrievedContext = "";
  try {
    const vectorStore = await getVectorStore();
    const searchResults = await vectorStore.similaritySearch(trimmedMessage, 8);
    const documents = searchResults.map((r) => r.pageContent).filter(Boolean);

    if (documents.length > 0 && process.env.VOYAGE_API_KEY) {
      try {
        const voyageClient = new VoyageAIClient({
          apiKey: process.env.VOYAGE_API_KEY,
        });
        const rerankRes = await voyageClient.rerank({
          query: trimmedMessage,
          documents: documents,
          model: "rerank-2.5",
          topK: 4,
        });
        if (rerankRes?.data) {
          retrievedContext = rerankRes.data
            .map((item) => item.document || documents[item.index])
            .join("\n\n---\n\n");
        } else {
          retrievedContext = documents.slice(0, 4).join("\n\n---\n\n");
        }
      } catch (rerankErr) {
        console.warn("[StaticChat] Voyage reranking warning:", rerankErr.message);
        retrievedContext = documents.slice(0, 4).join("\n\n---\n\n");
      }
    } else if (documents.length > 0) {
      retrievedContext = documents.slice(0, 4).join("\n\n---\n\n");
    }
  } catch (ragErr) {
    console.error("[StaticChat] Qdrant similarity search error:", ragErr.message);
  }

  // 2. Format past conversation history (last 8 turns)
  const recentTurns = session.messages.slice(-8);
  const formattedHistory = recentTurns
    .map((m) => `${m.role === "user" ? "Visitor" : "SalesBuster Assistant"}: ${m.text}`)
    .join("\n");

  const currentKnownDetails = session.leadData || {};
  const knownDetailsBlock = `
CURRENT KNOWN VISITOR DETAILS:
- Name: ${currentKnownDetails.name || "Not yet provided"}
- Company: ${currentKnownDetails.company || "Not yet provided"}
- Mobile/Phone: ${currentKnownDetails.phone || "Not yet provided"}
- Email: ${currentKnownDetails.email || "Not yet provided"}
- Requirement: ${currentKnownDetails.requirement || "Not yet provided"}
`;

  // 3. Formulate consultative system prompt
  const systemPrompt = `You are the official AI Sales & Solutions Consultant for SalesBuster (https://salesbuster.ai/).
Your goal is to warmly engage website visitors, consultatively understand their business requirements, answer questions about SalesBuster CRM platform, features, Android call recording, WhatsApp Business automations, and pricing strictly using the knowledge base context below, capture basic lead details, and invite them to book a live 1-on-1 demo via Calendly.

═══════════════════════════════════════════════════════════════
OPERATIONAL GUIDELINES:
1. CONSULTATIVE REQUIREMENT DISCOVERY:
   - Actively understand the visitor's initial business requirements (industry, sales team size, lead sources, and key bottlenecks like missed follow-ups or lack of call visibility).
   - If the user has not mentioned what they are looking for, ask open-ended questions like: "Are you looking to streamline WhatsApp leads, enable call recording for your sales team, or automate follow-ups?"
2. ACCURATE GROUNDING:
   - Answer exclusively from the facts in the Context section below. Do NOT hallucinate features or custom pricing.
   - Pricing Facts:
     * Base Pack (5 licences): ₹5,995/mo billed quarterly (₹17,985 every 3 mos), or ₹4,495/mo billed yearly (₹53,940/yr - 25% discount).
     * Additional user licences: ₹1,199/user/mo (Quarterly) or ₹899/user/mo (Yearly).
     * Minimum 5 licences commitment. Zero platform markup on official Meta WhatsApp messages and AI compute.
3. LEAD CAPTURE (Natural & Courteous):
   - As you provide answers, guide the conversation to capture the 5 basic details:
     1. Name
     2. Company Name
     3. Mobile Number (10 digits)
     4. Email Address
     5. Core Requirement
   - Ask for missing details gently (at most 1-2 questions per turn). Never bombard the user.
4. LIVE DEMO / MEETING BOOKING (Calendly):
   - Whenever the visitor expresses interest in seeing the platform in action, requests custom enterprise rollout, or when they share their requirements, invite them to schedule a 1-on-1 demo:
     "I'd love to set up a personalized 30-minute live demo for your team! You can click '📅 Book a 1-on-1 Demo' anytime to pick a convenient slot."
5. OUTPUT FORMAT:
   You MUST ALWAYS respond with a VALID JSON object in the exact schema below. Do not output anything outside the JSON object.
{
  "reply": "Your conversational response in clear, friendly markdown with bullet points and bolding.",
  "extractedLead": {
    "name": "Full name if detected in this message or previous turns, otherwise empty string",
    "company": "Company or business name if detected, otherwise empty string",
    "phone": "10-digit mobile number if detected, otherwise empty string",
    "email": "Email address if detected, otherwise empty string",
    "requirement": "Visitor's business requirements or use case if detected, otherwise empty string"
  },
  "suggestCalendly": true or false (true if user asked for a demo, meeting, callback, or expressed high interest)
}
═══════════════════════════════════════════════════════════════

${knownDetailsBlock}

KNOWLEDGE BASE CONTEXT:
${retrievedContext || "No specific document chunks retrieved. Rely only on verified core knowledge."}

${formattedHistory ? `CONVERSATION HISTORY:\n${formattedHistory}\n` : ""}
Visitor Message: ${trimmedMessage}`;

  // 4. Generate answer with Gemini
  let replyText = "";
  let extractedLead = {};
  let suggestCalendly = false;

  const geminiApiKey = process.env.GEMINI_API_KEY;
  const invokeGemini = async (modelName) => {
    const model = new ChatGoogleGenerativeAI({
      model: modelName,
      temperature: 0.2,
      maxOutputTokens: 1200,
      apiKey: geminiApiKey,
    });
    const res = await model.invoke([["user", systemPrompt]]);
    return (res?.content || "").trim();
  };

  let rawOutput = "";
  try {
    rawOutput = await invokeGemini("gemini-3.1-flash-lite");
  } catch (err) {
    console.warn("[StaticChat] gemini-3.1-flash-lite failed, falling back to gemini-2.5-flash:", err.message);
    try {
      rawOutput = await invokeGemini("gemini-2.5-flash");
    } catch (fallbackErr) {
      console.error("[StaticChat] Gemini fallback failed:", fallbackErr.message);
      rawOutput = JSON.stringify({
        reply: "Hello! I am here to help you explore SalesBuster CRM, features, pricing, and live demo booking. What is your team looking to achieve?",
        extractedLead: {},
        suggestCalendly: false,
      });
    }
  }

  // Parse structured response
  try {
    let cleanJson = rawOutput;
    if (cleanJson.includes("```json")) {
      cleanJson = cleanJson.split("```json")[1].split("```")[0].trim();
    } else if (cleanJson.includes("```")) {
      cleanJson = cleanJson.split("```")[1].split("```")[0].trim();
    }

    const parsed = JSON.parse(cleanJson);
    replyText = parsed.reply || "";
    extractedLead = parsed.extractedLead || {};
    suggestCalendly = !!parsed.suggestCalendly;
  } catch (jsonErr) {
    console.warn("[StaticChat] JSON parsing warning, extracting text directly:", jsonErr.message);
    replyText = rawOutput.replace(/\{[\s\S]*\}/, "").trim() || rawOutput;

    // Fallback regex extraction
    const phoneMatch = trimmedMessage.match(/(\+?91[-.\s]?)?[6-9]\d{9}/);
    const emailMatch = trimmedMessage.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (phoneMatch) extractedLead.phone = phoneMatch[0];
    if (emailMatch) extractedLead.email = emailMatch[0];
  }

  // Merge extracted details into session
  if (extractedLead) {
    for (const [k, v] of Object.entries(extractedLead)) {
      if (v && typeof v === "string" && v.trim() && !session.leadData[k]) {
        session.leadData[k] = v.trim();
      }
    }
  }

  // Record user & bot messages in session
  const userMsgObj = {
    role: "user",
    text: trimmedMessage,
    timestamp: new Date(),
    messageId: `msg_${Date.now()}_u`,
    savedToCRM: false,
  };
  const botMsgObj = {
    role: "assistant",
    text: replyText,
    timestamp: new Date(),
    messageId: `msg_${Date.now()}_b`,
    savedToCRM: false,
  };

  session.messages.push(userMsgObj);
  session.messages.push(botMsgObj);

  // 5. If basic contact info is present, sync to CRM
  let savedLead = null;
  if (session.leadData.phone || session.leadData.email || session.leadData.name) {
    try {
      savedLead = await syncWebsiteLeadToCRM({
        sessionId: effectiveSessionId,
        leadData: session.leadData,
      });
    } catch (crmErr) {
      console.error("[StaticChat] CRM sync error:", crmErr);
    }
  }

  return {
    reply: replyText,
    sessionId: effectiveSessionId,
    extractedLead: session.leadData,
    suggestCalendly,
    leadId: savedLead ? savedLead._id.toString() : session.leadId || null,
    hasCapturedContact: !!(session.leadData.phone || session.leadData.email),
  };
};

/**
 * Direct capture endpoint called from in-chat lead card
 */
export const captureWebsiteLeadDirectly = async ({
  sessionId,
  name,
  company,
  mobile,
  email,
  requirement,
}) => {
  if (!name && !mobile && !email) {
    throw new Error("At least Name, Mobile, or Email is required.");
  }

  const effectiveSessionId =
    sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  let session = sessions.get(effectiveSessionId);
  if (!session) {
    session = {
      messages: [],
      leadData: {},
      leadId: null,
      lastActive: Date.now(),
    };
    sessions.set(effectiveSessionId, session);
  }

  const leadPayload = {
    name: (name || "").trim(),
    company: (company || "").trim(),
    phone: (mobile || "").trim(),
    email: (email || "").trim(),
    requirement: (requirement || "").trim(),
  };

  session.leadData = {
    ...(session.leadData || {}),
    ...leadPayload,
  };

  // Add system message in session
  session.messages.push({
    role: "user",
    text: `[Lead Details] Name: ${leadPayload.name}, Company: ${leadPayload.company}, Mobile: ${leadPayload.phone}, Email: ${leadPayload.email}, Requirement: ${leadPayload.requirement}`,
    timestamp: new Date(),
    savedToCRM: false,
  });

  const lead = await syncWebsiteLeadToCRM({
    sessionId: effectiveSessionId,
    leadData: session.leadData,
  });

  return {
    success: true,
    leadId: lead ? lead._id.toString() : null,
    lead,
  };
};

/**
 * Endpoint called when visitor completes a Calendly demo booking
 */
export const recordCalendlyBooking = async ({
  sessionId,
  leadId,
  appointmentDate,
  appointmentTime,
  notes,
}) => {
  const effectiveSessionId = sessionId;
  let session = effectiveSessionId ? sessions.get(effectiveSessionId) : null;

  const appointmentDetails = {
    appointmentDate: appointmentDate || new Date().toISOString().split("T")[0],
    appointmentTime: appointmentTime || "11:00 AM",
    notes: notes || "Calendly 1-on-1 Demo scheduled via website chat widget",
  };

  const lead = await syncWebsiteLeadToCRM({
    sessionId: effectiveSessionId || `session_cal_${Date.now()}`,
    leadData: session?.leadData || {},
    appointmentDetails,
  });

  if (session) {
    session.messages.push({
      role: "assistant",
      text: `🎉 **Demo Meeting Confirmed!** Your 1-on-1 demo has been scheduled for **${appointmentDetails.appointmentDate} at ${appointmentDetails.appointmentTime}**. We have sent calendar invites and our team looks forward to meeting you!`,
      timestamp: new Date(),
      savedToCRM: false,
    });
  }

  return {
    success: true,
    leadId: lead ? lead._id.toString() : leadId,
    appointmentDetails,
  };
};

/**
 * Returns runtime config for the website chat widget
 */
export const getStaticChatConfig = () => {
  return {
    companyName: "SalesBuster AI",
    calendlyUrl: CALENDLY_URL,
    defaultChips: [
      { label: "⚡ Core Features", query: "What are the core features of SalesBuster CRM?" },
      { label: "💰 Pricing & Plans", query: "How much does SalesBuster cost and what plans are available?" },
      { label: "📅 Book a 1-on-1 Demo", query: "I want to schedule a live product demo." },
      { label: "📝 Share Requirement", query: "I'd like to share my team's CRM and sales automation requirements." },
    ],
  };
};

/**
 * Returns chat history for a session
 */
export const getStaticChatHistory = (sessionId) => {
  if (!sessionId) return [];
  const session = sessions.get(sessionId);
  return session ? session.messages : [];
};

/**
 * Resets/clears a session
 */
export const resetStaticChatSession = (sessionId) => {
  if (!sessionId) return true;
  sessions.delete(sessionId);
  return true;
};

