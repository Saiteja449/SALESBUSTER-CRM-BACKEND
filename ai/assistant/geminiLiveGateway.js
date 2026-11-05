import mongoose from "mongoose";
import { GoogleGenAI, StartSensitivity, EndSensitivity } from "@google/genai";
import { buildAssistantTools } from "./tools/index.js";
import { getISTDateBoundaries } from "./dateUtils.js";
import { executeToolCall } from "./toolRunner.js";
import { decryptApiKey } from "../../utils/encryption.js";
import { reserveAiQuota } from "../../services/aiUsageService.js";
import { VoiceTelemetry } from "./voiceTelemetry.js";

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
  {
    name: "compose_salesperson_report_email",
    description: "Composes a daily, weekly, monthly, or custom date sales performance report email for a specific salesperson or the entire team, and stages it for mandatory user confirmation. MUST be called first when asked to email or send reports.",
    parameters: {
      type: "OBJECT",
      properties: {
        period: {
          type: "STRING",
          description: "Report period: 'today' (daily), 'yesterday', 'this_week' (weekly), 'this_month' (monthly), 'last_month', 'last_7_days', 'last_30_days', 'custom', or 'all_time'",
        },
        salespersonNameOrId: {
          type: "STRING",
          description: "Name or ID of salesperson (e.g. 'Ramesh', 'Priya'). Use 'all' or leave empty with sendToAll: true for all reps.",
        },
        sendToAll: {
          type: "BOOLEAN",
          description: "Set to true to compose and send report emails to all active sales reps.",
        },
        customStart: {
          type: "STRING",
          description: "YYYY-MM-DD custom start date when period is 'custom'",
        },
        customEnd: {
          type: "STRING",
          description: "YYYY-MM-DD custom end date when period is 'custom'",
        },
      },
      required: ["period"],
    },
  },
  {
    name: "confirm_send_email_report",
    description: "Dispatches or cancels the composed report email after explicit human confirmation from the user (e.g., 'yes, send it', 'send the email', 'confirm', or 'no, cancel it', 'don't send').",
    parameters: {
      type: "OBJECT",
      properties: {
        draftId: {
          type: "STRING",
          description: "The draft ID of the report email (optional if only one pending draft exists)",
        },
        confirmed: {
          type: "BOOLEAN",
          description: "true if user agreed to send; false if user declined or cancelled",
        },
      },
      required: ["confirmed"],
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
    chatId = null,
  }) {
    this.socket = socket;
    this.user = user;
    this.organization = organization;
    this.tenantModels = tenantModels;
    this.voiceName = voiceName;
    this.sessionMode = sessionMode;
    this.eventId = eventId;
    this.eventName = eventName;
    this.silentMode = sessionMode === "event_capture" ? true : Boolean(silentMode);
    this.chatId = chatId;
    this.currentTurnUserText = "";
    this.currentTurnAssistantText = "";
    this.currentTurnToolsUsed = [];
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
    this.forwardedChunksStartTime = null;
    this.lastNoResponseEmittedAt = 0;

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
      socket: this.socket,
    });
    this.toolsByName = toolsByName;

    // Event capture is handled by dedicated conversation capture pipeline (conversationSocket)
  }

  /**
   * Voice agent calling turns are exempt from BI Analyst quota deductions.
   * Ensures voice queries proceed without deducting from the organization's daily BI credits.
   */
  async ensureTurnQuota() {
    // Voice agent calling is exempt from BI agent credit deductions
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
    const repPhone = (this.user?.phone || "").replace(/\D/g, "").slice(-10);

    let systemPrompt = "";
    let functionDeclarations = CRM_LIVE_FUNCTION_DECLARATIONS;

    if (this.sessionMode === "event_capture") {
      console.warn("[Gemini Live Gateway] sessionMode 'event_capture' is deprecated in gateway; use conversationSocket instead.");
    }
    systemPrompt = systemPrompt = `You are the executive AI Voice CRM Assistant for "${orgName}", talking directly with ${managerName} (Sales Manager) in real-time.
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
   - Integrations and configurations: CALL 'get_org_integrations_and_config'
   - Composing sales report emails: CALL 'compose_salesperson_report_email'
   - Confirming or cancelling email report send: CALL 'confirm_send_email_report'

4. EMAIL REPORT ACTIONS & MANDATORY HUMAN CONFIRMATION (CRITICAL):
   - When the user asks to email or send a report (daily, yesterday, weekly, monthly, custom dates, or all-time) to sales rep(s):
     * Step 1: ALWAYS call 'compose_salesperson_report_email' first. NEVER claim an email is sent without asking for confirmation!
     * Step 2: Once 'compose_salesperson_report_email' finishes, state the recipient name, recipient email, time period, and key stats (leads, conversions, deal value, calls) in spoken voice, and EXPLICITLY ask the user: "Would you like me to send this email now?"
     * Step 3: Wait for user verbal confirmation:
       - If they say "yes", "send it", "confirm", "send", "go ahead": Call 'confirm_send_email_report' with confirmed: true.
       - If they say "no", "cancel", "don't send", "discard": Call 'confirm_send_email_report' with confirmed: false.
       - Then announce the result conversationally.`;;

    const liveModel =
      process.env.AI_ASSISTANT_LIVE_MODEL ||
      "gemini-3.8-live";

    console.log(`[Gemini Live Gateway] Connecting user ${this.user?.id} to model ${liveModel} (Mode: ${this.sessionMode}, Silent: ${this.silentMode})`);

    const defaultVoiceLanguages = ["en-IN", "hi-IN", "te-IN"];
    const voiceLanguages = process.env.VOICE_INPUT_LANGUAGES
      ? process.env.VOICE_INPUT_LANGUAGES.split(",").map((l) => l.trim()).filter(Boolean)
      : (this.organization?.aiSettings?.voiceLanguages || defaultVoiceLanguages);

    const customVocab = [
      this.eventName,
      orgName,
      managerName,
      "WhatsApp",
      "SalesBuster",
      "Managing Director",
      "Purchase Head",
      "CEO",
      "Owner",
      "Director",
    ].filter(Boolean);

    const transcriptionMode = (process.env.VOICE_TRANSCRIPTION_MODE || "basic").toLowerCase().trim();
    // Event capture needs verbatim captions for CRM field extraction. Keep
    // language and vocabulary hints enabled in this mode even when the general
    // assistant is configured for basic transcription.
    const inputAudioTranscription =
      transcriptionMode === "enhanced"
        ? {
            languageCodes: voiceLanguages,
            customVocabulary: customVocab,
          }
        : {};

    const realtimeInputConfig = undefined;

    const config = {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: this.voiceName,
          },
        },
      },
      inputAudioTranscription,
      ...(realtimeInputConfig ? { realtimeInputConfig } : {}),
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
   * Handles interactive confirmation/cancellation from UI buttons
   */
  async handleActionConfirmation({ draftId, confirmed }) {
    try {
      const confirmTool = this.toolsByName["confirm_send_email_report"];
      if (!confirmTool) {
        console.warn("[GeminiLiveSessionManager] confirm_send_email_report tool not found");
        return { status: "error", message: "Confirmation tool not available." };
      }

      console.log(`[GeminiLiveSessionManager] Executing UI confirmation for draftId ${draftId}, confirmed: ${confirmed}`);
      const rawResult = await confirmTool.invoke({ draftId, confirmed });
      const result = typeof rawResult === "string" ? JSON.parse(rawResult) : rawResult;

      // In real-time voice, let Gemini know the user made a choice via the UI
      if (this.session && this.isActive) {
        const textPrompt = confirmed
          ? "The user clicked 'Send Email' in the CRM screen. The report email was dispatched successfully. Inform the user in 1 short spoken sentence that their email was sent."
          : "The user clicked 'Cancel' in the CRM screen. The report email was discarded. Acknowledge this cancellation in 1 short spoken sentence.";
        try {
          this.session.sendRealtimeInput({
            text: textPrompt,
          });
        } catch (promptErr) {
          console.warn("[GeminiLiveSessionManager] Could not send prompt injection to Gemini:", promptErr.message);
        }
      }

      return result;
    } catch (err) {
      console.error("[GeminiLiveSessionManager] Error handling action confirmation:", err);
      return { status: "error", message: err.message };
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
      compose_salesperson_report_email: "Composing performance report email draft",
      confirm_send_email_report: "Processing report email dispatch",
    };
    return labels[toolName] || `Querying CRM tool (${toolName})`;
  }

  /**
   * Handles incoming server messages from Gemini Live API
   */
  async handleServerMessage(serverMsg) {
    if (!serverMsg) return;

    // Reset watchdog on ANY server message
    this.forwardedChunksStartTime = null;

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
      for (const fc of functionCalls) {
        if (!this.currentTurnToolsUsed.includes(fc.name)) {
          this.currentTurnToolsUsed.push(fc.name);
        }
      }
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
            this.currentTurnAssistantText += part.text;
            console.log(`[LiveVoice TextPart] "${part.text.slice(0, 80)}"`);
            this.socket.emit("bi_voice_transcript", {
              role: "assistant",
              text: part.text,
            });
          }
        }
      }

      // Real-time user speech transcription (defensively checking both interim and final)
      const rawInterim = content.interimInputTranscription || serverMsg.interimInputTranscription;
      const rawFinal = content.inputTranscription || serverMsg.inputTranscription;

      const interimText = typeof rawInterim?.text === "string" ? rawInterim.text : null;
      const finalText = typeof rawFinal?.text === "string" ? rawFinal.text : null;

      // Interim user speech hypothesis (replaceable preview)
      if (interimText && (!rawInterim?.finished || !finalText)) {
        this.socket.emit("bi_voice_transcript_interim", {
          role: "user",
          text: interimText,
        });
      }

      // Final committed user speech segment
      if (finalText) {
        this.currentTurnUserText = (this.currentTurnUserText || "") + finalText;
        console.log(`[LiveVoice Transcription] User speech committed: "${finalText}"`);
        this.socket.emit("bi_voice_transcript_final", {
          role: "user",
          text: finalText,
        });
      } else if (rawInterim?.finished && interimText) {
        // Defensive fallback: if server marked interim as finished without separate inputTranscription
        this.currentTurnUserText = (this.currentTurnUserText || "") + interimText;
        console.log(`[LiveVoice Transcription] User speech committed from finished interim: "${interimText}"`);
        this.socket.emit("bi_voice_transcript_final", {
          role: "user",
          text: interimText,
        });
      }

      // Real-time text subtitle from outputTranscription (native channel for gemini-3.8-live)
      if (content.outputTranscription?.text) {
        if (this.currentTurnId) {
          this.telemetry.recordFirstProviderResponse(this.currentTurnId);
        }
        this.currentTurnAssistantText += (this.currentTurnAssistantText ? " " : "") + content.outputTranscription.text;
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
        this.forwardedChunksStartTime = null;
        this.isSpeakingEmitted = false;
        this.isTurnReserved = false;
        if (this.currentTurnUserText) {
          this.currentTurnUserText = this.currentTurnUserText.trim().replace(/\s+/g, " ");
        }
        // Voice Conversation is ephemeral real-time voice and does not pollute chat history
        if (this.sessionMode === "crm_assistant") {
          this.currentTurnUserText = "";
          this.currentTurnAssistantText = "";
          this.currentTurnToolsUsed = [];
        }

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

      // Watchdog: emit bi_voice_no_response when chunks forwarded for >= 8s without server response
      const now = Date.now();
      if (!this.forwardedChunksStartTime) {
        this.forwardedChunksStartTime = now;
      } else {
        const secondsWithoutResponse = (now - this.forwardedChunksStartTime) / 1000;
        if (secondsWithoutResponse >= 8) {
          if (!this.lastNoResponseEmittedAt || (now - this.lastNoResponseEmittedAt) >= 15000) {
            this.lastNoResponseEmittedAt = now;
            this.socket.emit("bi_voice_no_response", {
              secondsWithoutResponse: Math.round(secondsWithoutResponse),
            });
          }
        }
      }
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
    this.forwardedChunksStartTime = null;
    this.lastNoResponseEmittedAt = 0;
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
