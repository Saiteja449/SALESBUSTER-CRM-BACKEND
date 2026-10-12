import { GoogleGenAI } from "@google/genai";
import { buildAssistantTools } from "./tools/index.js";
import { getISTDateBoundaries } from "./dateUtils.js";
import { executeToolCall } from "./toolRunner.js";
import { decryptApiKey } from "../../utils/encryption.js";

/**
 * Standard Function Declarations for Gemini Live API
 * Maps directly to our tenant-isolated CRM assistant tools
 */
export const CRM_LIVE_FUNCTION_DECLARATIONS = [
  {
    name: "get_dashboard_kpis",
    description: "Calculates total leads, converted count, conversion rate percentage, status breakdown, and source distribution for any time period.",
    parameters: {
      type: "OBJECT",
      properties: {
        period: {
          type: "STRING",
          description: "Target time window: 'all_time', 'today', 'yesterday', 'this_morning', 'this_afternoon', 'this_evening', 'this_week', 'this_month', 'last_month', 'last_7_days', 'last_30_days', 'custom'",
        },
        customStart: { type: "STRING", description: "YYYY-MM-DD start date if period is custom" },
        customEnd: { type: "STRING", description: "YYYY-MM-DD end date if period is custom" },
        compareToPrevious: { type: "BOOLEAN", description: "Compare metrics against previous period" },
      },
    },
  },
  {
    name: "get_salesperson_performance",
    description: "Generates performance metrics and leaderboard for sales reps: leads handled, won deals, conversion rate, and revenue.",
    parameters: {
      type: "OBJECT",
      properties: {
        period: {
          type: "STRING",
          description: "Time window: 'today', 'yesterday', 'this_week', 'this_month', 'all_time', 'custom'",
        },
        salespersonNameOrId: { type: "STRING", description: "Specific sales rep name or user ID filter" },
        customStart: { type: "STRING", description: "YYYY-MM-DD start date" },
        customEnd: { type: "STRING", description: "YYYY-MM-DD end date" },
      },
    },
  },
  {
    name: "search_leads",
    description: "Searches CRM leads by keyword, status, source, service, or date range.",
    parameters: {
      type: "OBJECT",
      properties: {
        searchTerm: { type: "STRING", description: "Name, company, city, tag, or notes search keyword" },
        status: { type: "STRING", description: "Exact CRM status: 'New', 'Missed Call', 'Follow Up', 'Not Interested', 'Not Attended', 'Price Issue', or 'Converted'" },
        source: { type: "STRING", description: "Exact CRM source: 'Email', 'WhatsApp', 'Meta Ads', 'Website Form', 'Website Chat', 'Call', 'Manual Entry', 'Mobile App', or 'Excel Import'" },
        service: { type: "STRING", description: "Service offering name" },
        limit: { type: "INTEGER", description: "Number of records to return (1-20)" },
      },
    },
  },
  {
    name: "lookup_phone_number",
    description: "Looks up a specific contact or lead by phone number in the CRM.",
    parameters: {
      type: "OBJECT",
      properties: {
        phone: { type: "STRING", description: "Phone number with or without country code" },
      },
      required: ["phone"],
    },
  },
  {
    name: "get_followup_status",
    description: "Retrieves pending, overdue, and scheduled follow-up tasks for leads.",
    parameters: {
      type: "OBJECT",
      properties: {
        filter: { type: "STRING", description: "'all_pending', 'overdue', 'pending_today', 'upcoming', or 'completed'" },
        priority: { type: "STRING", description: "Optional priority filter: 'High', 'Medium', or 'Low'" },
        limit: { type: "INTEGER", description: "Max count to return" },
      },
    },
  },
  {
    name: "get_whatsapp_analytics",
    description: "Checks unread WhatsApp messages, incoming customer inquiries awaiting reply, and chat volume.",
    parameters: {
      type: "OBJECT",
      properties: {
        type: { type: "STRING", description: "'unread_leads', 'unreplied_leads', or 'recent_messages_overview'" },
        limit: { type: "INTEGER", description: "Max chats to inspect" },
      },
    },
  },
  {
    name: "get_org_integrations_and_config",
    description: "Checks organization settings, active WhatsApp session, AI limits, and subscription configuration.",
    parameters: {
      type: "OBJECT",
      properties: {},
    },
  },
  {
    name: "search_crm_documentation_and_features",
    description: "Searches documentation on how to use CRM features, WhatsApp campaign rules, and system guides.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "The feature or guide question to search" },
      },
      required: ["query"],
    },
  },
];

/**
 * Creates and manages a live bidirectional Gemini Multimodal Live API session
 * for real-time speech-to-speech with live CRM database tool execution.
 */
export class GeminiLiveSessionManager {
  constructor({ socket, user, organization, tenantModels, voiceName = "Aoede" }) {
    this.socket = socket;
    this.user = user;
    this.organization = organization;
    this.tenantModels = tenantModels;
    this.voiceName = voiceName;
    this.session = null;
    this.isActive = false;
    this.toolsByName = {};

    // 1. Build Authenticated CRM Tools Suite
    const { toolsByName } = buildAssistantTools({
      tenantModels,
      organization,
      user,
    });
    this.toolsByName = toolsByName;
  }

  /**
   * Initializes connection to Google Gemini Live API
   */
  async start() {
    const geminiApiKey =
      decryptApiKey(this.organization?.aiSettings?.geminiApiKey) || process.env.GEMINI_API_KEY;

    if (!geminiApiKey) {
      throw new Error(
        "Google Gemini API Key is not configured. Please configure it in Organization Settings."
      );
    }

    const ai = new GoogleGenAI({ apiKey: geminiApiKey });

    // Temporal context
    const boundaries = getISTDateBoundaries();
    const orgName = this.organization?.name || "Our Organization";
    const managerName = this.user?.name || "Sales Manager";

    const systemPrompt = `You are the executive AI Voice CRM Assistant for "${orgName}", talking directly with ${managerName} (Sales Manager) in real-time.
You have instant access to the live MongoDB database of the CRM via specialized tools.

=======================================================
REAL-WORLD SYSTEM TEMPORAL CONTEXT (India Standard Time - IST):
- Current Date: ${boundaries.todayStr} (${new Date().toLocaleDateString("en-IN", { weekday: "long", timeZone: "Asia/Kolkata" })})
- Current Time: ${new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" })} IST
- Today Window: ${boundaries.today.label}
- This Morning Window: 06:00 AM to 12:00 PM IST
- Yesterday: ${boundaries.yesterday.label}
- Current Month: ${boundaries.thisMonth.label}
=======================================================

STRICT OPERATIONAL & VOICE DIALOGUE RULES:
1. ZERO HALLUCINATION INVARIANT:
   - Every metric, count, percentage, lead name, or performance number MUST come from tool responses.
   - NEVER invent or guess CRM metrics. Call the appropriate tool immediately whenever asked about data.
   - If a tool returns 0 or no matching leads, state clearly and factually that there are 0 records.
2. SPOKEN DIALOGUE OPTIMIZATION:
   - This is real-time speech! Speak naturally, crisply, and conversationally.
   - Do NOT read aloud markdown characters, asterisks, hash headers, or table delimiters.
   - Lead with the direct answer, then give the period and the one or two figures that best support it.
   - Explain whether a number is a total or only the returned sample. For example, distinguish total matching records from the limited names shown.
   - Add a brief, useful implication or next step only when it follows from the returned data. Label interpretations as interpretations; never claim the data proves a cause.
   - If the result is empty, partial, or an error, say so plainly and suggest a narrower or corrected query when useful.
   - Keep spoken answers to a few short sentences. Read names and amounts clearly; disclose phone numbers only when the user asks for contact details.
3. TOOL SELECTION RULES:
   - Lead counts, conversion rate, today vs yesterday, morning leads: CALL 'get_dashboard_kpis'
   - Sales reps, leaderboard, top performers, won deals: CALL 'get_salesperson_performance'
   - Finding leads by name, source, service, status: CALL 'search_leads'
   - Phone numbers: CALL 'lookup_phone_number'
   - Overdue tasks and follow-ups: CALL 'get_followup_status'
   - WhatsApp unread chats: CALL 'get_whatsapp_analytics'
   - Integrations and configurations: CALL 'get_org_integrations_and_config'`;

    const liveModel =
      process.env.AI_ASSISTANT_LIVE_MODEL ||
      "gemini-2.5-flash-native-audio-preview-12-2025";

    console.log(`[Gemini Live Gateway] Connecting user ${this.user?.id} to model ${liveModel} (Voice: ${this.voiceName})`);

    const config = {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: this.voiceName,
          },
        },
      },
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      tools: [
        {
          functionDeclarations: CRM_LIVE_FUNCTION_DECLARATIONS,
        },
      ],
    };

    try {
      this.session = await ai.live.connect({
        model: liveModel,
        config,
        callbacks: {
          onopen: () => {
            this.isActive = true;
            this.socket.emit("bi_voice_status", { state: "connected", model: liveModel });
            console.log(`[Gemini Live Gateway] Live session opened for socket ${this.socket.id}`);
          },
          onmessage: async (serverMsg) => {
            await this.handleServerMessage(serverMsg);
          },
          onerror: (err) => {
            console.error(`[Gemini Live Gateway] Live session error for socket ${this.socket.id}:`, err);
            this.socket.emit("bi_voice_error", { message: err?.message || "Gemini Live API error" });
          },
          onclose: (closeEvt) => {
            this.isActive = false;
            this.socket.emit("bi_voice_status", { state: "closed" });
            console.log(`[Gemini Live Gateway] Live session closed for socket ${this.socket.id}`);
          },
        },
      });

      this.isActive = true;
    } catch (err) {
      console.error("[Gemini Live Gateway] Failed to connect to Gemini Live API:", err);
      this.socket.emit("bi_voice_error", { message: err.message || "Failed to start Gemini Live voice session" });
      throw err;
    }
  }

  /**
   * Handles incoming server messages from Gemini Live API
   */
  async handleServerMessage(serverMsg) {
    if (!serverMsg) return;

    // 1. Tool Calls from Gemini mid-speech
    if (serverMsg.toolCall?.functionCalls?.length > 0) {
      const functionCalls = serverMsg.toolCall.functionCalls;
      const functionResponses = [];

      for (const fc of functionCalls) {
        console.log(`[Gemini Live Gateway] Executing tool '${fc.name}' for socket ${this.socket.id}`);
        this.socket.emit("bi_voice_status", { state: "tool_running", toolName: fc.name });

        const result = await executeToolCall({
          toolCall: { id: fc.id, name: fc.name, args: fc.args || {} },
          toolsByName: this.toolsByName,
          timeoutMs: 6500,
        });

        functionResponses.push({
          id: fc.id,
          name: fc.name,
          response: { output: result.output },
        });
      }

      // Return tool results back to Gemini Live API
      try {
        if (this.session && this.isActive) {
          this.session.sendToolResponse({ functionResponses });
          this.socket.emit("bi_voice_status", { state: "tool_complete" });
        }
      } catch (toolErr) {
        console.error("[Gemini Live Gateway] Error returning tool response to Gemini:", toolErr);
      }
      return;
    }

    // 2. Server Content: Audio chunks, text transcripts, and interruption signals
    const content = serverMsg.serverContent;
    if (content) {
      // Check for native user barge-in / interruption
      if (content.interrupted) {
        console.log(`[Gemini Live Gateway] Model interrupted by user speech on socket ${this.socket.id}`);
        this.socket.emit("bi_voice_interrupted");
      }

      // Process model turn parts
      if (content.modelTurn?.parts) {
        for (const part of content.modelTurn.parts) {
          // Audio chunk (24kHz PCM)
          if (part.inlineData?.data) {
            this.socket.emit("bi_voice_audio_out", {
              mimeType: part.inlineData.mimeType || "audio/pcm;rate=24000",
              data: part.inlineData.data, // base64 string
            });
          }
          // Real-time text subtitle
          if (part.text) {
            this.socket.emit("bi_voice_transcript", {
              role: "assistant",
              text: part.text,
            });
          }
        }
      }

      // Turn complete flag
      if (content.turnComplete) {
        this.socket.emit("bi_voice_turn_complete");
      }
    }
  }

  /**
   * Receives incoming PCM 16kHz audio chunk from user microphone and sends to Gemini
   */
  sendAudioChunk(base64Chunk) {
    if (!this.session || !this.isActive || !base64Chunk) return;
    try {
      this.session.sendRealtimeInput({
        media: {
          mimeType: "audio/pcm;rate=16000",
          data: base64Chunk,
        },
      });
    } catch (err) {
      console.warn("[Gemini Live Gateway] Error sending audio chunk to Gemini:", err.message);
    }
  }

  /**
   * Closes active Live session cleanly
   */
  close() {
    this.isActive = false;
    if (this.session) {
      try {
        this.session.close();
      } catch (err) {
        console.warn("[Gemini Live Gateway] Error closing session:", err.message);
      }
      this.session = null;
    }
  }
}
