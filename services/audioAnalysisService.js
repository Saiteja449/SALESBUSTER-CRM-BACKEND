import fs from "fs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import dotenv from "dotenv";

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.warn("GEMINI_API_KEY is not defined in environment variables.");
}

const genAI = new GoogleGenerativeAI(apiKey);
const fileManager = new GoogleAIFileManager(apiKey);

import path from "path";

/**
 * Resolves standard audio MIME type based on file extension or provided MIME.
 */
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
    case ".webm":
      return "audio/webm";
    default:
      return "audio/mpeg";
  }
};

/**
 * Analyzes and transcribes an audio file using Google Gemini Multimodal API.
 * @param {string} filePath - The local path to the audio file.
 * @param {string} mimeType - The mime type of the audio file.
 * @param {string} customApiKey - Organization-specific Gemini API Key.
 * @returns {Promise<{ transcription: string, analysis: string, fullText: string }>}
 */
export const analyzeAudioFile = async (
  filePath,
  mimeType,
  customApiKey = null,
) => {
  const activeKey = customApiKey || process.env.GEMINI_API_KEY;
  if (!activeKey) {
    throw new Error(
      "Google Gemini API Key is missing. Please configure your API key in Organization Profile or set GEMINI_API_KEY in environment variables.",
    );
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`Audio file not found at path: ${filePath}`);
  }

  const genAI = new GoogleGenerativeAI(activeKey);
  const fileManager = new GoogleAIFileManager(activeKey);
  const resolvedMime = resolveAudioMimeType(filePath, mimeType);

  let uploadResponse = null;

  try {
    console.log(
      `[AudioAnalysis] Uploading audio file to Gemini File API: ${filePath} (${resolvedMime})`,
    );

    // Upload audio file to Gemini's File API
    uploadResponse = await fileManager.uploadFile(filePath, {
      mimeType: resolvedMime,
      displayName: `Call Recording - ${path.basename(filePath)}`,
    });

    console.log(
      `[AudioAnalysis] Upload complete. File URI: ${uploadResponse.file.uri}, state: ${uploadResponse.file.state}`,
    );

    // Wait briefly to ensure file is processed by Gemini
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Initialize Gemini model: defaults to gemini-3.5-flash-lite (high speed, cost-effective multimodal)
    const preferredModel = process.env.GEMINI_AUDIO_MODEL || "gemini-3.5-flash-lite";

    const prompt = `
You are an expert AI sales call assistant and transcriber for SalesBuster AI CRM.
You are analyzing an audio recording of a customer phone call or sales consultation.

Perform two essential tasks:
1. Verbatim Call Transcription: Accurately transcribe everything spoken in the audio conversation, attributing dialogue to speakers (e.g., "Sales Rep:" and "Customer:", or "Speaker 1:" / "Speaker 2:").
2. Sales Coaching & Intelligence Evaluation: Provide executive insights, summary, customer requirements, rating, and actionable coaching suggestions.

Format your response EXACTLY using the following markdown sections:

## Call Transcription
[Verbatim transcription of the conversation. Preserve spoken nuances, questions, answers, and objections.]

## Short Summary
[Maximum 2-3 sentences summarizing the purpose, discussion, and outcome of the call.]

## Customer Requirements & Key Points
- [Product / service interest, specifications, or problem customer is solving]
- [Timeline, budget, or decision criteria if discussed]
- [Objections, concerns, or queries raised]

## Rating
**Rating:** [Score out of 5, e.g. 4/5]
**Reason:** [Clear, concise explanation of the rating in 6-12 words]

## Suggestions & Action Items
- [Key actionable coaching tip for the salesperson]
- [Immediate follow-up task required for this lead]
- [Strategic recommendation to advance or close this deal]

Rules:
- Capture the transcription as thoroughly and accurately as possible from the audio.
- If the audio is silent, corrupted, or completely unintelligible, output under ## Call Transcription: "Audio could not be transcribed or is silent." and under ## Short Summary: "Audio unintelligible."
`;

    console.log(
      `[AudioAnalysis] Generating transcription and analysis via ${preferredModel}...`,
    );

    let result = null;
    try {
      const model = genAI.getGenerativeModel({ model: preferredModel });
      result = await model.generateContent([
        {
          fileData: {
            mimeType: uploadResponse.file.mimeType,
            fileUri: uploadResponse.file.uri,
          },
        },
        { text: prompt },
      ]);
    } catch (modelErr) {
      if (
        preferredModel !== "gemini-2.5-flash" &&
        (modelErr.message?.toLowerCase().includes("not found") ||
          modelErr.message?.includes("404") ||
          modelErr.status === 404)
      ) {
        console.warn(
          `[AudioAnalysis] ${preferredModel} not found or unsupported for this key/region, falling back to gemini-2.5-flash:`,
          modelErr.message,
        );
        const fallbackModel = genAI.getGenerativeModel({
          model: "gemini-2.5-flash",
        });
        result = await fallbackModel.generateContent([
          {
            fileData: {
              mimeType: uploadResponse.file.mimeType,
              fileUri: uploadResponse.file.uri,
            },
          },
          { text: prompt },
        ]);
      } else {
        throw modelErr;
      }
    }

    const fullText = result.response.text();
    console.log(`[AudioAnalysis] Generation complete for ${filePath}`);

    // Extract transcription block
    let transcription = "";
    const transMatch = fullText.match(
      /## Call Transcription\s*([\s\S]*?)(?=\n## Short Summary|\n## Customer Requirements|\n## |$)/i,
    );
    if (transMatch && transMatch[1]) {
      transcription = transMatch[1].trim();
    } else {
      transcription = fullText;
    }

    // Cleanup file from Gemini temporary storage to save storage quota
    try {
      if (uploadResponse?.file?.name) {
        await fileManager.deleteFile(uploadResponse.file.name);
        console.log(
          `[AudioAnalysis] Cleaned up Gemini storage: ${uploadResponse.file.name}`,
        );
      }
    } catch (cleanupErr) {
      console.warn(
        `[AudioAnalysis] Non-fatal cleanup warning for ${uploadResponse?.file?.name}:`,
        cleanupErr.message,
      );
    }

    return {
      transcription,
      analysis: fullText,
      fullText,
    };
  } catch (error) {
    console.error("[AudioAnalysis] Error analyzing audio file:", error);

    // Attempt cleanup on failure
    if (uploadResponse?.file?.name) {
      try {
        await fileManager.deleteFile(uploadResponse.file.name);
      } catch (e) {
        // Ignored
      }
    }

    throw error;
  }
};
