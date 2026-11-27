import BaseSearchProvider from "./baseProvider.js";

const DUCKDUCKGO_HTML_URL = "https://html.duckduckgo.com/html/";

const BLOCKED_DOMAINS = new Set([
  "duckduckgo.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "quora.com",
  "reddit.com",
  "youtube.com",
  "linkedin.com",
  "pinterest.com",
  "tiktok.com",
  "wikipedia.org",
  "justdial.com",
  "sulekha.com",
  "indiamart.com",
  "tradeindia.com",
  "yellowpages.in",
  "indiaonline.in",
  "idbf.in",
  "mychitti.net",
  "zaubacorp.com",
  "tofler.in",
  "thecompanycheck.com",
  "tracxn.com",
  "crunchbase.com",
  "ambitionbox.com",
  "glassdoor.co.in",
  "glassdoor.com",
  "naukri.com",
  "indeed.com",
]);

function decodeHtmlEntities(str = "") {
  return String(str)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unwrapDuckDuckGoUrl(rawHref = "") {
  try {
    const normalized = rawHref.startsWith("//") ? `https:${rawHref}` : rawHref;
    const parsed = new URL(normalized, "https://html.duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function isBlockedDomain(domain = "") {
  if (!domain) return true;
  if (BLOCKED_DOMAINS.has(domain)) return true;
  for (const blocked of BLOCKED_DOMAINS) {
    if (domain.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

function getRootDomain(urlStr = "") {
  try {
    return new URL(urlStr).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export class DuckDuckGoProvider extends BaseSearchProvider {
  constructor() {
    super("DuckDuckGo Open Search");
  }

  isConfigured() {
    return true;
  }

  async searchBusinesses(filters = {}) {
    const start = Date.now();
    const { prompt, industry, city, limit } = filters;

    let cleanPrompt = String(prompt || "")
      .replace(/\b(find|search|get|fetch|look for|show me|give me|list of|top|best)\b/gi, "")
      .replace(/\b(with|having|including|and)\s+(founder names?|founders?|mobile numbers?|phones?|business emails?|emails?|websites?|contact details?|contacts?)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    let query = cleanPrompt;
    if (!query) {
      const ind = industry && industry !== "All" ? industry : "businesses";
      const loc = city && city !== "All" ? city : "India";
      query = `${ind} in ${loc} official website`;
    } else if (city && city !== "All" && !query.toLowerCase().includes(city.toLowerCase())) {
      query = `${query} in ${city}`;
    }

    const desiredCount = limit ? Math.min(Math.max(parseInt(limit, 10) || 10, 1), 30) : 10;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);

    const loc = city && city !== "All" ? city : "India";
    const queries = [query];
    if (/pet/i.test(`${industry || ""} ${prompt || ""}`)) {
      queries.push(`veterinary hospital pet clinic ${loc}`);
      queries.push(`pet grooming boarding daycare ${loc}`);
    } else if (industry && industry !== "All") {
      queries.push(`${industry} company ${loc} contact email`);
    }

    try {
      const htmlPages = await Promise.all(
        queries.slice(0, 3).map(async (qStr) => {
          const formBody = new URLSearchParams({ q: qStr, kl: "in-en" }).toString();
          const resp = await fetch(DUCKDUCKGO_HTML_URL, {
            method: "POST",
            signal: controller.signal,
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
              Accept: "text/html,application/xhtml+xml",
            },
            body: formBody,
          }).catch(() => null);
          if (!resp || !resp.ok) return "";
          return await resp.text().catch(() => "");
        })
      );

      const durationMs = Date.now() - start;
      const html = htmlPages.filter(Boolean).join("\n");
      if (!html) {
        return {
          provider: this.name,
          status: "error",
          results: [],
          durationMs,
          error: "DuckDuckGo returned no HTML responses",
        };
      }
      const retrievedAt = new Date().toISOString();
      const results = [];
      const seenDomains = new Set();

      // Match result blocks with title link and optional snippet
      const linkRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      const snippetRegex = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;

      const snippets = [];
      let sMatch;
      while ((sMatch = snippetRegex.exec(html)) !== null) {
        snippets.push(decodeHtmlEntities(sMatch[1] || sMatch[2] || ""));
      }

      let match;
      let idx = 0;
      while ((match = linkRegex.exec(html)) !== null && results.length < desiredCount) {
        const rawHref = match[1];
        const rawTitle = decodeHtmlEntities(match[2]);
        const snippet = snippets[idx] || "";
        idx++;

        const targetUrl = unwrapDuckDuckGoUrl(rawHref);
        if (!targetUrl) continue;

        const domain = getRootDomain(targetUrl);
        if (!domain || isBlockedDomain(domain) || seenDomains.has(domain)) continue;
        // Skip aggregator listicles ("Top 10...", "Best 15...")
        if (/^(top|best|\d+\s+best|\d+\s+top)\b/i.test(rawTitle)) continue;

        seenDomains.add(domain);

        const companyName =
          rawTitle
            .split(/\s+[-|–—:•]\s+|[|–—•]/)
            .map((part) => part.trim())
            .find((part) => part && !/^(home|welcome|pet clinic in |best |top )/i.test(part)) ||
          rawTitle
            .split(/\s+[-|–—:•]\s+|[|–—•]/)[0]
            ?.replace(/\b(home|official website|welcome to|services|page)\b/gi, "")
            ?.trim() ||
          domain;

        results.push({
          companyName,
          website: `https://${domain}`,
          industry: industry && industry !== "All" ? industry : null,
          description: snippet || null,
          location: null,
          city: city && city !== "All" ? city : null,
          country: "India",
          phone: null,
          email: null,
          decisionMaker: null,
          founders: [],
          sources: [
            {
              url: targetUrl,
              field: "companyName",
              accessedAt: retrievedAt,
              provider: this.name,
            },
          ],
          sourceUrl: targetUrl,
          source: this.name,
          confidenceScore: 78,
          matchReasons: ["Live open web result from DuckDuckGo"],
          retrievedAt,
        });
      }

      return {
        provider: this.name,
        status: "success",
        results,
        durationMs,
        error: null,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const isTimeout = err?.name === "AbortError";
      return {
        provider: this.name,
        status: isTimeout ? "timeout" : "error",
        results: [],
        durationMs,
        error: isTimeout ? "DuckDuckGo search timed out" : err.message,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export default DuckDuckGoProvider;
