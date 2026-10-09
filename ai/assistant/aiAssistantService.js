import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import {
  SystemMessage,
  HumanMessage,
  AIMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { buildAssistantTools } from "./tools/index.js";
import { getISTDateBoundaries } from "./dateUtils.js";
import { decryptApiKey } from "../../utils/encryption.js";
import { recordAiUsage } from "../../services/aiUsageService.js";

/**
 * Executes the LangChain AI Assistant agent loop for Sales Managers
 */
export const runSalesManagerAssistant = async ({
  userMessage,
  history = [],
  tenantModels,
  organization,
  user,
}) => {
  const startTime = Date.now();

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

  const systemPrompt = `You are the executive AI CRM Assistant for "${orgName}", interacting with ${managerName} (Sales Manager).
You have real-time access to the live MongoDB database of the CRM via specialized tools.

=======================================================
REAL-WORLD SYSTEM TEMPORAL CONTEXT (India Standard Time - IST):
- Current Date: ${boundaries.todayStr} (${new Date().toLocaleDateString("en-IN", { weekday: "long", timeZone: "Asia/Kolkata" })})
- Current Time: ${new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" })} IST
- Today Window: ${boundaries.today.label}
- This Morning Window: 06:00 AM to 12:00 PM IST
- Yesterday: ${boundaries.yesterday.label}
- Current Month: ${boundaries.thisMonth.label}
=======================================================

STRICT OPERATIONAL RULES:
1. ZERO HALLUCINATION INVARIANT:
   - Every single metric, count, percentage, lead detail, or team performance figure MUST come directly from a tool execution response.
   - NEVER invent numbers, assume record counts, or answer data questions without calling the appropriate tool.
   - If a tool returns 0 or no matching records, state clearly and factually that there are 0 records matching the query.
2. TOOL SELECTION:
   - For lead numbers, morning leads, today vs yesterday, or conversion rate: CALL 'get_dashboard_kpis'.
   - For searching contacts, leads by service/source/status: CALL 'search_leads'.
   - For checking if a phone number exists in the CRM: CALL 'lookup_phone_number'.
   - For sales rep rankings, talk time, or lead generation by salesperson: CALL 'get_salesperson_performance'.
   - For pending, overdue, or scheduled follow-ups and tasks: CALL 'get_followup_status'.
   - For unread customer messages or leads waiting for a WhatsApp reply: CALL 'get_whatsapp_analytics'.
   - For integrations (WhatsApp Cloud, Baileys, AI, seats, subscription): CALL 'get_org_integrations_and_config'.
   - For feature guides or how-to documentation: CALL 'search_crm_documentation_and_features'.
3. FORMATTING:
   - Present answers with crisp formatting: use bold text for key figures, bullet points for lists, and concise summaries.
   - Mention the specific time window evaluated (e.g., "This morning between 6:00 AM and 12:00 PM IST").
   - Maintain a professional, executive tone tailored to a Sales Manager.`;

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

  // 6. Tool-Calling Agent Loop
  const MAX_ITERATIONS = 5;
  const toolsUsedSet = new Set();
  const iterationLogs = [];
  let finalReply = "";
  let hitIterationCap = false;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const iterStart = Date.now();
    let aiResponse;
    try {
      aiResponse = await modelWithTools.invoke(messages);
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
        aiResponse = await fallbackWithTools.invoke(messages);
      } else {
        throw invokeErr;
      }
    }

    messages.push(aiResponse);

    // If no tool calls requested, we have the final textual answer!
    if (!aiResponse.tool_calls || aiResponse.tool_calls.length === 0) {
      finalReply = typeof aiResponse.content === "string" ? aiResponse.content : JSON.stringify(aiResponse.content);
      iterationLogs.push({
        iteration: iter + 1,
        type: "response",
        durationMs: Date.now() - iterStart,
      });
      break;
    }

    // Execute tool calls sequentially
    const toolExecLogs = [];
    for (const toolCall of aiResponse.tool_calls) {
      const toolStart = Date.now();
      const toolName = toolCall.name;
      toolsUsedSet.add(toolName);
      const targetTool = toolsByName[toolName];

      let toolOutput = "";
      if (targetTool) {
        try {
          const res = await targetTool.invoke(toolCall.args);
          toolOutput = typeof res === "string" ? res : JSON.stringify(res);
        } catch (err) {
          toolOutput = JSON.stringify({ error: `Tool execution failed: ${err.message}` });
        }
      } else {
        toolOutput = JSON.stringify({ error: `Unknown tool: ${toolName}` });
      }

      const toolDuration = Date.now() - toolStart;
      const truncatedOutput =
        toolOutput.length > 2048 ? `${toolOutput.slice(0, 2048)}... [TRUNCATED ${toolOutput.length - 2048} chars]` : toolOutput;

      toolExecLogs.push({
        tool: toolName,
        args: toolCall.args,
        resultPreview: truncatedOutput,
        durationMs: toolDuration,
      });

      messages.push(
        new ToolMessage({
          tool_call_id: toolCall.id,
          name: toolName,
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

  // Structured run summary logging
  console.log(
    `[AI Assistant Diagnostics]\n` +
      JSON.stringify(
        {
          userQuery: userMessage,
          modelUsed,
          iterationsRun: iterationLogs.length,
          hitIterationCap,
          toolsInvoked: Array.from(toolsUsedSet),
          executionTimeMs: Date.now() - startTime,
          iterationTrace: iterationLogs,
        },
        null,
        2
      )
  );

  // Fallback if loop ended without final textual message
  if (!finalReply) {
    const lastMsg = messages[messages.length - 1];
    finalReply = lastMsg?.content || "I have analyzed your request based on the latest CRM data.";
  }

  // 7. Track AI Usage for Organization Quota
  try {
    if (organization?._id) {
      await recordAiUsage(organization._id, "chat");
    }
  } catch (usageErr) {
    console.warn("[AI Assistant] Failed to record AI usage:", usageErr.message);
  }

  const executionTimeMs = Date.now() - startTime;

  return {
    reply: finalReply,
    toolsUsed: Array.from(toolsUsedSet),
    modelUsed,
    executionTimeMs,
  };
};
