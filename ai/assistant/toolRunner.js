import { truncatePayload } from "./securityUtils.js";

/**
 * Standardized error envelope for tool execution failure
 */
export const formatToolError = ({
  errorCode = "TOOL_ERROR",
  message = "An error occurred during tool execution.",
  retryable = false,
  hint = "",
}) => {
  return JSON.stringify({
    ok: false,
    error_code: errorCode,
    message,
    retryable,
    hint: hint || "Refine tool arguments or try an alternate query parameter.",
  });
};

/**
 * Executes a single tool call with timeout protection, argument validation, and structured error shaping.
 * Guarantees a safe string output under all circumstances (never throws uncaught into the loop).
 *
 * @param {Object} options
 * @param {Object} options.toolCall - { id, name, args } from LLM
 * @param {Object} options.toolsByName - Map of registered tools
 * @param {number} [options.timeoutMs=7000] - Hard execution timeout per tool
 * @param {number} [options.maxPayloadChars=3500] - Max output characters passed to context
 * @returns {Promise<{ output: string, durationMs: number, toolName: string, toolCallId: string, ok: boolean }>}
 */
export const executeToolCall = async ({
  toolCall,
  toolsByName = {},
  timeoutMs = 7000,
  maxPayloadChars = 3500,
}) => {
  const startTime = Date.now();
  const toolName = toolCall?.name;
  const toolCallId = toolCall?.id || `call_${Date.now()}`;
  const targetTool = toolsByName[toolName];

  // 1. Unknown / Hallucinated Tool
  if (!targetTool) {
    const validNames = Object.keys(toolsByName).join(", ");
    return {
      output: formatToolError({
        errorCode: "UNKNOWN_TOOL",
        message: `Tool '${toolName}' does not exist.`,
        retryable: false,
        hint: `Available tools are: ${validNames}. Select only from this list.`,
      }),
      durationMs: Date.now() - startTime,
      toolName,
      toolCallId,
      ok: false,
    };
  }

  // 2. Timeout and Safe Execution Wrapper
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Tool execution exceeded timeout of ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const execPromise = (async () => {
      // Safely invoke the tool
      const rawArgs = toolCall.args || {};
      const result = await targetTool.invoke(rawArgs);
      return typeof result === "string" ? result : JSON.stringify(result);
    })();

    const rawOutput = await Promise.race([execPromise, timeoutPromise]);
    clearTimeout(timeoutId);

    const safeOutput = truncatePayload(rawOutput, maxPayloadChars);
    return {
      output: safeOutput,
      durationMs: Date.now() - startTime,
      toolName,
      toolCallId,
      ok: true,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err.message && err.message.includes("exceeded timeout");
    const isValidation = err.name === "ZodError" || (err.message && err.message.includes("validation"));

    const errorCode = isTimeout
      ? "TIMEOUT_EXCEEDED"
      : isValidation
      ? "INVALID_ARGUMENTS"
      : "EXECUTION_FAILURE";

    const errorPayload = formatToolError({
      errorCode,
      message: err.message || "Unknown error during tool execution.",
      retryable: isTimeout,
      hint: isValidation
        ? "Check parameter types and required fields matching the schema."
        : isTimeout
        ? "Narrow down the search query or limit to avoid timeout."
        : "Verify requested data exists or check filter criteria.",
    });

    return {
      output: errorPayload,
      durationMs: Date.now() - startTime,
      toolName,
      toolCallId,
      ok: false,
    };
  }
};
