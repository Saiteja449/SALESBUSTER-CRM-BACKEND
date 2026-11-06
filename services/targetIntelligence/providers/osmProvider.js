import BaseSearchProvider from "./baseProvider.js";

export class OsmSearchProvider extends BaseSearchProvider {
  constructor() {
    super("OpenStreetMap");
  }

  async searchBusinesses(filters, context = {}) {
    const { prompt, industry, city, limit } = filters;
    const start = Date.now();

    try {
      const targetTerm = industry && industry !== "All" && industry !== "Commercial Enterprise"
        ? industry
        : prompt || "";

      let rawTerms = targetTerm
        .replace(/[&/\\#,+()$~%.'":*?<>{}]/g, " ")
        .replace(/\b(find|search|companies|company|businesses|business|providing|services|service|in|near|and|or|for|the|with)\b/gi, " ")
        .replace(/\b(founder names?|founders?|mobile numbers?|phones?|business emails?|emails?|websites?|contact details?|contacts?)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (/pet/i.test(rawTerms) && !/clinic|veterinary/i.test(rawTerms)) {
        rawTerms = "pet clinic";
      }

      const targetCity = city && city !== "All" ? city : "";
      const searchQuery = `${rawTerms} ${targetCity}`.trim();
      if (!searchQuery) {
        return {
          provider: this.name,
          status: "success",
          results: [],
          durationMs: 0,
          error: null,
        };
      }

      const osmLimit = limit ? Math.min(Math.max(parseInt(limit, 10), 5), 50) : 20;
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
        searchQuery
      )}&format=json&addressdetails=1&extratags=1&namedetails=1&limit=${osmLimit}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 7000);

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            "User-Agent": "SalesBusterCRM-Intelligence/2.0 (contact: support@salesbuster.ai)",
          },
        });

        const durationMs = Date.now() - start;

        if (!response.ok) {
          const errText = await response.text().catch(() => "");
          console.warn(`[OsmSearchProvider] API error (${response.status}):`, errText);
          return {
            provider: this.name,
            status: "error",
            results: [],
            durationMs,
            error: `OpenStreetMap Nominatim returned status ${response.status}`,
          };
        }

        const data = await response.json();
        if (!Array.isArray(data)) {
          return {
            provider: this.name,
            status: "success",
            results: [],
            durationMs,
            error: null,
          };
        }

        const retrievedAt = new Date().toISOString();

        const results = data.map((item, idx) => {
          const name =
            item.namedetails?.name ||
            item.name ||
            (item.display_name ? item.display_name.split(",")[0]?.trim() : `Location ${idx + 1}`);

          const addr = item.address || {};
          const cityName = addr.city || addr.town || addr.municipality || addr.state_district || targetCity || "";
          const state = addr.state || "";
          const tags = item.extratags || {};
          const website = tags.website || tags["contact:website"] || "";
          const phone = tags.phone || tags["contact:phone"] || "";
          const email = tags.email || tags["contact:email"] || "";

          // Only use specific tags OSM actually supplies. Do NOT fabricate generic fallbacks.
          const detectedIndustry =
            tags.amenity ||
            tags.shop ||
            tags.healthcare ||
            tags.office ||
            tags.craft ||
            null;

          const osmType = item.osm_type || "node";
          const osmId = item.osm_id || "";
          const osmUrl = osmId ? `https://www.openstreetmap.org/${osmType}/${osmId}` : url;

          const locationParts = [addr.suburb || addr.neighbourhood, cityName, state].filter(Boolean);
          const locationRaw = locationParts.length > 0 ? locationParts.join(", ") : item.display_name || "";

          const sources = [
            {
              url: osmUrl,
              field: "companyName",
              accessedAt: retrievedAt,
              provider: "OpenStreetMap",
            },
          ];

          if (website) {
            sources.push({ url: osmUrl, field: "website", accessedAt: retrievedAt, provider: "OpenStreetMap" });
          }
          if (phone) {
            sources.push({ url: osmUrl, field: "phone", accessedAt: retrievedAt, provider: "OpenStreetMap" });
          }
          if (email) {
            sources.push({ url: osmUrl, field: "email", accessedAt: retrievedAt, provider: "OpenStreetMap" });
          }

          return {
            title: name,
            companyName: name,
            url: website || osmUrl,
            industry: detectedIndustry,
            description: tags.description || null,
            location: locationRaw || null,
            city: cityName || null,
            state: state || null,
            country: addr.country || "India",
            website: website || "",
            phone: phone || "",
            email: email || "",
            // Treat OSM as evidence ONLY for fields it supplies: do NOT infer founders/roles
            decisionMaker: null,
            founders: [],
            sources,
            sourceUrl: osmUrl,
            source: "OpenStreetMap Public Directory",
            confidenceScore: website || phone || email ? 80 : 70,
            matchReasons: ["Public geographic listing verified from OpenStreetMap"],
            retrievedAt,
          };
        });

        return {
          provider: this.name,
          status: "success",
          results,
          durationMs,
          error: null,
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      const durationMs = Date.now() - start;
      const isTimeout = err.name === "AbortError";
      console.warn("[OsmSearchProvider] directory search error:", err.message);

      return {
        provider: this.name,
        status: isTimeout ? "timeout" : "error",
        results: [],
        durationMs,
        error: isTimeout ? "OpenStreetMap request timed out after 7000ms" : err.message,
      };
    }
  }
}

export default OsmSearchProvider;
