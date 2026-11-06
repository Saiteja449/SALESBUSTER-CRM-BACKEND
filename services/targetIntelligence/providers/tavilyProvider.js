import BaseSearchProvider from "./baseProvider.js";

export class TavilySearchProvider extends BaseSearchProvider {
  constructor() {
    super("Tavily");
  }

  async searchBusinesses(filters, context = {}) {
    const apiKey = context.tavilyKey;
    const start = Date.now();

    if (!apiKey) {
      return {
        provider: this.name,
        status: "unconfigured",
        results: [],
        durationMs: 0,
        error: "Tavily API key not configured",
      };
    }

    const { prompt, industry, city, need, limit } = filters;
    let cleanPrompt = (prompt || "")
      .replace(/\b(find|search|get|fetch|look for|show me|give me|list of|top|best)\b/gi, "")
      .replace(/\b(with|having|including|and)\s+(founder names?|founders?|mobile numbers?|phones?|business emails?|emails?|websites?|contact details?|contacts?)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    let query = cleanPrompt;
    if (!query) {
      query = `${industry || "business"} in ${city && city !== "All" ? city : "India"}`.trim();
    } else if (city && city !== "All" && !query.toLowerCase().includes(city.toLowerCase())) {
      query = `${query} in ${city}`;
    }
    query = `${query} official company website`;

    const desiredCount = limit ? Math.min(Math.max(parseInt(limit, 10), 1), 50) : 10;
    const maxResults = Math.min(desiredCount + 5, 50);

    const payload = {
      query,
      search_depth: "advanced",
      include_answer: false,
      max_results: maxResults,
      exclude_domains: [
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
        "sulekha.com",
        "justdial.com",
        "indiamart.com",
        "tradeindia.com",
        "smergers.com",
        "yellowpages.in",
      ],
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      const durationMs = Date.now() - start;

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.warn(`[TavilySearchProvider] API error (${res.status}):`, errText);
        return {
          provider: this.name,
          status: "error",
          results: [],
          durationMs,
          error: `Tavily API returned status ${res.status}: ${errText.slice(0, 150)}`,
        };
      }

      const data = await res.json();
      const results = Array.isArray(data.results) ? data.results : [];

      return {
        provider: this.name,
        status: "success",
        results,
        durationMs,
        error: null,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const isTimeout = err.name === "AbortError";
      console.warn("[TavilySearchProvider] search error:", err.message);

      return {
        provider: this.name,
        status: isTimeout ? "timeout" : "error",
        results: [],
        durationMs,
        error: isTimeout ? "Tavily request timed out after 10000ms" : err.message,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async searchCompanyWebsite(companyName, location, context = {}) {
    const apiKey = context.tavilyKey;
    if (!apiKey || !companyName) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    try {
      const query = `official website "${companyName}" ${location || ""}`.trim();
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ query, max_results: 3 }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (Array.isArray(data.results) && data.results.length > 0) {
        return data.results[0].url || null;
      }
    } catch (err) {
      console.warn("[TavilySearchProvider] searchCompanyWebsite error:", err.message);
    } finally {
      clearTimeout(timeout);
    }
    return null;
  }
}

export default TavilySearchProvider;
