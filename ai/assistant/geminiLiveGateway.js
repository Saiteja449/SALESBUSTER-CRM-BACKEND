import { GoogleGenAI } from "@google/genai";
import { buildAssistantTools } from "./tools/index.js";
import { getISTDateBoundaries } from "./dateUtils.js";
import { executeToolCall } from "./toolRunner.js";
import { decryptApiKey } from "../../utils/encryption.js";
import { reserveAiQuota } from "../../services/aiUsageService.js";
import { VoiceTelemetry } from "./voiceTelemetry.js";
import {
  createEventCaptureTool,
  EVENT_CAPTURE_TOOL_DECLARATION,
} from "./tools/eventCaptureTool.js";

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
        salespersonId: { type: "STRING", description: "Specific sales rep user ID or name filter" },
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
        keyword: { type: "STRING", description: "Name, email, phone, or company search keyword" },
        status: { type: "STRING", description: "Status filter (e.g. 'New Lead', 'Follow Up', 'Converted', 'Lost')" },
        source: { type: "STRING", description: "Source filter (e.g. 'WhatsApp', 'Website', 'Manual')" },
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
        statusFilter: { type: "STRING", description: "'overdue', 'today', 'upcoming', or 'all'" },
        assignedTo: { type: "STRING", description: "Filter by salesperson user ID" },
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
        unreadOnly: { type: "BOOLEAN", description: "Only return chats with unread customer messages" },
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
  constructor({
    socket,
    user,
    organization,
    tenantModels,
    voiceName = "Aoede",
    sessionMode = "crm_assistant",
    eventId = null,
    eventName = null,
    silentMode = false,
  }) {
    this.socket = socket;
    this.user = user;
    this.organization = organization;
    this.tenantModels = tenantModels;
    this.voiceName = voiceName;
    this.sessionMode = sessionMode;
    this.eventId = eventId;
    this.eventName = eventName;
    this.silentMode = Boolean(silentMode);
    this.session = null;
    this.isActive = false;
    this.toolsByName = {};
    this.isSpeakingEmitted = false;
    this.isTurnReserved = false;
    this.currentTurnId = null;
    this.isReadyAcknowledged = false;
    this.startupStartTime = null;
    this.pendingAudioQueue = [];
    this.audioChunksInCount = 0;
    this.audioChunksOutCount = 0;
    this.audioBytesOutCount = 0;

    // Correlated Timing Telemetry
    this.telemetry = new VoiceTelemetry({
      socketId: socket?.id,
      orgId: organization?._id,
      userId: user?.id || user?._id,
      provider: "gemini",
    });

    // 1. Build Authenticated CRM Tools Suite
    const { toolsByName } = buildAssistantTools({
      tenantModels,
      organization,
      user,
    });
    this.toolsByName = toolsByName;

    // If running in event capture mode, bind the event contact trigger tool
    if (this.sessionMode === "event_capture") {
      const eventTool = createEventCaptureTool({
        socket: this.socket,
        eventId: this.eventId,
        eventName: this.eventName,
        user: this.user,
        organization: this.organization,
      });
      this.toolsByName[eventTool.name] = eventTool;
    }
  }

  /**
   * Ensures 1 unit of BI Analyst conversation quota is atomically reserved for the current voice query turn.
   */
  async ensureTurnQuota() {
    if (this.isTurnReserved) return true;
    const orgId = this.organization?._id;
    if (!orgId) return true;

    const reservation = await reserveAiQuota(orgId, "biAnalyst", 1);
    if (!reservation.allowed) {
      console.warn(`[Gemini Live Gateway] Quota exceeded for org ${orgId}: ${reservation.reason}`);
      this.socket.emit("bi_voice_error", {
        message: reservation.reason || "Daily quota limit reached for BI Analyst voice queries.",
        quotaExceeded: true,
      });
      this.socket.emit("bi_voice_turn_complete");
      this.close();
      return false;
    }

    this.isTurnReserved = true;
    return true;
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

    let systemPrompt = "";
    let functionDeclarations = CRM_LIVE_FUNCTION_DECLARATIONS;

    if (this.sessionMode === "event_capture") {
      const currentEvent = this.eventName || "our event";
      systemPrompt = `You are the SalesBuster Event Intelligence Ear for the event "${currentEvent}".
You are listening passively to an in-person conversation between sales representative ${managerName} (${orgName}) and an event attendee.

CRITICAL OPERATIONAL RULES:
1. SILENT LISTENER MODE (MANDATORY):
   - You MUST remain COMPLETELY SILENT.
   - NEVER speak aloud, generate audible voice audio, or respond to the attendee.
2. MULTILINGUAL RECOGNITION:
   - Understand English, Hindi, Telugu, Tamil, Marathi, and Hinglish code-switching naturally spoken in Indian business events.
3. REAL-TIME CAPTURE TRIGGER:
   - ONLY execute the tool 'trigger_contact_review' when ALL THREE core contact details have been completely and clearly spoken:
     1. Attendee's full Name.
     2. A complete 10-digit mobile phone number (digits only, e.g. "9876543210").
     3. Company / Business name.
   - DO NOT trigger the tool when only one or two details are spoken (e.g. do NOT trigger on Name alone, or if the phone number has fewer than 10 digits). Wait patiently until the conversation has revealed the Name, 10-digit Phone, and Company.
   - Extract:
     * name: Person's full name.
     * phone: Exactly 10-digit Indian mobile number (e.g. "9876543210").
     * companyName: Company/business name.
     * summary: 1-2 sentence discussion summary or requirement.
     * suggestedMessage: A warm, personalized WhatsApp follow-up greeting from ${managerName} (${orgName}) referencing ${currentEvent}.
4. STRICT ZERO HALLUCINATION:
   - If any required detail (Name, full 10-digit Phone, or Company) has NOT been spoken yet by the attendee, DO NOT call 'trigger_contact_review'. Never invent or guess phone numbers or companies.`;

      functionDeclarations = [EVENT_CAPTURE_TOOL_DECLARATION, ...CRM_LIVE_FUNCTION_DECLARATIONS];
    } else {
      systemPrompt = `You are the executive AI Voice CRM Assistant for "${orgName}", talking directly with ${managerName} (Sales Manager) in real-time.
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
   - Give direct executive answers, highlighting the most vital figures first.
3. TOOL SELECTION RULES:
   - Lead counts, conversion rate, today vs yesterday, morning leads: CALL 'get_dashboard_kpis'
   - Sales reps, leaderboard, top performers, won deals: CALL 'get_salesperson_performance'
   - Finding leads by name, source, service, status: CALL 'search_leads'
   - Phone numbers: CALL 'lookup_phone_number'
   - Overdue tasks and follow-ups: CALL 'get_followup_status'
   - WhatsApp unread chats: CALL 'get_whatsapp_analytics'
   - Integrations and configurations: CALL 'get_org_integrations_and_config'`;
    }

    const liveModel =
      process.env.AI_ASSISTANT_LIVE_MODEL ||
      "gemini-3.8-live";

    console.log(`[Gemini Live Gateway] Connecting user ${this.user?.id} to model ${liveModel} (Mode: ${this.sessionMode}, Silent: ${this.silentMode})`);

    const config = {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: this.voiceName,
          },
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      tools: [
        {
          functionDeclarations,
        },
      ],
    };

    this.startupStartTime = Date.now();
    this.telemetry.logEvent("session_startup_initiated", { model: liveModel, voiceName: this.voiceName });

    try {
      // Connect to Gemini Live WebSocket. The returned promise resolves ONLY after setupComplete is verified.
      this.session = await ai.live.connect({
        model: liveModel,
        config,
        callbacks: {
          onopen: () => {
            console.log(`[Gemini Live Gateway] WebSocket transport opened for socket ${this.socket.id}`);
          },
          onmessage: async (serverMsg) => {
            await this.handleServerMessage(serverMsg);
          },
          onerror: (err) => {
            this.telemetry.logEvent("session_error", { error: err?.message || "Gemini Live API error" });
            console.error(`[Gemini Live Gateway] Live session error for socket ${this.socket.id}:`, err);
            this.socket.emit("bi_voice_error", { message: err?.message || "Gemini Live API error" });
          },
          onclose: (closeEvt) => {
            this.isActive = false;
            this.telemetry.logEvent("session_closed");
            this.socket.emit("bi_voice_status", { state: "closed" });
            console.log(`[Gemini Live Gateway] Live session closed for socket ${this.socket.id}`);
          },
        },
      });

      // Session is now 100% established and ready to process audio input
      this.isActive = true;
      this.isReadyAcknowledged = true;
      const startupMs = Date.now() - (this.startupStartTime || Date.now());
      this.telemetry.logEvent("session_ready", { startupMs, model: liveModel });

      // Flush any microphone chunks buffered during connection handshake
      if (this.pendingAudioQueue.length > 0) {
        console.log(`[Gemini Live Gateway] Flushing ${this.pendingAudioQueue.length} buffered audio chunk(s) to Gemini`);
        while (this.pendingAudioQueue.length > 0) {
          const chunk = this.pendingAudioQueue.shift();
          try {
            this.session.sendRealtimeInput({
              audio: {
                mimeType: "audio/pcm;rate=16000",
                data: chunk,
              },
            });
          } catch (e) {}
        }
      }

      // Explicit Session-Ready Acknowledgement (Gates Audio Streaming on Frontend & Mobile)
      this.socket.emit("bi_voice_ready", {
        sessionId: this.telemetry.sessionId,
        startupMs,
        model: liveModel,
        provider: "gemini",
      });

      this.socket.emit("bi_voice_status", {
        state: "connected",
        model: liveModel,
        sessionId: this.telemetry.sessionId,
        startupMs,
      });

      console.log(`[Gemini Live Gateway] Live session fully READY in ${startupMs}ms for socket ${this.socket.id}`);
    } catch (err) {
      this.telemetry.logEvent("session_startup_failed", { error: err.message });
      console.error("[Gemini Live Gateway] Failed to connect to Gemini Live API:", err);
      this.socket.emit("bi_voice_error", { message: err.message || "Failed to start Gemini Live voice session" });
      throw err;
    }
  }

  /**
   * Friendly label generator for CRM tools in UI
   */
  getFriendlyToolLabel(toolName) {
    const labels = {
      get_dashboard_kpis: "Calculating CRM dashboard KPIs",
      get_salesperson_performance: "Analyzing sales rep leaderboard",
      search_leads: "Searching CRM leads",
      lookup_phone_number: "Looking up contact in CRM",
      get_followup_status: "Checking pending follow-ups",
      get_whatsapp_analytics: "Inspecting WhatsApp chat status",
      get_org_integrations_and_config: "Verifying system configuration",
      search_crm_documentation_and_features: "Searching documentation",
    };
    return labels[toolName] || `Querying CRM tool (${toolName})`;
  }

  /**
   * Handles incoming server messages from Gemini Live API
   */
  async handleServerMessage(serverMsg) {
    if (!serverMsg) return;

    if (serverMsg.setupComplete) {
      console.log(`[LiveVoice Setup] setupComplete received from Gemini Live API for socket ${this.socket.id}`);
    }

    if (serverMsg.goAway) {
      console.warn(`[LiveVoice Warning] Gemini sent goAway notice! timeLeft:`, serverMsg.goAway.timeLeft);
    }

    // 1. Tool Calls from Gemini mid-speech (CONCURRENT EXECUTION)
    if (serverMsg.toolCall?.functionCalls?.length > 0) {
      if (this.currentTurnId) {
        this.telemetry.recordFirstProviderResponse(this.currentTurnId);
      }

      const hasQuota = await this.ensureTurnQuota();
      if (!hasQuota) return;

      const functionCalls = serverMsg.toolCall.functionCalls;
      const isParallel = functionCalls.length > 1;
      const firstToolName = functionCalls[0].name;
      const friendlyLabel = isParallel
        ? `Running ${functionCalls.length} CRM queries concurrently`
        : this.getFriendlyToolLabel(firstToolName);

      this.socket.emit("bi_voice_status", {
        state: "tool_running",
        toolName: firstToolName,
        friendlyLabel,
        toolNames: functionCalls.map((fc) => fc.name),
        count: functionCalls.length,
        concurrent: isParallel,
      });

      console.log(
        `[LiveVoice ToolCall] Gemini requested ${functionCalls.length} tool(s) ${isParallel ? "CONCURRENTLY" : ""} for socket ${this.socket.id}: ${functionCalls.map((fc) => fc.name).join(", ")}`
      );

      const toolBatchStart = Date.now();

      // Execute all tool calls concurrently while strictly preserving tenant isolation and result ordering
      const functionResponses = await Promise.all(
        functionCalls.map(async (fc) => {
          const fcStart = Date.now();
          console.log(`[LiveVoice ToolCall] Starting execution: ${fc.name} (args: ${JSON.stringify(fc.args || {})})`);
          const result = await executeToolCall({
            toolCall: { id: fc.id, name: fc.name, args: fc.args || {} },
            toolsByName: this.toolsByName,
            timeoutMs: 6500,
          });
          const fcDurationMs = Date.now() - fcStart;
          console.log(`[LiveVoice ToolCall] Finished ${fc.name} in ${fcDurationMs}ms (ok: ${result.ok})`);

          this.telemetry.recordToolExecution({
            turnId: this.currentTurnId,
            toolName: fc.name,
            toolCallId: fc.id,
            durationMs: fcDurationMs,
            ok: result.ok,
            concurrent: isParallel,
          });

          return {
            id: fc.id,
            name: fc.name,
            response: { output: result.output },
          };
        })
      );

      const totalBatchDurationMs = Date.now() - toolBatchStart;
      console.log(`[LiveVoice ToolComplete] Batch finished in ${totalBatchDurationMs}ms -> returning tool responses to Gemini`);

      // Return tool results back to Gemini Live API
      try {
        if (this.session && this.isActive) {
          this.session.sendToolResponse({ functionResponses });
          this.socket.emit("bi_voice_status", {
            state: "tool_complete",
            durationMs: totalBatchDurationMs,
            toolNames: functionCalls.map((fc) => fc.name),
          });
        }
      } catch (toolErr) {
        console.error("[LiveVoice ToolError] Error returning tool response to Gemini:", toolErr);
      }
      return;
    }

    // 2. Server Content: Audio chunks, text transcripts, and interruption signals
    const content = serverMsg.serverContent;
    if (content) {
      // Check for native user barge-in / interruption
      if (content.interrupted) {
        console.log(`[LiveVoice Interruption] User barged in / interrupted speech on socket ${this.socket.id}`);
        if (this.currentTurnId) {
          this.telemetry.logEvent("turn_interrupted", { turnId: this.currentTurnId });
          this.currentTurnId = null;
        }
        this.isSpeakingEmitted = false;
        this.isTurnReserved = false;
        this.socket.emit("bi_voice_interrupted");
        this.socket.emit("bi_voice_status", { state: "listening" });
      }

      // Process model turn parts
      if (content.modelTurn?.parts) {
        if (this.currentTurnId) {
          this.telemetry.recordFirstProviderResponse(this.currentTurnId);
        }

        const hasQuota = await this.ensureTurnQuota();
        if (!hasQuota) return;

        for (const part of content.modelTurn.parts) {
          // Audio chunk (24kHz PCM) - Muted in silent listener mode
          if (part.inlineData?.data && !this.silentMode) {
            this.audioChunksOutCount++;
            this.audioBytesOutCount += part.inlineData.data.length;

            if (!this.isSpeakingEmitted) {
              this.isSpeakingEmitted = true;
              this.telemetry.recordFirstAudio(this.currentTurnId);
              this.socket.emit("bi_voice_status", { state: "speaking" });
              console.log(
                `[LiveVoice AudioOut] >>> FIRST voice audio emitted for turn ${this.currentTurnId || "unknown"} (chunk #${this.audioChunksOutCount}, ${part.inlineData.data.length} chars base64)`
              );
            }

            this.socket.emit("bi_voice_audio_out", {
              mimeType: part.inlineData.mimeType || "audio/pcm;rate=24000",
              data: part.inlineData.data, // base64 string
              turnId: this.currentTurnId,
            });
          }
          // Real-time text subtitle
          if (part.text) {
            console.log(`[LiveVoice TextPart] "${part.text.slice(0, 80)}"`);
            this.socket.emit("bi_voice_transcript", {
              role: "assistant",
              text: part.text,
            });
          }
        }
      }

      // Real-time user speech transcription (supported by gemini-3.8-live)
      const userText = content.inputTranscription?.text || content.interimInputTranscription?.text;
      if (userText) {
        console.log(`[LiveVoice Transcription] User speech recognized: "${userText}"`);
        this.socket.emit("bi_voice_transcript", {
          role: "user",
          text: userText,
        });
      }

      // Real-time text subtitle from outputTranscription (native channel for gemini-3.8-live)
      if (content.outputTranscription?.text) {
        if (this.currentTurnId) {
          this.telemetry.recordFirstProviderResponse(this.currentTurnId);
        }
        console.log(`[LiveVoice Transcription] Assistant subtitle: "${content.outputTranscription.text}"`);
        this.socket.emit("bi_voice_transcript", {
          role: "assistant",
          text: content.outputTranscription.text,
        });
      }

      // Turn complete flag — reset speaking and quota reservation trackers for the next turn
      if (content.turnComplete) {
        console.log(
          `[LiveVoice TurnComplete] Turn ${this.currentTurnId || "unknown"} finished! User mic chunks in: ${this.audioChunksInCount}, Assistant audio chunks out: ${this.audioChunksOutCount} (${this.audioBytesOutCount} bytes). Emitted 'listening'.`
        );
        if (this.currentTurnId) {
          this.telemetry.endTurn(this.currentTurnId);
          this.currentTurnId = null;
        }
        this.audioChunksInCount = 0;
        this.audioChunksOutCount = 0;
        this.audioBytesOutCount = 0;
        this.isSpeakingEmitted = false;
        this.isTurnReserved = false;
        this.socket.emit("bi_voice_turn_complete");
        this.socket.emit("bi_voice_status", { state: "listening" });
      }
    }
  }

  /**
   * Receives incoming PCM 16kHz audio chunk from user microphone and sends to Gemini
   */
  sendAudioChunk(base64Chunk) {
    if (!base64Chunk) return;

    // Buffer chunks if session connection is still resolving
    if (!this.session || !this.isActive) {
      if (this.pendingAudioQueue.length < 100) {
        this.pendingAudioQueue.push(base64Chunk);
        if (this.pendingAudioQueue.length === 1 || this.pendingAudioQueue.length % 25 === 0) {
          console.log(`[LiveVoice AudioIn] Buffering pre-connect mic chunk (buffered count: ${this.pendingAudioQueue.length}) for socket ${this.socket?.id}`);
        }
      }
      return;
    }

    // Flush any pending queue
    if (this.pendingAudioQueue.length > 0) {
      console.log(`[LiveVoice AudioIn] Flushing ${this.pendingAudioQueue.length} pre-buffered chunks to Gemini Live`);
      while (this.pendingAudioQueue.length > 0) {
        const buffered = this.pendingAudioQueue.shift();
        try {
          this.session.sendRealtimeInput({
            audio: {
              mimeType: "audio/pcm;rate=16000",
              data: buffered,
            },
          });
        } catch (e) {}
      }
    }

    if (!this.currentTurnId) {
      this.currentTurnId = this.telemetry.startTurn();
      this.audioChunksInCount = 0;
      this.audioChunksOutCount = 0;
      this.audioBytesOutCount = 0;
      console.log(`[LiveVoice Turn] New turn ${this.currentTurnId} initiated by user mic audio`);
    }

    this.audioChunksInCount++;
    if (this.audioChunksInCount === 1) {
      console.log(`[LiveVoice AudioIn] First mic chunk (${base64Chunk.length} chars) sent to Gemini for turn ${this.currentTurnId}`);
    } else if (this.audioChunksInCount % 50 === 0) {
      const estimatedSec = (this.audioChunksInCount * 0.032).toFixed(1);
      console.log(`[LiveVoice AudioIn] Streamed ${this.audioChunksInCount} chunks (~${estimatedSec}s audio) for turn ${this.currentTurnId}`);
    }

    try {
      this.session.sendRealtimeInput({
        audio: {
          mimeType: "audio/pcm;rate=16000",
          data: base64Chunk,
        },
      });
    } catch (err) {
      console.warn("[LiveVoice AudioIn] Error sending audio chunk to Gemini:", err.message);
    }
  }

  /**
   * Closes active Live session cleanly
   */
  close() {
    this.isActive = false;
    this.pendingAudioQueue = [];
    this.audioChunksInCount = 0;
    this.audioChunksOutCount = 0;
    this.audioBytesOutCount = 0;
    if (this.currentTurnId) {
      this.telemetry.endTurn(this.currentTurnId);
      this.currentTurnId = null;
    }
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
