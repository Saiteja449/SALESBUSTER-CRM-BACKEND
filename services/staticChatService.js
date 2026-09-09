import { QdrantClient } from "@qdrant/js-client-rest";
import { QdrantVectorStore } from "@langchain/qdrant";
import { GoogleGenerativeAIEmbeddings, ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { VoyageAIClient } from "voyageai";

const COLLECTION_NAME = "salesbuster_kb";

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
 * Handle incoming chat message for static website
 */
export const handleStaticChatMessage = async ({ sessionId, message }) => {
  if (!message || typeof message !== "string" || !message.trim()) {
    throw new Error("Message text is required");
  }

  const trimmedMessage = message.trim();
  const effectiveSessionId = sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  // Retrieve or initialize session
  let session = sessions.get(effectiveSessionId);
  if (!session) {
    session = {
      messages: [],
      lastActive: Date.now(),
    };
    sessions.set(effectiveSessionId, session);
  }
  session.lastActive = Date.now();

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

  // 3. Formulate strict system prompt
  const systemPrompt = `You are the official AI Assistant for SalesBuster (https://salesbuster.ai/).
Your sole purpose is to assist website visitors by answering questions regarding the SalesBuster CRM platform, features, mobile app, integrations, and pricing using ONLY the provided knowledge base context below.

═══════════════════════════════════════════════════════════════
STRICT OPERATIONAL RULES:
1. STRICT GROUNDING: Answer exclusively from the facts in the Context section below. Do NOT hallucinate, guess, or reference outside information not provided in the context.
2. UNANSWERABLE QUESTIONS: If the question cannot be answered from the Context below, politely reply:
   "I don't have information on that in our knowledge base. For custom team rollouts, specific inquiries, or a live demo, please connect with the SalesBuster team directly through our website or WhatsApp."
3. ZERO CONTACT COLLECTION: NEVER ask the visitor for their phone number, email address, name, city, or personal contact info. Do not attempt to capture leads.
4. ACCURATE PRICING & COMMITTED PLANS:
   - Quarterly Plan: ₹5,995/month (+GST) for the Base Pack of 5 licences (billed quarterly as ₹17,985 every 3 months).
   - Yearly Plan: ₹4,495/month (+GST) for the Base Pack of 5 licences (billed annually as ₹53,940 representing a 25% saving).
   - Additional Licences: ₹1,199/user/month (Quarterly) or ₹899/user/month (Yearly).
   - Minimum commitment: 5 licences. 3 months for Quarterly, 12 months for Yearly.
   - Transparent Usage: Fixed CRM fee with 0% platform markup on WhatsApp Business messaging (at official Meta/BSP rates) and AI compute.
   - Never invent, estimate, or negotiate custom discounts beyond these official published plans.
5. FORMATTING: Be concise, clear, and professional. Use bullet points and markdown bolding for easy reading. Avoid overly long walls of text.
═══════════════════════════════════════════════════════════════

KNOWLEDGE BASE CONTEXT:
${retrievedContext || "No specific document chunks retrieved. Rely only on verified core knowledge."}

${formattedHistory ? `CONVERSATION HISTORY:\n${formattedHistory}\n` : ""}
Visitor Question: ${trimmedMessage}`;

  // 4. Generate answer with Gemini
  let reply = "";
  try {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    const model = new ChatGoogleGenerativeAI({
      model: "gemini-3.1-flash-lite",
      temperature: 0.1,
      maxOutputTokens: 1200,
      apiKey: geminiApiKey,
    });

    const response = await model.invoke([["user", systemPrompt]]);
    reply = (response?.content || "").trim();
  } catch (geminiErr) {
    console.error("[StaticChat] Gemini error:", geminiErr.message);
    // Fallback to gemini-2.5-flash or gemini-1.5-flash
    try {
      const fallbackModel = new ChatGoogleGenerativeAI({
        model: "gemini-2.5-flash",
        temperature: 0.1,
        maxOutputTokens: 1200,
        apiKey: process.env.GEMINI_API_KEY,
      });
      const response = await fallbackModel.invoke([["user", systemPrompt]]);
      reply = (response?.content || "").trim();
    } catch (fallbackErr) {
      console.error("[StaticChat] Fallback Gemini error:", fallbackErr.message);
      reply = "I'm currently unable to process your request. Please try again in a moment or visit salesbuster.ai for more information.";
    }
  }

  // 5. Update session history
  session.messages.push({ role: "user", text: trimmedMessage, timestamp: new Date() });
  session.messages.push({ role: "assistant", text: reply, timestamp: new Date() });

  return {
    reply,
    sessionId: effectiveSessionId,
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
