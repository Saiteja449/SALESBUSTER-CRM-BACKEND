import { GoogleGenerativeAI } from "@google/generative-ai";

const PRIMARY_MODEL = process.env.CARD_VISION_MODEL || "gemini-3.5-flash-lite";
const FALLBACK_MODEL = "gemini-2.5-flash";

/**
 * Extracts structured contact & company details from a business card image using Gemini Multimodal Vision.
 * Powered by gemini-3.5-flash-lite with gemini-2.5-flash fallback.
 *
 * @param {Object} params
 * @param {string} params.imageBase64 - Raw base64 string (with or without data:image/... prefix)
 * @param {string} [params.mimeType="image/jpeg"] - Image MIME type
 * @param {string} params.geminiApiKey - API key
 * @returns {Promise<Object>} Extracted contact details
 */
export async function extractBusinessCardData({ imageBase64, mimeType = "image/jpeg", geminiApiKey }) {
  if (!imageBase64 || typeof imageBase64 !== "string") {
    throw new Error("Base64 image data is required for card extraction.");
  }

  const apiKey = geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Gemini API key is required for card vision extraction.");
  }

  // Strip data URL scheme prefix if present
  let cleanBase64 = imageBase64.trim();
  const dataUrlMatch = cleanBase64.match(/^data:image\/[a-zA-Z0-9+.-]+;base64,(.+)$/);
  if (dataUrlMatch && dataUrlMatch[1]) {
    cleanBase64 = dataUrlMatch[1];
  }

  const cleanMimeType = (mimeType || "image/jpeg").toLowerCase().trim();

  const prompt = `You are an expert AI vision system specialized in optical character recognition (OCR) and structured entity extraction from business cards, visiting cards, and corporate ID badges.

Carefully inspect the provided image of the business card and extract the key contact details into structured JSON.

EXTRACTION GUIDELINES:
1. name: The full name of the individual / cardholder. Do NOT confuse the company name with the person's name. If no individual person is named, return null.
2. phone: The primary mobile/cell phone number.
   - Normalize Indian phone numbers to exactly 10 digits without country code (+91/91), spaces, or hyphens.
   - If multiple numbers appear (e.g. mobile vs landline), PREFER the mobile number starting with 6, 7, 8, or 9.
3. companyName: The business, organization, agency, or corporate brand name on the card.
4. designation: The professional job title, position, or role (e.g., Managing Director, Founder, CEO, Sales Manager, Partner).
5. email: The primary business email address.
6. website: The company website URL or domain.
7. address: The physical office address, city, or branch location.
8. summary: A concise 1-2 sentence professional summary combining what the company/business provides, with email and address appended if present.

Return ONLY a valid JSON object matching this schema:
{
  "name": "string or null",
  "phone": "string or null",
  "companyName": "string or null",
  "designation": "string or null",
  "email": "string or null",
  "website": "string or null",
  "address": "string or null",
  "summary": "string or null"
}`;

  const imagePart = {
    inlineData: {
      data: cleanBase64,
      mimeType: cleanMimeType,
    },
  };

  const genAI = new GoogleGenerativeAI(apiKey);

  const executeExtraction = async (modelName) => {
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.1,
      },
    });

    const result = await model.generateContent([prompt, imagePart]);
    const responseText = result.response?.text();
    if (!responseText) throw new Error("Empty response from Gemini Vision model");
    return JSON.parse(responseText);
  };

  let rawData = null;
  try {
    rawData = await executeExtraction(PRIMARY_MODEL);
  } catch (primaryErr) {
    console.warn(`[CardVision] Primary model ${PRIMARY_MODEL} failed, trying fallback ${FALLBACK_MODEL}:`, primaryErr.message);
    try {
      rawData = await executeExtraction(FALLBACK_MODEL);
    } catch (fallbackErr) {
      console.error(`[CardVision] Fallback model ${FALLBACK_MODEL} failed:`, fallbackErr.message);
      throw new Error(`Failed to analyze card image with AI: ${fallbackErr.message}`);
    }
  }

  // Sanitize and normalize fields
  const cleanField = (val) => (typeof val === "string" ? val.trim() : null);

  let name = cleanField(rawData.name);
  let companyName = cleanField(rawData.companyName);
  let designation = cleanField(rawData.designation);
  const email = cleanField(rawData.email);
  const website = cleanField(rawData.website);
  const address = cleanField(rawData.address);
  let summary = cleanField(rawData.summary);

  // Normalize phone number
  let cleanPhone = "";
  if (rawData.phone) {
    const digits = String(rawData.phone).replace(/\D/g, "");
    let candidate = digits;
    if (candidate.length === 12 && candidate.startsWith("91")) candidate = candidate.slice(2);
    else if (candidate.length === 11 && candidate.startsWith("0")) candidate = candidate.slice(1);

    if (candidate.length === 10 && /^[6-9]\d{9}$/.test(candidate)) {
      cleanPhone = candidate;
    } else if (digits.length >= 10) {
      cleanPhone = digits.slice(-10);
    }
  }

  // Disambiguation: if name and company are identical, retain only company
  if (name && companyName && name.toLowerCase() === companyName.toLowerCase()) {
    name = null;
  }

  // Build comprehensive discussion/card summary if empty or short
  if (!summary || summary.length < 5) {
    const parts = [];
    if (companyName) parts.push(companyName);
    if (designation && name) parts.push(`represented by ${name} (${designation})`);
    if (email) parts.push(`Email: ${email}`);
    if (website) parts.push(`Website: ${website}`);
    if (address) parts.push(`Address: ${address}`);
    summary = parts.join(" | ");
  }

  return {
    name: name || "",
    phone: cleanPhone || "",
    companyName: companyName || "",
    designation: designation || "",
    email: email || "",
    website: website || "",
    address: address || "",
    summary: summary || "",
  };
}

export default { extractBusinessCardData };

