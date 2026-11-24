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
  requestId = "untracked",
  options = {},
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

    const profileRegistration = Boolean(options.profileRegistration);
    const personDescription = profileRegistration
      ? "the person completing their SalesBuster profile (the speaker introducing themselves)"
      : "the prospective customer, not the sales manager";
    const companyDescription = profileRegistration
      ? "the speaker's own company or business"
      : "the business, shop, firm, or company associated with the customer";
    const designationDescription = profileRegistration
      ? "the speaker's own job title, role, or designation"
      : "the customer's spoken job title, role, or designation";

    const prompt = `
You are the SalesBuster AI conversation intelligence engine.
Analyze the attached recorded voice conversation${profileRegistration ? " for profile registration" : " between a Sales Manager and a prospective customer"}.
The conversation may be in English, Hindi, Telugu, or natural multilingual mixing (code-switching).
CRITICAL: Extract all requested details directly from this audio recording. Do not use live transcripts or outside context.

TASK:
Identify and extract:
1. customerName: The actual spoken personal name of ${personDescription} (e.g. "Rahul", "Suresh Sharma", "Dr. Mehta", "Ramesh"). Preserve the name as spoken; do not omit or replace it because it is short, unfamiliar, accented, or sounds similar to a company name. Use the speaker's self-introduction or surrounding conversation to identify it. Do not put a greeting, job title, or company in this field. Return null only if no relevant personal name is audible.
2. companyName: ${companyDescription} (e.g. "Apex Technologies", "Balaji Textiles", "Kiran Hospital"). If none was mentioned, return null.
3. designation: ${designationDescription} (e.g. "Managing Director", "Founder", "CEO", "Owner", "Procurement Manager", "Operations Head", "Partner", "Doctor", "Purchase In-charge", "Manager"). If not mentioned, return null.
4. spokenPhone: The ${profileRegistration ? "profile user's" : "customer's"} mobile or WhatsApp number verbally spoken, dictated, or exchanged anywhere in the conversation (10 digits or partial digits if spoken incompletely, at least 6 digits).
   - May be spoken as digits or words in English, Hindi, or Telugu (e.g. "nine eight seven six five four three two one zero", "double nine, eight seven six...", "mera number 9876543210", "na number note cheyandi 9876543210").
   - Convert spoken number words into a continuous numeric digit string (e.g. "9876543210" or "9848012").
   - If country code (+91 or 91) is mentioned, include it or return the digits.
   - If no phone number was spoken or fewer than 6 digits were spoken, return null.
5. keyTopic: A short 3-6 word summary of the service or product discussed.
6. city: The city or town explicitly stated for ${profileRegistration ? "the person registering, including where they are from, live, work, or where their company or office is based" : "the customer or their business"}. Phrases such as "I am from Hyderabad", "our office is in Hyderabad", and "we are based in Hyderabad" all identify the city. Preserve the spoken place name. Return null only when no relevant city is audible.

CRITICAL FORMAT REQUIREMENT:
Respond ONLY with a valid, raw JSON object and nothing else. Do NOT include markdown code blocks, backticks, or explanatory text.
Always include every key shown in the schema. Use null for a field only when that information is not audible in the recording; never omit a key.
Example format:
{
  "customerName": "Rahul Sharma",
  "companyName": "Apex Technologies",
  "designation": "Managing Director",
  "spokenPhone": "9876543210",
  "keyTopic": "CRM automation & WhatsApp marketing",
  "city": "Hyderabad"
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
    const normalizeCity = (value) => {
      if (value && typeof value === "object") value = value.value || value.name;
      if (typeof value !== "string") return "";
      const cityValue = value.trim().replace(/[.,;!?]+$/, "").trim();
      if (/^(?:null|undefined|none|unknown|not mentioned|not discussed|not provided|not applicable|n\/a|na|)$/i.test(cityValue)) {
        return "";
      }
      return cityValue;
    };

    let city = normalizeCity(parsed.city || parsed.cityName || parsed.locationCity || parsed.location?.city);
    console.info(`[VoiceExtraction][${requestId}] Main city extraction completed`, { cityFound: Boolean(city) });
    if (!city) {
      try {
        console.info(`[VoiceExtraction][${requestId}] City missing from main response; running focused audio extraction`);
        const cityPrompt = `Listen to the attached recording and identify only the city or town explicitly stated for ${profileRegistration ? "the person registering, their work, company, or office" : "the customer or their business"}. Include where they are from, live, work, or are based. Look for phrases such as "I am from [city]", "I live in [city]", "our company is in [city]", "our office is based in [city]", Hindi "main [city] se hoon" / "hamara office [city] mein hai", and Telugu "nenu [city] nunchi" / "maa office [city] lo undi". Return the city name as spoken, with no state, country, explanation, or guessed location. Do not use a person's name, company name, unrelated event location, or a city mentioned about someone else. Return exactly one JSON object in the form {"city":"City Name"}; if no relevant city is audible, return {"city":null}.`;
        const cityModel = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: { responseMimeType: "application/json" },
        });
        const cityResult = await cityModel.generateContent([
          {
            fileData: {
              fileUri: uploadResponse.file.uri,
              mimeType: uploadResponse.file.mimeType,
            },
          },
          { text: cityPrompt },
        ]);
        const cityResponseText = cityResult.response.text().trim();
        const cleanCityResponse = cityResponseText
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/i, "")
          .trim();
        const parsedCityResponse = JSON.parse(cleanCityResponse);
        city = normalizeCity(parsedCityResponse.city || parsedCityResponse.cityName || parsedCityResponse.locationCity);
        console.info(`[VoiceExtraction][${requestId}] Focused city extraction completed`, { cityFound: Boolean(city) });
      } catch (cityErr) {
        console.warn(`[VoiceExtraction][${requestId}] Focused city extraction failed`, { error: cityErr.message });
      }
    }

    // Sanitize spoken phone
    let cleanSpokenPhone = null;
    if (parsed.spokenPhone && parsed.spokenPhone !== "null") {
      const rawDigits = String(parsed.spokenPhone).replace(/\D/g, "");
      if (rawDigits.length >= 6) {
        cleanSpokenPhone = rawDigits.length >= 10 ? rawDigits.slice(-10) : rawDigits;
      }
    }

    return {
      customerName: customerName || "Valued Customer",
      companyName: companyName || "",
      designation: designation || "",
      spokenPhone: cleanSpokenPhone,
      keyTopic: (parsed.keyTopic || "our discussion").trim(),
      city,
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
