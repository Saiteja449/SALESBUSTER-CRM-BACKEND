import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { decryptApiKey } from "../utils/encryption.js";

dotenv.config();

/**
 * Resolves the active Gemini API key from organization settings or environment variables.
 * @param {Object} organization - Optional organization document with aiSettings
 * @returns {string} Gemini API key
 */
export const getGeminiApiKey = (organization = null) => {
  const orgKey = organization?.aiSettings?.geminiApiKey;
  if (orgKey) {
    const decrypted = decryptApiKey(orgKey);
    if (decrypted) return decrypted;
  }
  return process.env.GEMINI_API_KEY || "";
};

/**
 * Creates an instance of GoogleGenAI SDK with the resolved key.
 * @param {Object} organization - Optional organization document
 * @returns {GoogleGenAI}
 */
export const createGeminiClient = (organization = null) => {
  const apiKey = getGeminiApiKey(organization);
  if (!apiKey) {
    throw new Error(
      "Gemini API key is not configured. Please set GEMINI_API_KEY in environment or organization settings."
    );
  }
  return new GoogleGenAI({ apiKey });
};

/**
 * Configured Gemini Model IDs
 */
export const GEMINI_MODELS = {
  LIVE_TRANSCRIBE:
    process.env.GEMINI_LIVE_TRANSCRIPTION_MODEL || "gemini-3.5-transcribe-live",
  FINAL_TRANSCRIBE:
    process.env.GEMINI_FINAL_TRANSCRIPTION_MODEL || "gemini-3.5-transcribe",
  EXTRACTION_SUMMARY:
    process.env.GEMINI_EXTRACTION_MODEL || "gemini-3.5-flash",
};

