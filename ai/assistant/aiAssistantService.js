import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import {
  SystemMessage,
  HumanMessage,
  AIMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { buildAssistantTools } from "./tools/index.js";
import { getISTDateBoundaries } from "./dateUtils.js";
import { executeToolCall } from "./toolRunner.js";
import { fingerprintToolCall } from "./securityUtils.js";
import { decryptApiKey } from "../../utils/encryption.js";
import { recordAiUsage } from "../../services/aiUsageService.js";

/**
 * Safely extracts plain text from LLM response content:
 * Handles strings, arrays of text blocks ([{ type: "text", text: "..." }]),
 * objects, and stringified JSON arrays.
 */
export const extractTextFromAiContent = (content) => {
  if (!content) return "";
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  if (typeof content === "object" && content !== null && typeof content.text === "string") {
    return content.text;
  }
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (
          Array.isArray(parsed) &&
          parsed.some(
            (p) => p && typeof p === "object" && (p.text !== undefined || p.type === "text")
          )
        ) {
          return parsed
            .map((p) => {
              if (typeof p === "string") return p;
              if (p && typeof p.text === "string") return p.text;
              return "";
            })
            .join("");
        }
      } catch (_) {}
    }
    return content;
  }
  return String(content);
};

/**
 * Extracts structured options from assistant text if embedded via syntax markers
 */
const parseOptionsFromText = (text) => {
  const clean = extractTextFromAiContent(text);
  if (!clean || typeof clean !== "string") return { cleanText: clean || "", options: [] };
  text = clean;

  // Pattern 1: <<<OPTIONS: [...]>>>
  const regex1 = /<<<OPTIONS:\s*(\[.*?\])\s*>>>/is;
  const match1 = text.match(regex1);
  if (match1) {
    try {
      const parsed = JSON.parse(match1[1]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return {
          cleanText: text.replace(regex1, "").trim(),
          options: parsed.map(String).map((s) => s.trim()).filter(Boolean),
        };
      }
    } catch (_) {}
  }

  // Pattern 2: ```options [...] ```
  const regex2 = /```options\s*(\[.*?\])\s*```/is;
  const match2 = text.match(regex2);
  if (match2) {
    try {
      const parsed = JSON.parse(match2[1]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return {
          cleanText: text.replace(regex2, "").trim(),
          options: parsed.map(String).map((s) => s.trim()).filter(Boolean),
        };
      }
    } catch (_) {}
  }

  return { cleanText: text, options: [] };
};

/**
 * Executes the LangChain AI Assistant agent loop for Sales Managers
 * Hardened with wall-clock caps, parallel tool calling, loop detection, and safe fallbacks.
 */
export const runSalesManagerAssistant = async ({
  userMessage,
  history = [],
  tenantModels,
  organization,
  user,
}) => {
  const startTime = Date.now();
  const WALL_CLOCK_LIMIT_MS = 45000; // 45-second total turn budget for multi-tool CRM queries

  // 1. Resolve Gemini API Key
  const geminiApiKey =
    decryptApiKey(organization?.aiSettings?.geminiApiKey) || process.env.GEMINI_API_KEY;

  if (!geminiApiKey) {
    throw new Error(
      "Google Gemini API Key is not configured for your organization or server. Please configure it in Organization Settings."
    );
  }

  // 2. Initialize Gemini Model with configurable primary and fallback capability
  const PRIMARY_MODEL = process.env.AI_ASSISTANT_MODEL || "gemini-3.5-flash-lite";
  const FALLBACK_MODEL = "gemini-2.5-flash";

  let modelUsed = PRIMARY_MODEL;
  let model = new ChatGoogleGenerativeAI({
    model: PRIMARY_MODEL,
    temperature: 0.1, // Low temperature for maximum factual reliability
    maxOutputTokens: 2048,
    apiKey: geminiApiKey,
  });

  // 3. Build Authenticated Modular Tools
  const { tools, toolsByName } = buildAssistantTools({
    tenantModels,
    organization,
    user,
  });

  const modelWithTools = model.bindTools(tools);

  // 4. Construct System Prompt with Real-World IST Temporal Grounding
  const boundaries = getISTDateBoundaries();
  const orgName = organization?.name || "Our Organization";
  const managerName = user?.name || "Sales Manager";

  const systemPrompt = `You are the executive AI CRM Data Intelligence Analyst for "${orgName}", interacting with ${managerName} (Sales Manager).
You have real-time access to the live MongoDB database of the CRM via specialized analytics tools.

=======================================================
REAL-WORLD SYSTEM TEMPORAL CONTEXT (India Standard Time - IST):
- Current Date: ${boundaries.todayStr} (${new Date().toLocaleDateString("en-IN", { weekday: "long", timeZone: "Asia/Kolkata" })})
- Current Time: ${new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" })} IST
- Today Window: ${boundaries.today.label}
- This Morning Window: 06:00 AM to 12:00 PM IST
- Yesterday: ${boundaries.yesterday.label}
- Current Month: ${boundaries.thisMonth.label}
=======================================================

CORE CRM INTELLIGENCE TOOLS & USAGE:
1. 'get_crm_overview': Returns complete 360-degree CRM summary (total leads, new/active/converted/lost, calls incoming/outgoing/connected/missed, follow-ups pending/overdue, WhatsApp unread, recordings). Use for high-level summaries and health checks.
2. 'get_missed_call_analytics': PRIMARY TOOL for ALL missed call inquiries.
   - Overall missed calls
   - Salesperson-wise missed calls (e.g. "How many missed calls did Shanmukh receive?")
   - Date-wise missed calls (today, this month, custom dates)
   - Customer-wise missed calls / phone number lookups
   - Missed calls without follow-up vs with overdue follow-ups vs successfully followed up
   - Missed calls from unknown/unassigned salespeople
   - Returns both verified summary counts and paginated record details.
3. 'search_call_records': Queries individual call logs and events.
   - Filters: salesperson name/ID, customer phone/name, callType (incoming/outgoing/missed), callStatus (connected/missed/rejected), date range, recording availability, source.
   - Use for specific call timelines, customer call activity, or calls between specific dates.
4. 'get_salesperson_analytics': Comprehensive rep and team performance.
   - Total calls, incoming, outgoing, connected, missed, talk time
   - Total leads, new, converted, lost, conversion rate, deal value
   - Pending, overdue, completed follow-ups
   - Supports active, inactive, and historical representatives.
   - Use for rep leaderboard, comparing salespeople (e.g. Shanmukh vs Jhansi), or rep activity.
5. 'search_leads_advanced': Multi-filter lead search.
   - Filters: assigned salesperson (including unassigned), creation date range, last activity date, status, source, service, priority, call status (has_calls, missed_calls, never_called), follow-up status (overdue, pending_today, no_followup), inactive days (e.g. not contacted for 7 days).
6. 'get_followup_analytics': In-depth follow-up and task reports.
   - Pending, overdue, today, upcoming, completed follow-ups, priority breakdown, rep-wise follow-up load, missed-call follow-ups.
7. 'get_conversion_analytics': Win rates, conversions by salesperson, by source, by service, lost-lead reasons, and comparing high-call vs low-conversion reps.
8. 'get_recording_analytics': Call audio recordings, transcriptions, analysis status, missing recordings for connected calls.
9. 'get_whatsapp_analytics': Messages sent/received, response rate, leads awaiting reply, unread customer messages.
10. 'lookup_phone_number': Quick check if a phone number exists across leads and calls.
11. 'get_org_integrations_and_config': Organization subscription, AI keys, WhatsApp connections.
12. 'search_crm_documentation_and_features': Knowledge base and user guides.

QUERY PLANNING & EXECUTION INVARIANTS:
1. ZERO HALLUCINATION INVARIANT:
   - Every metric, count, lead detail, or team performance figure MUST come directly from tool outputs.
   - NEVER invent numbers, guess record counts, or assume historical values.
   - If a tool returns 0 records, state clearly and factually that there are 0 records.
2. AMBIGUOUS SALESPERSON RESOLUTION:
   - If a tool reports that multiple salespeople matched a name (e.g. multiple people named "Shanmukh" or "John"), DO NOT guess silently. Surface the candidate names and ask the user to clarify.
3. MULTI-FILTER & MULTI-TOOL QUESTIONS:
   - For complex questions combining multiple aspects (e.g. "missed-call leads assigned to Jhansi with overdue follow-ups", or "which salesperson has highest missed calls but lowest conversions?"):
   - Formulate a clear plan, invoke the required tools, correlate the data, and provide a complete, verified answer.
4. INDIVIDUAL RECORD DETAILS:
   - When the user asks for record details, list the key fields: Customer Name, Phone Number, Salesperson, Call Date/Time, Call Status, Lead Status, and Follow-up Status.
5. RESPONSE STRUCTURE & CLARITY:
   - Use clear markdown hierarchy: Title with time period and rep name, Key Metrics summary, Comparison table if comparing reps, and Sample/Paginated Records.
   - If records exceed page limit, state the total count and note that further pages can be requested.`;

  // 5. Build Message Stack with Conversation History
  const messages = [new SystemMessage(systemPrompt)];

  // Add recent past turns (up to last 10 messages for context)
  if (Array.isArray(history) && history.length > 0) {
    const recentHistory = history.slice(-10);
    for (const h of recentHistory) {
      if (h.role === "user" && h.content) {
        messages.push(new HumanMessage(h.content));
      } else if (h.role === "assistant" && h.content) {
        messages.push(new AIMessage(h.content));
      }
    }
  }

  messages.push(new HumanMessage(userMessage));

  // 6. Hardened Tool-Calling Agent Loop
  const MAX_ITERATIONS = 8;
  const toolsUsedSet = new Set();
  const iterationLogs = [];
  const previousFingerprints = [];
  let finalReply = "";
  let extractedOptions = [];
  let hitIterationCap = false;
  let hitWallClockCap = false;

  // Helper for resilient LLM call with single-attempt retry on transient network errors
  const invokeWithTransientRetry = async (activeModel, msgStack) => {
    try {
      return await activeModel.invoke(msgStack);
    } catch (primaryErr) {
      const isTransient =
        primaryErr.status === 429 ||
        primaryErr.status === 503 ||
        (primaryErr.message && /network|timeout|econnreset|fetch failed/i.test(primaryErr.message));

      if (isTransient) {
        console.warn("[AI Assistant] Transient error encountered, retrying once after 400ms...");
        await new Promise((r) => setTimeout(r, 400));
        return await activeModel.invoke(msgStack);
      }
      throw primaryErr;
    }
  };

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    // Check wall clock budget before starting iteration
    if (Date.now() - startTime >= WALL_CLOCK_LIMIT_MS) {
      console.warn(`[AI Assistant] Wall-clock budget exceeded (${WALL_CLOCK_LIMIT_MS}ms). Breaking out.`);
      hitWallClockCap = true;
      break;
    }

    const iterStart = Date.now();
    let aiResponse;

    try {
      aiResponse = await invokeWithTransientRetry(modelWithTools, messages);
    } catch (invokeErr) {
      // Automatic fallback if primary model fails
      if (invokeErr.message && invokeErr.message.includes(PRIMARY_MODEL)) {
        console.warn(`[AI Assistant] Model ${PRIMARY_MODEL} failed, falling back to ${FALLBACK_MODEL}:`, invokeErr.message);
        modelUsed = FALLBACK_MODEL;
        const fallbackModel = new ChatGoogleGenerativeAI({
          model: FALLBACK_MODEL,
          temperature: 0.1,
          maxOutputTokens: 2048,
          apiKey: geminiApiKey,
        });
        const fallbackWithTools = fallbackModel.bindTools(tools);
        aiResponse = await invokeWithTransientRetry(fallbackWithTools, messages);
      } else {
        throw invokeErr;
      }
    }

    messages.push(aiResponse);

    // Check if the model called ask_clarification
    const clarificationCall = aiResponse.tool_calls?.find((tc) => tc.name === "ask_clarification");
    if (clarificationCall) {
      finalReply = clarificationCall.args?.question || "Could you please clarify your request?";
      if (Array.isArray(clarificationCall.args?.options)) {
        extractedOptions = clarificationCall.args.options.map(String).map((s) => s.trim()).filter(Boolean);
      }
      toolsUsedSet.add("ask_clarification");
      iterationLogs.push({
        iteration: iter + 1,
        type: "clarification",
        question: finalReply,
        options: extractedOptions,
        durationMs: Date.now() - iterStart,
      });
      break;
    }

    // If no tool calls requested, we have the final textual answer!
    if (!aiResponse.tool_calls || aiResponse.tool_calls.length === 0) {
      const rawText = extractTextFromAiContent(aiResponse.content);
      const parsed = parseOptionsFromText(rawText);
      finalReply = parsed.cleanText;
      if (extractedOptions.length === 0 && parsed.options.length > 0) {
        extractedOptions = parsed.options;
      }
      iterationLogs.push({
        iteration: iter + 1,
        type: "response",
        durationMs: Date.now() - iterStart,
      });
      break;
    }

    // Loop & repetition detection: check if identical tool calls were just executed
    const currentFingerprints = aiResponse.tool_calls.map((tc) => fingerprintToolCall(tc.name, tc.args));
    const isRepeated =
      previousFingerprints.length > 0 &&
      currentFingerprints.length === previousFingerprints.length &&
      currentFingerprints.every((fp, idx) => fp === previousFingerprints[idx]);

    if (isRepeated) {
      console.warn("[AI Assistant] Loop repeat detected: model repeated identical tool calls. Breaking out.");
      hitIterationCap = true;
      break;
    }
    previousFingerprints.splice(0, previousFingerprints.length, ...currentFingerprints);

    // Track tools used
    for (const tc of aiResponse.tool_calls) {
      toolsUsedSet.add(tc.name);
    }

    // Execute tool calls concurrently in parallel (Promise.allSettled)
    const toolExecPromises = aiResponse.tool_calls.map((toolCall) =>
      executeToolCall({
        toolCall,
        toolsByName,
        timeoutMs: toolsByName[toolCall.name]?.metadata?.timeoutMs || 6500,
        maxPayloadChars: 12000,
      })
    );

    const toolResults = await Promise.allSettled(toolExecPromises);

    const toolExecLogs = [];
    // Ensure every single tool_call_id gets exactly one matching ToolMessage in order
    for (let i = 0; i < aiResponse.tool_calls.length; i++) {
      const toolCall = aiResponse.tool_calls[i];
      const settled = toolResults[i];

      let toolOutput = "";
      let durationMs = 0;

      if (settled.status === "fulfilled") {
        toolOutput = settled.value.output;
        durationMs = settled.value.durationMs;
        try {
          const parsedToolData = JSON.parse(toolOutput);
          if (parsedToolData?.error_code === "AMBIGUOUS_SALESPERSON" && Array.isArray(parsedToolData.matches)) {
            extractedOptions = parsedToolData.matches.map((m) => m.name || m.email).filter(Boolean);
          }
        } catch (_) {}
      } else {
        toolOutput = JSON.stringify({
          ok: false,
          error_code: "TOOL_EXECUTION_CRASH",
          message: settled.reason?.message || "Tool execution promise rejected.",
          retryable: false,
        });
      }

      toolExecLogs.push({
        tool: toolCall.name,
        args: toolCall.args,
        resultPreview: toolOutput.slice(0, 300),
        durationMs,
      });

      messages.push(
        new ToolMessage({
          tool_call_id: toolCall.id,
          name: toolCall.name,
          content: toolOutput,
        })
      );
    }

    iterationLogs.push({
      iteration: iter + 1,
      type: "tool_calls",
      toolExecutions: toolExecLogs,
      durationMs: Date.now() - iterStart,
    });

    if (iter === MAX_ITERATIONS - 1 && !finalReply) {
      hitIterationCap = true;
    }
  }

  // 7. Safe Final Answer Synthesis (Never dump raw ToolMessage JSON to users)
  if (!finalReply) {
    try {
      console.log("[AI Assistant] Synthesizing final answer from tool outputs...");
      // Invoke bare model with no tools to synthesize findings
      const directModel = new ChatGoogleGenerativeAI({
        model: modelUsed,
        temperature: 0.1,
        maxOutputTokens: 1500,
        apiKey: geminiApiKey,
      });

      const synthesisPrompt = [
        ...messages,
        new HumanMessage(
          "Please summarize the factual results from the tool outputs above into a clear, direct answer for the sales manager. Do not call any tools."
        ),
      ];

      const synthesisRes = await directModel.invoke(synthesisPrompt);
      if (synthesisRes && synthesisRes.content) {
        const rawText = extractTextFromAiContent(synthesisRes.content);
        const parsed = parseOptionsFromText(rawText);
        finalReply = parsed.cleanText;
        if (extractedOptions.length === 0 && parsed.options.length > 0) {
          extractedOptions = parsed.options;
        }
      }
    } catch (synthErr) {
      console.warn("[AI Assistant] Final answer synthesis failed:", synthErr.message);
      finalReply = "I have queried the CRM data. Please review the dashboard or ask a more specific question.";
    }
  }

  // 8. Track Diagnostics & AI Usage
  console.log(
    `[AI Assistant Diagnostics]\n` +
      JSON.stringify(
        {
          userQuery: userMessage,
          modelUsed,
          iterationsRun: iterationLogs.length,
          hitIterationCap: hitIterationCap || hitWallClockCap,
          toolsInvoked: Array.from(toolsUsedSet),
          executionTimeMs: Date.now() - startTime,
          iterationTrace: iterationLogs,
        },
        null,
        2
      )
  );

  // Quota was already reserved atomically prior to calling runSalesManagerAssistant

  const executionTimeMs = Date.now() - startTime;

  return {
    reply: finalReply,
    options: extractedOptions,
    toolsUsed: Array.from(toolsUsedSet),
    modelUsed,
    executionTimeMs,
  };
};
