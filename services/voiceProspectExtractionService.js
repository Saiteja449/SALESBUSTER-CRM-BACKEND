import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

dotenv.config();

const resolveAudioMimeType = (filePath, fallbackMime) => {
  if (fallbackMime && fallbackMime !== "application/octet-stream") {
    if (fallbackMime === "audio/mp3") return "audio/mpeg";
    return fallbackMime;
  }
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".m4a":
      return "audio/mp4";
    case ".aac":
      return "audio/aac";
    case ".ogg":
      return "audio/ogg";
    case ".flac":
      return "audio/flac";
    case ".3gp":
      return "audio/3gpp";
    case ".webm":
      return "audio/webm";
    default:
      return "audio/mp4";
  }
};

/**
 * Extracts potential customer details (Name, Company, Context) from a live recorded conversation
 * using Google Gemini Multimodal Audio API.
 * 
 * @param {string} filePath - Path to the local recorded audio file
 * @param {string} mimeType - Optional MIME type
 * @param {string} customApiKey - Optional organization-specific Gemini API Key
 * @returns {Promise<{ customerName: string, companyName: string, designation: string, spokenPhone: string|null, keyTopic: string }>}
 */
export const extractProspectDetailsFromVoice = async (
  filePath,
  mimeType,
  customApiKey = null,
  requestId = "untracked"
) => {
  const activeKey = customApiKey || process.env.GEMINI_API_KEY;

  if (!fs.existsSync(filePath)) {
    throw new Error(`Audio recording file not found at: ${filePath}`);
  }

  if (!activeKey) {
    throw new Error("Gemini AI API key is not configured for voice prospect extraction.");
  }

  const genAI = new GoogleGenerativeAI(activeKey);
  const fileManager = new GoogleAIFileManager(activeKey);
  const resolvedMime = resolveAudioMimeType(filePath, mimeType);
  const modelName = "gemini-3.5-flash-lite";
  const uploadStartedAt = Date.now();
  console.info(`[VoiceExtraction][${requestId}] Uploading audio to Gemini`, { mimeType: resolvedMime });

  let uploadResponse = null;

  try {
    uploadResponse = await fileManager.uploadFile(filePath, {
      mimeType: resolvedMime,
      displayName: `Live Voice Record - ${path.basename(filePath)}`,
    });

    console.info(`[VoiceExtraction][${requestId}] Gemini upload complete`, {
      state: uploadResponse.file.state,
      durationMs: Date.now() - uploadStartedAt,
    });

    // Brief settling wait
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const generationStartedAt = Date.now();
    console.info(`[VoiceExtraction][${requestId}] Generating structured fields`, { model: modelName });

    const prompt = `
You are the SalesBuster AI conversation intelligence engine.
Analyze the attached live recorded voice conversation between a Sales Manager and a prospective customer.
The conversation may be in English, Hindi, Telugu, or natural multilingual mixing (code-switching).
CRITICAL: The sales manager does NOT enter any data manually. All prospect details including the customer's phone number MUST be extracted directly from this audio recording.

TASK:
Identify and extract:
1. customerName: The customer's spoken name or greeting (e.g. "Rahul", "Suresh Sharma", "Dr. Mehta", "Ramesh"). If no clear person name was spoken, return null.
2. companyName: The business, shop, firm, or company name associated with the customer (e.g. "Apex Technologies", "Balaji Textiles", "Kiran Hospital"). If none was mentioned, return null.
3. designation: The customer's spoken job title, role, or designation (e.g. "Managing Director", "Founder", "CEO", "Owner", "Procurement Manager", "Operations Head", "Partner", "Doctor", "Purchase In-charge", "Manager"). If not mentioned, return null.
4. spokenPhone: The customer's 10-digit mobile or WhatsApp number verbally spoken, dictated, or exchanged anywhere in the conversation.
   - May be spoken as digits or words in English, Hindi, or Telugu (e.g. "nine eight seven six five four three two one zero", "double nine, eight seven six...", "mera number 9876543210", "na number note cheyandi 9876543210").
   - Convert spoken number words into a continuous numeric digit string (e.g. "9876543210").
   - If country code (+91 or 91) is mentioned, include it or return the 10 digits.
   - If no valid phone number was spoken, return null.
5. keyTopic: A useful discussion summary containing important information OTHER THAN the extracted name, company, designation, or phone. Capture the prospect's needs, requirements, interests, pain points, product details, budget or timing if mentioned, decisions, and agreed follow-up or next steps. Write 1-3 concise sentences grounded only in the recording. Do not repeat the identity fields. Return an empty string if the conversation contains no useful extra details.

CRITICAL FORMAT REQUIREMENT:
Respond ONLY with a valid, raw JSON object and nothing else. Do NOT include markdown code blocks, backticks, or explanatory text.
Example format:
{
  "customerName": "Rahul Sharma",
  "companyName": "Apex Technologies",
  "spokenPhone": "9876543210",
  "keyTopic": "The prospect needs CRM automation for a five-person sales team. They asked for a product demo next week and will confirm their budget after reviewing the proposal."
}
`;

    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent([
      prompt,
      {
        fileData: {
          fileUri: uploadResponse.file.uri,
          mimeType: uploadResponse.file.mimeType,
        },
      },
    ]);

    const responseText = result.response.text().trim();
    console.info(`[VoiceExtraction][${requestId}] Gemini response received`, {
      durationMs: Date.now() - generationStartedAt,
      responseLength: responseText.length,
    });

    // Clean JSON markdown formatting if present
    const cleanJson = responseText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleanJson);
    } catch (jsonErr) {
      console.warn(`[VoiceExtraction][${requestId}] Gemini response was not valid JSON`);
      throw new Error("Unable to parse structured prospect details from Gemini voice response.");
    }

    const customerName = parsed.customerName && parsed.customerName !== "null" && parsed.customerName !== "Valued Customer"
      ? parsed.customerName.trim()
      : null;
    const companyName = parsed.companyName && parsed.companyName !== "null" && parsed.companyName !== "your business" && parsed.companyName !== "your enterprise"
      ? parsed.companyName.trim()
      : null;

    const designation = parsed.designation && parsed.designation !== "null"
      ? parsed.designation.trim()
      : "";

    if (!customerName && !companyName) {
      throw new Error("Could not identify customer name or company in the audio recording. Please ensure clear speech and record again.");
    }

    // Sanitize spoken phone
    let cleanSpokenPhone = null;
    if (parsed.spokenPhone && parsed.spokenPhone !== "null") {
      const rawDigits = String(parsed.spokenPhone).replace(/\D/g, "");
      if (rawDigits.length >= 10) {
        cleanSpokenPhone = rawDigits.slice(-10);
      }
    }

    return {
      customerName: customerName || "Valued Customer",
      companyName: companyName || "",
      designation: designation || "",
      spokenPhone: cleanSpokenPhone,
      keyTopic: (parsed.keyTopic || "").trim(),
    };
  } catch (err) {
    console.error(`[VoiceExtraction][${requestId}] Gemini audio analysis failed`, { error: err.message });
    throw err;
  } finally {
    // Delete file from Gemini File API to prevent storage buildup
    if (uploadResponse?.file?.name) {
      fileManager
        .deleteFile(uploadResponse.file.name)
        .then(() => console.info(`[VoiceExtraction][${requestId}] Gemini temporary file deleted`))
        .catch((delErr) => console.warn(`[VoiceExtraction][${requestId}] Gemini temporary file cleanup failed`, { error: delErr.message }));
    }
  }
};
