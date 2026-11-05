import { createGeminiClient, GEMINI_MODELS } from "../../configs/gemini.js";

/**
 * Speaker-Aware Contact Extraction Service using Gemini Flash (gemini-3.5-flash).
 * Identifies the first speaker who genuinely introduces themselves and extracts only that speaker's details.
 */

/**
 * Builds the structured JSON prompt for Gemini Flash.
 */
function buildExtractionPrompt({
  formattedTranscript,
  hostName,
  hostOrg,
  hostPhone,
}) {
  return `You are a Senior AI Conversation Intelligence Specialist.
Analyze the following speaker-attributed conversation transcript between 2 to 3 people.
The conversation may be in English, Hindi, Telugu, or multilingual code-switching.

HOST SALES REPRESENTATIVE SHIELD (CRITICAL):
- The host sales representative holding this recording device is: "${hostName || 'Sales Representative'}" from organization: "${hostOrg || 'Our Team'}"${hostPhone ? ` (Phone: ${hostPhone})` : ''}.
- NEVER select the host sales representative as the contact.
- NEVER extract the host sales representative's name, company, or phone as the attendee contact details.

MANDATORY SPEAKER SELECTION & ISOLATION RULES:
1. FIRST SELF-INTRODUCTION DETECTION:
   - Chronologically identify the FIRST attendee speaker who explicitly introduces themselves.
   - Look for self-introductions in English ("My name is...", "I am...", "I'm..."), Hindi ("Mera naam...", "Main..."), Telugu ("Na peru...", "Nenu..."), or natural code-switching.
   - Note the speakerId of that first introducing speaker (e.g., "speaker_A" or "speaker_B").
   - This speaker becomes the "selectedSpeakerId".
   - If no one clearly introduces themselves, select the primary external attendee who discusses their business or shares their phone number.

2. ABSOLUTE SPEAKER SEPARATION (NEVER MIX SPEAKERS):
   - Extract Name, Company, Designation, and Phone ONLY from statements attributable to the selectedSpeakerId.
   - Statements made by other speakers (e.g. Speaker B or Speaker C) regarding their own company, designation, or phone MUST NEVER be attributed to the selected speaker!
   - Example rule: If Speaker A says "I'm Rahul from TCS", and Speaker B says "I work at Infosys as a Project Manager", Rahul's company is "TCS" and Rahul's designation is null (or whatever Rahul stated). "Infosys" and "Project Manager" belong strictly to Speaker B and must NEVER be placed on Speaker A.

3. PHONE NUMBER EXTRACTION:
   - Extract the phone number ONLY if spoken as digits or words in English, Hindi, or Telugu.
   - Convert spoken number words to continuous 10 digits (e.g. "9876543210").
   - If no phone number was spoken, return null for value. Never invent phone numbers.

4. FIELD EVIDENCE & CONFIDENCE:
   - For every extracted field (name, company, designation, phone), provide:
     * value: Extracted string value or null
     * evidence: The exact spoken quote from the transcript providing evidence
     * confidence: Number between 0.00 and 1.00 indicating certainty
   - If a field was not mentioned in the transcript, set value to null, evidence to null, and confidence to 0.0.

5. PARTICIPANTS SUMMARY:
   - Identify all distinct participants in the conversation, noting their speaker ID, name (if known), and company (if known).

TRANSCRIPT:
${formattedTranscript}

OUTPUT FORMAT:
Respond ONLY with a valid JSON object matching this exact structure:
{
  "selectedSpeakerId": "speaker_A",
  "selectionReason": "Speaker A was the first attendee to introduce themselves saying 'My name is Rahul'",
  "contact": {
    "name": {
      "value": "Rahul Sharma",
      "evidence": "My name is Rahul Sharma",
      "confidence": 0.98
    },
    "company": {
      "value": "Apex Technologies",
      "evidence": "I am from Apex Technologies",
      "confidence": 0.95
    },
    "designation": {
      "value": "Managing Director",
      "evidence": "I am the Managing Director",
      "confidence": 0.90
    },
    "phone": {
      "value": "9876543210",
      "evidence": "You can reach me at 9876543210",
      "confidence": 0.99
    }
  },
  "otherSpeakers": [
    {
      "speakerId": "speaker_B",
      "name": null,
      "company": "Infosys",
      "designation": "Project Manager"
    }
  ]
}
`;
}

/**
 * Extracts structured contact details with speaker attribution from transcript segments.
 * @param {Object} options
 * @param {Array<Object>} options.segments - Array of { speakerId, text, startTime, endTime }
 * @param {string} [options.rawTranscript=""] - Complete full accumulated transcript
 * @param {Object} [options.hostUser] - Host sales representative details
 * @param {Object} [options.organization] - Tenant organization
 * @returns {Promise<Object>} Structured contact extraction result
 */
export async function extractSpeakerAwareContact({
  segments = [],
  rawTranscript = "",
  hostUser = null,
  organization = null,
}) {
  let formattedTranscript = "";

  if (Array.isArray(segments) && segments.length > 0) {
    formattedTranscript = segments
      .map((s) => {
        const speakerTag = (s.speakerId || "speaker_A")
          .replace("speaker_", "Speaker ")
          .toUpperCase();
        const timeTag =
          typeof s.startTime === "number" ? ` [${s.startTime.toFixed(1)}s]` : "";
        return `${speakerTag}${timeTag}: ${s.text}`;
      })
      .join("\n");
  }

  if (rawTranscript && rawTranscript.trim().length > formattedTranscript.length) {
    formattedTranscript = rawTranscript.trim();
  }

  if (!formattedTranscript.trim()) {
    return {
      selectedSpeakerId: null,
      selectionReason: "No conversation transcript segments provided",
      contact: {
        name: { value: null, evidence: null, confidence: 0 },
        company: { value: null, evidence: null, confidence: 0 },
        designation: { value: null, evidence: null, confidence: 0 },
        phone: { value: null, evidence: null, confidence: 0 },
      },
      otherSpeakers: [],
    };
  }

  const hostName = hostUser?.name || "";
  const hostOrg = organization?.name || "";
  const hostPhone = (hostUser?.phone || "").replace(/\D/g, "").slice(-10);

  const prompt = buildExtractionPrompt({
    formattedTranscript,
    hostName,
    hostOrg,
    hostPhone,
  });

  const ai = createGeminiClient(organization);
  const modelName = GEMINI_MODELS.EXTRACTION_SUMMARY;

  const response = await ai.models.generateContent({
    model: modelName,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  });

  const rawText = response.text || "";
  try {
    const cleanJson = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = JSON.parse(cleanJson);

    // Sanitize phone digits
    if (parsed.contact?.phone?.value) {
      const cleanDigits = String(parsed.contact.phone.value).replace(/\D/g, "");
      if (cleanDigits.length >= 10) {
        parsed.contact.phone.value = cleanDigits.slice(-10);
      } else {
        parsed.contact.phone.value = null;
      }
    }

    return parsed;
  } catch (err) {
    console.error("[ContactExtraction] Failed to parse model response:", rawText, err);
    throw new Error("Invalid structured extraction response from Gemini Flash");
  }
}

export default {
  extractSpeakerAwareContact,
};
