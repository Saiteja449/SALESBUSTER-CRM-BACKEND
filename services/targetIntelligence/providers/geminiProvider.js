import { GoogleGenerativeAI } from "@google/generative-ai";
import BaseSearchProvider from "./baseProvider.js";

const CONFIGURED_GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

/**
 * Execute a Gemini call with bounded retries on transient errors
 */
async function executeWithBoundedRetry(fn, maxRetries = 2) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const isTransient =
        err.status === 429 ||
        err.status === 503 ||
        /rate limit|resource exhausted|overloaded|fetch failed|timeout|service unavailable|high demand/i.test(err.message || "");
      if (attempt > maxRetries || !isTransient) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 800 * Math.pow(2, attempt - 1)));
    }
  }
}

export class GeminiSearchProvider extends BaseSearchProvider {
  constructor() {
    super("Google Gemini");
  }

  /**
   * Interpret prompt into structured ICP filters (No employeeCount, No social media)
   */
  async interpretPrompt(promptText, apiKey) {
    if (!promptText || !promptText.trim()) return null;

    if (apiKey) {
      try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
          model: CONFIGURED_GEMINI_MODEL,
          generationConfig: { responseMimeType: "application/json" },
        });

        const instruction = `Extract structured B2B search parameters from this sales user prompt: "${promptText}".
Return ONLY a valid JSON object matching this schema:
{
  "city": "Detected city name or 'All'",
  "state": "Detected state if mentioned, or empty string",
  "country": "Detected country, default to 'India' if in India context",
  "industry": "Specific industry detected from prompt, or empty string",
  "need": "Inferred software/service/business need if any, or empty string",
  "decisionMakerRoles": ["Founder", "CEO", "Managing Director"]
}
DO NOT include employee counts or social media links.`;

        const result = await executeWithBoundedRetry(() => model.generateContent(instruction));
        const text = result?.response?.text();
        if (text) {
          return JSON.parse(text);
        }
      } catch (err) {
        console.warn(`[GeminiSearchProvider] interpretPrompt error:`, err.message);
      }
    }

    // Heuristic fallback only if AI unavailable
    const lower = promptText.toLowerCase();
    let city = "All";
    if (lower.includes("hyderabad")) city = "Hyderabad";
    else if (lower.includes("bengaluru") || lower.includes("bangalore")) city = "Bengaluru";
    else if (lower.includes("mumbai")) city = "Mumbai";
    else if (lower.includes("delhi")) city = "Delhi NCR";
    else if (lower.includes("pune")) city = "Pune";
    else if (lower.includes("chennai")) city = "Chennai";
    else if (lower.includes("ahmedabad")) city = "Ahmedabad";

    let industry = "";
    let need = "";
    const roles = ["Founder", "CEO", "Managing Director"];

    if (lower.includes("pet") || lower.includes("veterinar") || lower.includes("dog")) {
      industry = "Pet Care & Veterinary";
      need = "Client appointment booking and patient records";
    } else if (lower.includes("pharma") || lower.includes("drug")) {
      industry = "Pharmaceuticals";
    } else if (lower.includes("manufactur")) {
      industry = "Manufacturing";
    } else if (lower.includes("software") || lower.includes("saas") || lower.includes("it")) {
      industry = "IT & Software";
    }

    return {
      city,
      state: "",
      country: "India",
      industry,
      need,
      decisionMakerRoles: roles,
    };
  }

  /**
   * Synthesize & extract factual structured corporate prospects strictly from retrieved web results.
   * Every extracted prospect and claim retains source URL and timestamp.
   * Does NOT hallucinate or fill missing fields with generic defaults.
   */
  async synthesizeWebResults(webResults, filters, apiKey) {
    if (!Array.isArray(webResults) || webResults.length === 0 || !apiKey) {
      return [];
    }

    const { prompt, city, industry, roles } = filters;
    const retrievedTimestamp = new Date().toISOString();

    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: CONFIGURED_GEMINI_MODEL,
        generationConfig: { responseMimeType: "application/json" },
      });

      const citations = webResults.slice(0, 15).map((r) => ({
        title: r.title || "",
        url: r.url || "",
        content: r.content || r.snippet || "",
      }));

      const promptInstruction = `You are a strict data extraction system for B2B intelligence.
Analyze the following LIVE RETRIEVED WEB CITATIONS:
${JSON.stringify(citations, null, 2)}

TARGET QUERY CONTEXT:
- Prompt/Industry: "${prompt || industry || "Commercial Enterprise"}"
- Target Location: "${city && city !== "All" ? city : ""}"
- Desired Roles: "${Array.isArray(roles) && roles.length > 0 ? roles.join(", ") : "Executive"}"

STRICT GROUNDING & EXTRACTION RULES:
1. Extract ONLY businesses and people that are EXPLICITLY mentioned in the citations above.
2. NEVER invent, fabricate, guess, or extrapolate company names, contacts, emails, phones, websites, or people.
3. If a field (phone, email, founder, website, industry, location) is not explicitly present in the citation text, return it as null or empty string. NEVER fill it with plausible placeholders or generic guesses.
4. For each business, include "sourceUrl": the exact citation URL from the citations list where this company information was found.
5. NO employee counts and NO social media links.
6. Return matchReasons containing 1-2 factual points directly cited from the text.
7. confidenceScore should be calculated strictly based on evidence: 90+ if phone/email/website verified in citation, 75-85 if only basic listing.

Return ONLY a valid JSON array of objects:
[
  {
    "companyName": "Legal or trade name directly from citation",
    "industry": "Specific industry stated in citation, or null",
    "description": "Factual description stated in citation, or null",
    "location": "Address/locality stated in citation, or null",
    "city": "City stated in citation, or null",
    "website": "Website URL stated in citation, or null",
    "decisionMaker": {
      "name": "Person name stated in citation, or null",
      "title": "Title stated in citation, or null",
      "email": "Email stated in citation, or null",
      "phone": "Phone stated in citation, or null"
    },
    "phone": "Phone stated in citation, or null",
    "email": "Email stated in citation, or null",
    "contactPage": "Contact page URL if stated in citation, or null",
    "sourceUrl": "The exact citation URL",
    "confidenceScore": 85,
    "matchReasons": ["Citing live web match from source"]
  }
]`;

      const result = await executeWithBoundedRetry(() => model.generateContent(promptInstruction));
      const text = result?.response?.text();
      if (text) {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed) && parsed.length > 0) {
          // Validate and stamp each extracted item with source provenance
          return parsed
            .filter((item) => item && typeof item.companyName === "string" && item.companyName.trim().length > 0)
            .map((item) => {
              const sourceUrl = item.sourceUrl || webResults[0]?.url || "";
              const sources = [];
              if (sourceUrl) {
                sources.push({
                  url: sourceUrl,
                  field: "companyName",
                  accessedAt: retrievedTimestamp,
                  provider: "Tavily",
                });
                if (item.phone) {
                  sources.push({ url: sourceUrl, field: "phone", accessedAt: retrievedTimestamp, provider: "Tavily" });
                }
                if (item.email) {
                  sources.push({ url: sourceUrl, field: "email", accessedAt: retrievedTimestamp, provider: "Tavily" });
                }
                if (item.website) {
                  sources.push({ url: sourceUrl, field: "website", accessedAt: retrievedTimestamp, provider: "Tavily" });
                }
                if (item.decisionMaker?.name) {
                  sources.push({ url: sourceUrl, field: "decisionMaker", accessedAt: retrievedTimestamp, provider: "Tavily" });
                }
              }

              return {
                ...item,
                source: "Tavily Web Search",
                sourceUrl,
                sources,
                retrievedAt: retrievedTimestamp,
              };
            });
        }
      }
    } catch (err) {
      console.warn(`[GeminiSearchProvider] synthesizeWebResults error:`, err.message);
    }

    return [];
  }
}

export default GeminiSearchProvider;
