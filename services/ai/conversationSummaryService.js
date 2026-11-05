import { createGeminiClient, GEMINI_MODELS } from "../../configs/gemini.js";

/**
 * Conversation Summary Service using Gemini Flash (gemini-3.5-flash).
 * Generates factual, structured conversation summaries covering key discussions,
 * commitments, action items, and participant details without hallucinations.
 */

/**
 * Generates a structured summary from transcript segments.
 * @param {Object} options
 * @param {Array<Object>} options.segments - Array of { speakerId, text }
 * @param {Object} [options.contact] - Extracted contact details if available
 * @param {Object} [options.organization] - Tenant organization
 * @param {boolean} [options.isInterim=false] - Whether this is an interim periodic summary
 * @returns {Promise<Object>}
 */
export async function generateConversationSummary({
  segments = [],
  contact = null,
  organization = null,
  isInterim = false,
}) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return {
      keyDiscussion: "No conversation content available to summarize.",
      topics: [],
      actionItems: [],
      decisions: [],
      participants: [],
    };
  }

  const formattedTranscript = segments
    .map((s) => `${(s.speakerId || "Speaker").toUpperCase()}: ${s.text}`)
    .join("\n");

  const prompt = `You are a Senior Business Conversation Analyst.
Analyze the following conversation transcript.
${isInterim ? "Provide a concise interim summary of the discussion in progress." : "Provide a comprehensive, factual final summary of the face-to-face conversation."}

CRITICAL RULES:
1. Do NOT invent, assume, or hallucinate discussions or commitments not present in the transcript.
2. Clearly distinguish participants and attribute actions accurately.
3. Highlight customer requirements, proposed solutions, decisions reached, and next steps.

TRANSCRIPT:
${formattedTranscript}

OUTPUT FORMAT:
Respond ONLY with a valid JSON object matching this schema:
{
  "keyDiscussion": "A concise 2-3 sentence overview of the conversation context and outcomes.",
  "topics": ["Key topic or service 1", "Key topic or requirement 2"],
  "decisions": ["Any explicit agreement or decision made"],
  "actionItems": ["Explicit follow-up task or commitment with responsible person if stated"],
  "participants": [
    { "speakerId": "speaker_A", "roleOrName": "Name or Role if mentioned", "context": "Brief note on their contribution" }
  ]
}
`;

  const ai = createGeminiClient(organization);
  const modelName = GEMINI_MODELS.EXTRACTION_SUMMARY;

  const response = await ai.models.generateContent({
    model: modelName,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      temperature: 0.2,
    },
  });

  const rawText = response.text || "";
  try {
    const cleanJson = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    return JSON.parse(cleanJson);
  } catch (err) {
    console.warn("[ConversationSummary] Fallback parsing summary:", rawText);
    return {
      keyDiscussion: rawText.slice(0, 200),
      topics: [],
      actionItems: [],
      decisions: [],
      participants: [],
    };
  }
}

export default {
  generateConversationSummary,
};

