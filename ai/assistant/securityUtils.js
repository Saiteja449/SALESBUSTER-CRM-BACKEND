/**
 * Security and Data Sanitization Utilities for AI CRM Assistant
 */

/**
 * Escapes characters that have special meaning in regular expressions
 * to prevent ReDoS (Regular Expression Denial of Service) and unintended regex wildcards.
 *
 * @param {string} str - Raw user search input
 * @returns {string} - Escaped string safe for RegExp and MongoDB $regex
 */
export const escapeRegex = (str) => {
  if (typeof str !== "string") return "";
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

/**
 * Encapsulates untrusted customer-generated or external text (lead notes, WhatsApp message previews)
 * inside structured delimiters to protect against indirect prompt injection.
 *
 * @param {string} text - Raw untrusted content
 * @returns {string} - Tagged, sanitized text
 */
export const wrapUntrustedData = (text) => {
  if (!text) return "";
  const cleaned = String(text)
    .replace(/<\/untrusted_content>/gi, "")
    .slice(0, 1000);
  return `<untrusted_content>${cleaned}</untrusted_content>`;
};

/**
 * Enforces a strict character length cap on tool output string payloads
 * to protect the LLM context window from overflowing.
 * Preserves valid JSON structure when possible by truncating records array.
 *
 * @param {string} payload - Serialized tool output JSON string
 * @param {number} [maxChars=12000] - Maximum allowed characters
 * @returns {string} - Truncated payload with pagination/continuation hint if truncated
 */
export const truncatePayload = (payload, maxChars = 12000) => {
  if (typeof payload !== "string") {
    payload = JSON.stringify(payload || "");
  }
  if (payload.length <= maxChars) {
    return payload;
  }
  const excess = payload.length - maxChars;

  // If payload is a JSON object, safely trim records array to maintain valid JSON
  try {
    const obj = JSON.parse(payload);
    if (obj && typeof obj === "object") {
      const arrayKey = ["records", "leads", "calls", "items", "data", "followups", "messages", "conversations"].find(
        (k) => Array.isArray(obj[k]) && obj[k].length > 1
      );
      if (arrayKey && obj[arrayKey].length > 1) {
        while (obj[arrayKey].length > 1 && JSON.stringify(obj).length > maxChars) {
          obj[arrayKey].pop();
        }
        obj.isTruncated = true;
        obj.hasMore = true;
        obj.coverage = "partial";
        obj.dataCoverage = "partial";
        if (typeof obj.totalCount === "number" && obj.totalCount > 0) {
          obj.totalMatchingCount = obj.totalCount;
        }
        obj.returnedCount = obj[arrayKey].length;
        obj.showingCount = obj[arrayKey].length;
        obj.truncationNotice = `[TRUNCATED ${excess} CHARS: Showing first ${obj[arrayKey].length} records to protect context window. Request next page to view remaining records.]`;
        return JSON.stringify(obj);
      }

      // If no array or array length 1, truncate string fields within the JSON object to preserve valid JSON
      for (const key of Object.keys(obj)) {
        if (typeof obj[key] === "string" && obj[key].length > 200) {
          obj[key] = obj[key].slice(0, 200) + "... [truncated]";
        }
      }
      obj.isTruncated = true;
      obj.coverage = "partial";
      obj.dataCoverage = "partial";
      obj.truncationNotice = `[TRUNCATED ${excess} CHARS: Content truncated to protect context window.]`;
      return JSON.stringify(obj);
    }
  } catch (_) {}

  // Fallback for plain text or non-array JSON
  return `${payload.slice(0, maxChars)}... [TRUNCATED ${excess} CHARS: Request more specific filters or lower limit to see remaining records]`;
};

/**
 * Creates a deterministic hash/fingerprint of a tool call name and args
 * to detect stuck repetition loops.
 *
 * @param {string} toolName
 * @param {Object} args
 * @returns {string}
 */
export const fingerprintToolCall = (toolName, args = {}) => {
  try {
    const keys = Object.keys(args || {}).sort();
    const sortedObj = {};
    for (const k of keys) {
      sortedObj[k] = args[k];
    }
    return `${toolName}:${JSON.stringify(sortedObj)}`;
  } catch {
    return `${toolName}:${String(args)}`;
  }
};
