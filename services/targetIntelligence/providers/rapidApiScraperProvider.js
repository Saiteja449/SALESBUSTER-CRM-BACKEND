import { normalizeDomain, normalizeAndVerifyPhone, verifyEmail } from "../verificationService.js";

const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || "website-social-scraper-api.p.rapidapi.com";
const RAPIDAPI_BASE_URL = `https://${RAPIDAPI_HOST}/v1/contacts`;

/**
 * RapidAPI Website Contacts Scraper Provider
 * Calls https://website-social-scraper-api.p.rapidapi.com/v1/contacts?website={domain}
 */
export class RapidApiScraperProvider {
  constructor() {
    this.name = "RapidAPI Website Contacts Scraper";
    this.host = RAPIDAPI_HOST;
  }

  /**
   * Check if RapidAPI is configured
   */
  isConfigured() {
    return Boolean(process.env.RAPIDAPI_KEY && process.env.RAPIDAPI_KEY.trim().length > 5);
  }

  /**
   * Clean and normalize a website URL into a domain suitable for the API
   */
  extractTargetDomain(websiteUrl) {
    if (!websiteUrl || typeof websiteUrl !== "string") return null;
    const clean = websiteUrl.trim();
    const domain = normalizeDomain(clean);
    return domain || clean.replace(/^https?:\/\//i, "").split("/")[0].trim();
  }

  /**
   * Fetch website contact details and social handles
   * @param {string} websiteUrl - Target website URL or domain (e.g., 'petsfolio.com')
   * @param {object} options - Optional overrides (timeoutMs, apiKey)
   */
  async fetchWebsiteContacts(websiteUrl, options = {}) {
    const apiKey = options.apiKey || process.env.RAPIDAPI_KEY;
    const timeoutMs = options.timeoutMs || 15000;
    const maxRetries = options.maxRetries !== undefined ? options.maxRetries : 1;

    const result = {
      success: false,
      domain: "",
      title: null,
      companyName: null,
      description: null,
      primaryPhone: null,
      phoneType: "none",
      allPhones: [],
      primaryEmail: null,
      emailType: "none",
      allEmails: [],
      socialLinks: {
        linkedin: "",
        twitter: "",
        facebook: "",
        instagram: "",
        whatsapp: "",
        youtube: "",
        github: "",
      },
      technologies: [],
      sources: [],
      durationMs: 0,
      error: null,
    };

    if (!apiKey) {
      result.error = "RAPIDAPI_KEY not configured in .env";
      return result;
    }

    const targetDomain = this.extractTargetDomain(websiteUrl);
    if (!targetDomain) {
      result.error = "Invalid website domain";
      return result;
    }

    result.domain = targetDomain;
    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const requestUrl = `${RAPIDAPI_BASE_URL}?website=${encodeURIComponent(targetDomain)}`;

      const response = await fetch(requestUrl, {
        method: "GET",
        headers: {
          "x-rapidapi-host": this.host,
          "x-rapidapi-key": apiKey.trim(),
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      result.durationMs = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        if ((response.status === 503 || response.status === 429) && maxRetries > 0) {
          clearTimeout(timeout);
          await new Promise((resolve) => setTimeout(resolve, 1500));
          return this.fetchWebsiteContacts(websiteUrl, {
            ...options,
            maxRetries: maxRetries - 1,
            timeoutMs,
          });
        }
        result.error = `RapidAPI returned status ${response.status}: ${errorText.slice(0, 200)}`;
        return result;
      }

      const raw = await response.json();
      result.success = true;

      // 1. Meta / Company Info
      if (raw.title) result.title = raw.title;
      if (raw.company?.name) result.companyName = raw.company.name;
      if (raw.description) result.description = raw.description;

      // 2. Extract and Normalize Phones
      const rawPhones = Array.isArray(raw.phones) ? raw.phones : [];
      const extractedPhones = [];

      for (const p of rawPhones) {
        const phoneVal = typeof p === "string" ? p : p?.value || p?.phone;
        if (!phoneVal) continue;

        const verified = normalizeAndVerifyPhone(phoneVal);
        const item = {
          raw: phoneVal,
          normalized: verified.isValidFormat ? verified.normalized : phoneVal,
          type: (typeof p === "object" && p.type) || verified.phoneType || "mobile",
          isLikelyOfficial: Boolean(typeof p === "object" ? p.is_likely_official : true),
          sources: (typeof p === "object" && Array.isArray(p.sources)) ? p.sources : [],
        };
        extractedPhones.push(item);
      }
      result.allPhones = extractedPhones;

      if (extractedPhones.length > 0) {
        // Prioritize official mobile or first available
        const preferredPhone =
          extractedPhones.find((p) => p.isLikelyOfficial && p.type === "mobile") ||
          extractedPhones.find((p) => p.isLikelyOfficial) ||
          extractedPhones[0];

        result.primaryPhone = preferredPhone.normalized;
        result.phoneType = preferredPhone.type;
        result.phoneVerificationStatus = "Verified";
      }

      // 3. Extract and Normalize Emails
      const rawEmails = Array.isArray(raw.emails) ? raw.emails : [];
      const extractedEmails = [];

      for (const e of rawEmails) {
        const emailVal = typeof e === "string" ? e : e?.value || e?.email;
        if (!emailVal) continue;

        const verified = await verifyEmail(emailVal);
        const item = {
          email: verified.isValidFormat ? verified.email : emailVal.toLowerCase().trim(),
          type: verified.type || "corporate",
          isLikelyOfficial: Boolean(typeof e === "object" ? e.is_likely_official : true),
          sources: (typeof e === "object" && Array.isArray(e.sources)) ? e.sources : [],
        };
        extractedEmails.push(item);
      }
      result.allEmails = extractedEmails;

      if (extractedEmails.length > 0) {
        const preferredEmail =
          extractedEmails.find((e) => e.isLikelyOfficial && e.type === "direct") ||
          extractedEmails.find((e) => e.isLikelyOfficial) ||
          extractedEmails[0];

        result.primaryEmail = preferredEmail.email;
        result.emailType = preferredEmail.type;
        result.emailVerificationStatus = "Verified";
      }

      // 4. Extract Social Links
      const pickSocial = (list) => {
        if (!Array.isArray(list) || list.length === 0) return "";
        const item = list[0];
        return typeof item === "string" ? item : item?.value || "";
      };

      result.socialLinks = {
        linkedin: pickSocial(raw.linkedins),
        twitter: pickSocial(raw.twitters),
        facebook: pickSocial(raw.facebooks),
        instagram: pickSocial(raw.instagrams),
        whatsapp: pickSocial(raw.whatsapps),
        youtube: pickSocial(raw.youtubes),
        github: pickSocial(raw.githubs),
      };

      // 5. Technologies
      if (Array.isArray(raw.technologies)) {
        result.technologies = raw.technologies.map((t) => (typeof t === "string" ? t : t.name)).filter(Boolean);
      }

      // 6. Source Provenance
      result.sources.push({
        url: requestUrl,
        provider: "RapidAPI Website Contacts Scraper",
        accessedAt: new Date().toISOString(),
        field: "contactDetails",
      });

      return result;
    } catch (err) {
      result.durationMs = Date.now() - startTime;
      result.error = err.name === "AbortError" ? "RapidAPI request timed out" : err.message;
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const rapidApiScraperProvider = new RapidApiScraperProvider();
export default rapidApiScraperProvider;

