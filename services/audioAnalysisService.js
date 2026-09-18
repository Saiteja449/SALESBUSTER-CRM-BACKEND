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
You are a sales call transcription and analysis assistant for SalesBuster AI CRM.

Analyze the attached audio recording.

Your tasks:

1. TRANSCRIPTION
- Transcribe all clearly audible speech.
- Identify speakers when possible using "Sales Rep:" and "Customer:".
- If speakers cannot be reliably identified, use "Speaker 1:" and "Speaker 2:".
- Preserve meaningful repetitions, questions, answers, objections, and incomplete statements.
- Do not invent, assume, or reconstruct speech that is not audible.
- If a section is unclear, use "[inaudible]" instead of guessing.

2. CALL ANALYSIS
Analyze ONLY information explicitly available in the audio.

IMPORTANT:
- Never invent customer requirements.
- Never assume product/service interest unless it is actually discussed.
- Never infer budget, timeline, objections, or intent without evidence.
- If something was not discussed, write "Not discussed."
- If this is clearly a test call, greeting-only call, silent call, wrong number, or unintelligible call, identify it accordingly.
- Do not treat greetings or connection testing as a genuine sales requirement.

3. CALL RATING

Use this rating scale consistently:

5/5 = Strong substantive sales conversation with clear requirements, engagement, and meaningful next steps.
4/5 = Good sales conversation with useful requirements and/or clear next steps.
3/5 = Moderate conversation with some useful information but significant gaps.
2/5 = Limited sales conversation with very little useful information.
1/5 = Test call, greeting-only call, silent/unintelligible call, wrong number, or no substantive sales discussion.

The rating must reflect the QUALITY AND SUBSTANCE OF THE CALL, not whether the salesperson successfully closed a deal.

4. ACTION ITEMS
Provide:
- One coaching tip for the salesperson.
- One immediate follow-up action.
- One strategic recommendation.

If an action is not applicable, write "Not applicable."

Return the result ONLY as valid JSON using exactly this structure:

{
  "transcription": "Speaker 1: ...\\nSpeaker 2: ...",
  "shortSummary": "Maximum 2-3 sentences and max 50 words.",
  "customerRequirements": {
    "productOrServiceInterest": "Not discussed.",
    "timelineBudgetDecisionCriteria": "Not discussed.",
    "objectionsConcernsQueries": "None raised."
  },
  "rating": {
    "score": 1,
    "reason": "No substantive sales conversation occurred."
  },
  "suggestionsAndActionItems": {
    "salespersonCoachingTip": "...",
    "immediateFollowUp": "...",
    "strategicRecommendation": "..."
  }
}

Additional rules:
- rating.score must be an integer from 1 to 5.
- rating.reason must be 6-12 words.
- shortSummary must contain no more than 3 sentences and max 50 words.
- Do not use Markdown.
- Do not include additional JSON fields.
- Return valid JSON only.

If the audio is silent, corrupted, or completely unintelligible:
- transcription = "Audio could not be transcribed or is silent."
- shortSummary = "Audio unintelligible."
- customer requirements fields = "Not discussed."
- rating.score = 1
- rating.reason = "No usable conversation was available for analysis."
- salespersonCoachingTip = "Verify the call connection and audio quality."
- immediateFollowUp = "Check the call recording and connection logs."
- strategicRecommendation = "Not applicable."
`;

    console.log(
      `[AudioAnalysis] Generating transcription and analysis via ${preferredModel}...`,
    );

    let result = null;
    try {
      const model = genAI.getGenerativeModel({ 
        model: preferredModel,
        generationConfig: { responseMimeType: "application/json" }
      });
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
          generationConfig: { responseMimeType: "application/json" }
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

    // Parse the JSON and build markdown equivalent to avoid breaking the frontend
    let parsedJson = {};
    try {
      parsedJson = JSON.parse(fullText);
    } catch (parseErr) {
      console.warn("[AudioAnalysis] Failed to parse JSON, attempting manual cleanup:", parseErr.message);
      try {
        const cleanedText = fullText.replace(/```json/i, "").replace(/```/g, "").trim();
        parsedJson = JSON.parse(cleanedText);
      } catch (fallbackErr) {
        console.error("[AudioAnalysis] Irrecoverable JSON parse error:", fallbackErr.message);
        parsedJson = {
          transcription: "Error parsing AI response. View full output for details.",
          shortSummary: "Error parsing AI response.",
          customerRequirements: {},
          rating: { score: 0, reason: "Parse error" },
          suggestionsAndActionItems: {}
        };
      }
    }

    const transcription = parsedJson.transcription || "No transcription provided.";
    
    // Construct the markdown string that the frontend expects
    const markdownAnalysis = `## Call Transcription
${transcription}

## Short Summary
${parsedJson.shortSummary || ""}

## Customer Requirements & Key Points
- ${parsedJson.customerRequirements?.productOrServiceInterest || "Not discussed"}
- ${parsedJson.customerRequirements?.timelineBudgetDecisionCriteria || "Not discussed"}
- ${parsedJson.customerRequirements?.objectionsConcernsQueries || "None raised"}

## Rating
**Rating:** ${parsedJson.rating?.score || 0}/5
**Reason:** ${parsedJson.rating?.reason || "Not provided"}

## Suggestions & Action Items
- ${parsedJson.suggestionsAndActionItems?.salespersonCoachingTip || "None"}
- ${parsedJson.suggestionsAndActionItems?.immediateFollowUp || "None"}
- ${parsedJson.suggestionsAndActionItems?.strategicRecommendation || "None"}
`;

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
