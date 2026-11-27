import dns from "node:dns/promises";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { verifyEmail, normalizeAndVerifyPhone, normalizeDomain } from "./verificationService.js";
import rapidApiScraperProvider from "./providers/rapidApiScraperProvider.js";

const CONFIGURED_GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

/**
 * SSRF Protection: Check if an IP address belongs to private/internal networks
 */
export function isPrivateIp(ip) {
  if (!ip) return true;
  // IPv4 Loopback
  if (ip.startsWith("127.")) return true;
  // IPv4 Private Class A: 10.0.0.0 - 10.255.255.255
  if (ip.startsWith("10.")) return true;
  // IPv4 Private Class B: 172.16.0.0 - 172.31.255.255
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  // IPv4 Private Class C: 192.168.0.0 - 192.168.255.255
  if (ip.startsWith("192.168.")) return true;
  // IPv4 Link-local / AWS / GCP / Azure metadata endpoint: 169.254.0.0/16
  if (ip.startsWith("169.254.")) return true;
  // IPv4 Broadcast or zero
  if (ip === "0.0.0.0" || ip === "255.255.255.255") return true;
  // IPv6 Loopback or unspecified
  if (ip === "::1" || ip === "::" || ip.toLowerCase().startsWith("fe80:")) return true;
  return false;
}

/**
 * Validate URL for safe public fetching (SSRF guard)
 */
export async function validateSafeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  let parsed = null;
  try {
    let clean = rawUrl.trim();
    if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
      clean = `https://${clean}`;
    }
    parsed = new URL(clean);
  } catch {
    return null;
  }

  // Only allow http/https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    return null;
  }

  // Resolve IP to check for private/internal addresses
  try {
    const lookup = await dns.lookup(hostname);
    if (isPrivateIp(lookup.address)) {
      return null;
    }
  } catch {
    return null;
  }

  return parsed.toString();
}

/**
 * Polite fetch for public web page with timeout and size cap
 */
async function fetchPublicPage(url, timeoutMs = 8000, maxSizeBytes = 2000000) {
  const safeUrl = await validateSafeUrl(url);
  if (!safeUrl) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(safeUrl, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "SalesBusterCRM-Intelligence/2.0 (Public Research Bot)",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return null;
    }

    const text = await res.text();
    return text.slice(0, maxSizeBytes);
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extract public details from raw HTML content
 */
function extractFromHtml(html, baseUrl) {
  const extracted = {
    title: "",
    description: "",
    emails: new Set(),
    phones: new Set(),
    contactPageUrl: "",
    aboutPageUrl: "",
    teamPageUrl: "",
    schemaData: null,
  };

  if (!html || typeof html !== "string") return extracted;

  // Title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) extracted.title = titleMatch[1].trim();

  // Meta description
  const metaDescMatch =
    html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);
  if (metaDescMatch) extracted.description = metaDescMatch[1].trim();

  // Schema.org / JSON-LD
  const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      extracted.schemaData = parsed;
      if (parsed.telephone) extracted.phones.add(String(parsed.telephone));
      if (parsed.email) extracted.emails.add(String(parsed.email));
      if (parsed.name && !extracted.title) extracted.title = parsed.name;
    } catch {}
  }

  // Emails regex
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  let eMatch;
  while ((eMatch = emailRegex.exec(html)) !== null) {
    const rawEmail = eMatch[0].toLowerCase();
    if (
      !rawEmail.includes(".png") &&
      !rawEmail.includes(".jpg") &&
      !rawEmail.includes(".webp") &&
      !rawEmail.includes(".svg") &&
      !/^(your|example|test|name|user|admin|info)@(email|example|domain|company)\./i.test(rawEmail)
    ) {
      extracted.emails.add(rawEmail);
    }
  }

  // Phones regex (Indian mobile 10-digit or explicit 0-prefixed STD landline; ignore timestamps/INT_MAX)
  const phoneRegex = /(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}|(?:\+91[\s-]?)?0\d{2,4}[\s-]\d{6,8}/g;
  let pMatch;
  while ((pMatch = phoneRegex.exec(html)) !== null) {
    const digits = pMatch[0].replace(/\D/g, "");
    if (digits.includes("2147483647") || /^202\d{5}$/.test(digits)) continue;
    extracted.phones.add(pMatch[0].trim());
  }

  // Find contact / about / team / social links
  const hrefRegex = /href=["']([^"']+)["']/gi;
  let hMatch;
  while ((hMatch = hrefRegex.exec(html)) !== null) {
    const rawHref = hMatch[1];
    const href = rawHref.toLowerCase();
    if (href.startsWith("mailto:")) {
      const mail = rawHref.replace(/^mailto:/i, "").split("?")[0].trim().toLowerCase();
      if (mail.includes("@")) extracted.emails.add(mail);
    } else if (href.startsWith("tel:")) {
      const tel = rawHref.replace(/^tel:/i, "").trim();
      if (tel) extracted.phones.add(tel);
    } else if (href.includes("contact") && !extracted.contactPageUrl) {
      extracted.contactPageUrl = resolveUrl(baseUrl, rawHref);
    } else if (href.includes("about") && !extracted.aboutPageUrl) {
      extracted.aboutPageUrl = resolveUrl(baseUrl, rawHref);
    } else if (
      (href.includes("team") || href.includes("leadership") || href.includes("founder")) &&
      !extracted.teamPageUrl
    ) {
      extracted.teamPageUrl = resolveUrl(baseUrl, rawHref);
    }
  }

  return extracted;
}

function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).toString();
  } catch {
    return relative;
  }
}

/**
 * Secure Website Enrichment Service
 */
export async function enrichCompanyWebsite(websiteUrl, companyName = "", apiKey = null) {
  const result = {
    websiteUrl,
    companyName,
    description: "",
    businessPhone: "",
    phoneType: "none",
    phoneVerificationStatus: "unknown",
    businessEmail: "",
    emailType: "none",
    emailVerificationStatus: "unknown",
    contactPageUrl: "",
    decisionMakers: [],
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
    confidenceScore: 70,
  };

  // Try RapidAPI Website Contacts Scraper first if configured
  if (rapidApiScraperProvider.isConfigured() && websiteUrl) {
    try {
      const scraped = await rapidApiScraperProvider.fetchWebsiteContacts(websiteUrl);
      if (scraped.success) {
        if (scraped.primaryPhone) {
          result.businessPhone = scraped.primaryPhone;
          result.phoneType = scraped.phoneType;
          result.phoneVerificationStatus = "Verified";
        }
        if (scraped.primaryEmail) {
          result.businessEmail = scraped.primaryEmail;
          result.emailType = scraped.emailType;
          result.emailVerificationStatus = "Verified";
        }
        if (scraped.socialLinks) {
          result.socialLinks = scraped.socialLinks;
        }
        if (scraped.technologies?.length > 0) {
          result.technologies = scraped.technologies;
        }
        if (scraped.description) {
          result.description = scraped.description;
        }
        if (scraped.sources?.length > 0) {
          result.sources.push(...scraped.sources);
        }
        result.confidenceScore = result.businessPhone && (result.socialLinks?.linkedin || result.businessEmail) ? 95 : 85;
      }
    } catch (scErr) {
      console.warn("[enrichmentService] RapidAPI enrichment warning:", scErr.message);
    }
  }

  const safeUrl = await validateSafeUrl(websiteUrl);
  if (!safeUrl) return result;

  const retrievedAt = new Date().toISOString();

  // 1. Fetch homepage
  const homeHtml = await fetchPublicPage(safeUrl);
  if (!homeHtml) return result;

  result.sources.push({ url: safeUrl, field: "homepage", accessedAt: retrievedAt });

  const homeData = extractFromHtml(homeHtml, safeUrl);
  if (homeData.title && !result.companyName) result.companyName = homeData.title;
  if (homeData.description) result.description = homeData.description;
  if (homeData.contactPageUrl) result.contactPageUrl = homeData.contactPageUrl;

  // 2. Fetch Contact, About, and Team pages concurrently if available (or probe common paths)
  const origin = new URL(safeUrl).origin;
  const subUrls = new Set();
  if (homeData.contactPageUrl) subUrls.add(homeData.contactPageUrl);
  else subUrls.add(`${origin}/contact`);
  if (homeData.aboutPageUrl) subUrls.add(homeData.aboutPageUrl);
  else subUrls.add(`${origin}/about`);
  if (homeData.teamPageUrl) subUrls.add(homeData.teamPageUrl);

  const subPages = await Promise.all(
    Array.from(subUrls)
      .slice(0, 3)
      .map(async (u) => ({ url: u, html: await fetchPublicPage(u, 5000) }))
  );

  let combinedSubHtml = "";
  for (const page of subPages) {
    if (!page.html) continue;
    combinedSubHtml += " " + page.html;
    result.sources.push({ url: page.url, field: "subpage", accessedAt: retrievedAt });
    const subData = extractFromHtml(page.html, page.url);
    subData.emails.forEach((e) => homeData.emails.add(e));
    subData.phones.forEach((p) => homeData.phones.add(p));
  }

  // Extract social links from homepage + subpages
  const allHtml = `${homeHtml} ${combinedSubHtml}`;
  const socialPatterns = [
    { key: "instagram", regex: /https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9._-]+/i },
    { key: "facebook", regex: /https?:\/\/(?:www\.)?facebook\.com\/[A-Za-z0-9._-]+/i },
    { key: "linkedin", regex: /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|in)\/[A-Za-z0-9._-]+/i },
    { key: "twitter", regex: /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/[A-Za-z0-9._-]+/i },
    { key: "whatsapp", regex: /https?:\/\/(?:wa\.me|api\.whatsapp\.com)\/[A-Za-z0-9?=&_-]+/i },
  ];
  for (const { key, regex } of socialPatterns) {
    if (!result.socialLinks[key]) {
      const m = allHtml.match(regex);
      if (m) result.socialLinks[key] = m[0];
    }
  }

  // 3. Process first valid email
  for (const rawEmail of homeData.emails) {
    const verified = await verifyEmail(rawEmail);
    if (verified.isValidFormat) {
      result.businessEmail = verified.email;
      result.emailType = verified.type;
      result.emailVerificationStatus = "unknown"; // Deliverability unknown without SMTP check
      result.sources.push({ url: safeUrl, field: "businessEmail", accessedAt: retrievedAt });
      break;
    }
  }

  // 4. Process first valid phone
  for (const rawPhone of homeData.phones) {
    const verified = normalizeAndVerifyPhone(rawPhone);
    if (verified.isValidFormat) {
      result.businessPhone = verified.normalized;
      result.phoneType = verified.phoneType;
      result.phoneVerificationStatus = "unknown"; // Deliverability unknown without live line verification
      result.sources.push({ url: safeUrl, field: "businessPhone", accessedAt: retrievedAt });
      break;
    }
  }

  // 5. Extract executive leadership / founders (Gemini if apiKey present, plus deterministic regex fallback)
  const cleanText = allHtml
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 18000);

  if (apiKey && cleanText.length > 50) {
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: CONFIGURED_GEMINI_MODEL,
        generationConfig: { responseMimeType: "application/json" },
      });

      const prompt = `Analyze this public website content for company "${companyName || "Company"}":
Content excerpt:
"${cleanText}"

Extract:
1. Short clear business description (1-2 sentences).
2. Key founders, CEOs, or directors explicitly mentioned in the text.
DO NOT fabricate people. If none are found, return empty founders array.
DO NOT include social media links or employee counts.

Return JSON:
{
  "description": "...",
  "founders": [
    {
      "name": "...",
      "title": "Founder / CEO / Director",
      "email": "",
      "phone": ""
    }
  ]
}`;

      const res = await model.generateContent(prompt);
      const text = res?.response?.text();
      if (text) {
        const parsed = JSON.parse(text);
        if (parsed.description && !result.description) {
          result.description = parsed.description;
        }
        if (Array.isArray(parsed.founders) && parsed.founders.length > 0) {
          result.decisionMakers = parsed.founders.map((f) => ({
            ...f,
            verificationStatus: "unknown",
          }));
        }
      }
    } catch (err) {
      console.warn(`[enrichmentService] Gemini extraction error:`, err.message);
    }
  }

  // Deterministic regex fallback for founders / lead veterinarians when Gemini is unavailable or returned 0
  if (result.decisionMakers.length === 0 && cleanText.length > 50) {
    const founderRegex =
      /\b(?:Founder(?:\s*&\s*CEO)?|Co-?Founder|Managing\s+Director|Chief\s+Executive\s+Officer|CEO|Lead\s+Veterinarian)\s*[:\-–]?\s*((?:Dr\.\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z.]+){1,2})\b/g;
    const seenNames = new Set();
    let fMatch;
    while ((fMatch = founderRegex.exec(cleanText)) !== null && result.decisionMakers.length < 3) {
      const name = fMatch[1].trim();
      const lower = name.toLowerCase();
      if (
        name.length >= 5 &&
        !seenNames.has(lower) &&
        !/^(the|and|for|with|our|about|contact|home|services|clinic|hospital|pet|care)$/i.test(lower)
      ) {
        seenNames.add(lower);
        result.decisionMakers.push({
          name,
          title: fMatch[0].split(/[:\-–]/)[0].trim() || "Founder",
          designation: "Founder",
          email: "",
          phone: "",
          verificationStatus: "unknown",
        });
      }
    }
  }

  result.confidenceScore = result.businessPhone || result.businessEmail ? 85 : 70;
  return result;
}

export default {
  isPrivateIp,
  validateSafeUrl,
  enrichCompanyWebsite,
};
