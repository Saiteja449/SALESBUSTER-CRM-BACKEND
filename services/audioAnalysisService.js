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

/**
 * Analyzes an audio file using Gemini.
 * @param {string} filePath - The local path to the audio file.
 * @param {string} mimeType - The mime type of the audio file.
 * @param {string} customApiKey - Organization-specific Gemini API Key.
 * @returns {Promise<string>} - The generated analysis summary in Markdown format.
 */
export const analyzeAudioFile = async (filePath, mimeType, customApiKey = null) => {
  const activeKey = customApiKey;
  if (!activeKey) {
    throw new Error(
      "Organization Google Gemini API Key is missing. Please configure your API key in Organization Profile before running audio analysis.",
    );
  }

  const genAI = new GoogleGenerativeAI(activeKey);
  const fileManager = new GoogleAIFileManager(activeKey);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Audio file not found at path: ${filePath}`);
  }

  try {
    console.log(`[AudioAnalysis] Uploading file to Gemini: ${filePath}`);

    // Upload the file to Gemini's File API
    const uploadResponse = await fileManager.uploadFile(filePath, {
      mimeType: mimeType || "audio/mp4",
      displayName: "Sales Call Recording",
    });

    console.log(
      `[AudioAnalysis] Upload complete. File URI: ${uploadResponse.file.uri}`,
    );

    // Wait briefly to ensure file is processed by Gemini
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Initialize the model
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    // Generate the summary
    const prompt = `
You are an AI sales call analyzer for SalesBuster AI.

The conversation is between a sales representative and a customer regarding elevator solutions, including Passenger Lifts, MRL Lifts, Hydraulic Lifts, Hospital Bed Lifts, Elevator Maintenance & AMC, or Elevator Modernization.

Analyze the audio and return ONLY Markdown in the following format.

## Short Summary
Maximum 2 sentences.

## Rating
Give a rating out of 5.

Reason:
Explain the rating in exactly 6 words.

## Suggestions
Provide 3 short bullet points (maximum 8 words each) to help the salesperson improve.

Rules:
- Keep the entire response under 120 words.
- Be concise.
- Base the rating on customer interest, elevator specification gathering (floors, capacity, door type), salesperson communication, objection handling, and closing/callback scheduling.
- If the audio is silent, corrupted, or not understandable, reply:
"The audio could not be analyzed."
`;

    console.log(`[AudioAnalysis] Requesting content generation from Gemini...`);
    const result = await model.generateContent([
      {
        fileData: {
          mimeType: uploadResponse.file.mimeType,
          fileUri: uploadResponse.file.uri,
        },
      },
      { text: prompt },
    ]);

    const analysis = result.response.text();
    console.log(`[AudioAnalysis] Analysis complete for ${filePath}`);

    // Optionally delete the file from Gemini storage to save space,
    // or let it expire after 48 hours (default behavior).
    try {
      await fileManager.deleteFile(uploadResponse.file.name);
      console.log(
        `[AudioAnalysis] Cleaned up file from Gemini storage: ${uploadResponse.file.name}`,
      );
    } catch (cleanupErr) {
      console.error(
        `[AudioAnalysis] Failed to cleanup file ${uploadResponse.file.name}:`,
        cleanupErr.message,
      );
    }

    return analysis;
  } catch (error) {
    console.error("[AudioAnalysis] Error analyzing audio file:", error);
    throw error;
  }
};
