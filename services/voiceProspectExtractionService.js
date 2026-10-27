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
 * @returns {Promise<{ customerName: string, companyName: string, spokenPhone: string|null, keyTopic: string }>}
 */
export const extractProspectDetailsFromVoice = async (
  filePath,
  mimeType,
  customApiKey = null
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

  let uploadResponse = null;

  try {
    console.log(
      `[VoiceExtraction] Uploading voice recording to Gemini File API: ${filePath} (${resolvedMime})`
    );

    uploadResponse = await fileManager.uploadFile(filePath, {
      mimeType: resolvedMime,
      displayName: `Live Voice Record - ${path.basename(filePath)}`,
    });

    console.log(
      `[VoiceExtraction] Upload complete. URI: ${uploadResponse.file.uri}, state: ${uploadResponse.file.state}`
    );

    // Brief settling wait
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const preferredModel =
      process.env.GEMINI_AUDIO_MODEL || "gemini-3.5-flash-lite";

    const prompt = `
You are the SalesBuster AI conversation intelligence engine.
Analyze the attached live recorded voice conversation between a Sales Manager and a prospective customer.
The conversation may be in English, Hindi, Telugu, or natural multilingual mixing (code-switching).

TASK:
Identify and extract:
1. customerName: The customer's spoken name or greeting (e.g. "Rahul", "Suresh Sharma", "Dr. Mehta"). If no clear person name was spoken, return null.
2. companyName: The business, shop, firm, or company name associated with the customer (e.g. "Apex Technologies", "Balaji Textiles", "Kiran Hospital"). If none was mentioned, return null.
3. spokenPhone: Any phone or mobile number verbally mentioned, or null.
4. keyTopic: A short 3-6 word summary of the service or product discussed.

CRITICAL FORMAT REQUIREMENT:
Respond ONLY with a valid, raw JSON object and nothing else. Do NOT include markdown code blocks, backticks, or explanatory text.
Example format:
{
  "customerName": "Rahul Sharma",
  "companyName": "Apex Technologies",
  "spokenPhone": null,
  "keyTopic": "CRM automation & WhatsApp marketing"
}
`;

    const model = genAI.getGenerativeModel({ model: preferredModel });
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
    console.log(`[VoiceExtraction] Gemini Raw Response:`, responseText);

    // Clean JSON markdown formatting if present
    const cleanJson = responseText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleanJson);
    } catch (jsonErr) {
      console.warn(
        `[VoiceExtraction] Could not parse JSON from Gemini output: ${responseText}`
      );
      throw new Error("Unable to parse structured prospect details from Gemini voice response.");
    }

    const customerName = parsed.customerName && parsed.customerName !== "null" && parsed.customerName !== "Valued Customer"
      ? parsed.customerName.trim()
      : null;
    const companyName = parsed.companyName && parsed.companyName !== "null" && parsed.companyName !== "your business" && parsed.companyName !== "your enterprise"
      ? parsed.companyName.trim()
      : null;

    if (!customerName && !companyName) {
      throw new Error("Could not identify customer name or company in the audio recording. Please ensure clear speech and record again.");
    }

    return {
      customerName: customerName || "Valued Customer",
      companyName: companyName || "",
      spokenPhone: parsed.spokenPhone || null,
      keyTopic: (parsed.keyTopic || "our discussion").trim(),
    };
  } catch (err) {
    console.error(`[VoiceExtraction] Error analyzing audio with Gemini:`, err);
    throw err;
  } finally {
    // Delete file from Gemini File API to prevent storage buildup
    if (uploadResponse?.file?.name) {
      fileManager
        .deleteFile(uploadResponse.file.name)
        .catch((delErr) =>
          console.warn(
            `[VoiceExtraction] Non-critical: Could not delete Gemini temp file:`,
            delErr.message
          )
        );
    }
  }
};
