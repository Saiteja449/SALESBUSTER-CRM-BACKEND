import BaseSearchProvider from "./baseProvider.js";

const DATA_GOV_RESOURCE_ID = "4dbe5667-7b6b-41d7-82af-211562424d9a";
const DEFAULT_DATA_GOV_API_KEY =
  "579b464db66ec23bdd000001cdd3946e44ce4aad7209ff7b23ac571b";

const CITY_TO_STATE_MAP = {
  hyderabad: "telangana",
  secunderabad: "telangana",
  warangal: "telangana",
  nizamabad: "telangana",
  karimnagar: "telangana",
  bengaluru: "karnataka",
  bangalore: "karnataka",
  mysuru: "karnataka",
  mysore: "karnataka",
  mangalore: "karnataka",
  hubli: "karnataka",
  mumbai: "maharashtra",
  pune: "maharashtra",
  nagpur: "maharashtra",
  thane: "maharashtra",
  "navi mumbai": "maharashtra",
  nashik: "maharashtra",
  delhi: "delhi",
  "delhi ncr": "delhi",
  "new delhi": "delhi",
  gurgaon: "haryana",
  gurugram: "haryana",
  faridabad: "haryana",
  noida: "uttar pradesh",
  lucknow: "uttar pradesh",
  kanpur: "uttar pradesh",
  chennai: "tamil nadu",
  coimbatore: "tamil nadu",
  madurai: "tamil nadu",
  ahmedabad: "gujarat",
  surat: "gujarat",
  vadodara: "gujarat",
  rajkot: "gujarat",
  kolkata: "west bengal",
  howrah: "west bengal",
  jaipur: "rajasthan",
  udaipur: "rajasthan",
  kochi: "kerala",
  thiruvananthapuram: "kerala",
  visakhapatnam: "andhra pradesh",
  vijayawada: "andhra pradesh",
  tirupati: "andhra pradesh",
  indore: "madhya pradesh",
  bhopal: "madhya pradesh",
  chandigarh: "chandigarh",
  bhubaneswar: "odisha",
  patna: "bihar",
};

const KNOWN_STATES = [
  "telangana",
  "karnataka",
  "maharashtra",
  "delhi",
  "tamil nadu",
  "gujarat",
  "west bengal",
  "uttar pradesh",
  "rajasthan",
  "kerala",
  "andhra pradesh",
  "haryana",
  "madhya pradesh",
  "punjab",
  "odisha",
  "bihar",
  "chandigarh",
  "goa",
  "assam",
  "jharkhand",
  "chhattisgarh",
  "uttarakhand",
  "himachal pradesh",
];

const INDUSTRY_KEYWORD_MAP = {
  "pet care": ["pet", "vet", "veterinary", "animal", "kennel", "grooming"],
  "pet care & veterinary": ["pet", "vet", "veterinary", "animal", "kennel"],
  "it & software": [
    "tech",
    "technologies",
    "software",
    "it",
    "infotech",
    "systems",
    "digital",
    "cloud",
    "labs",
    "solutions",
    "cyber",
    "ai",
    "data",
  ],
  manufacturing: [
    "manufacturing",
    "industries",
    "industrial",
    "engineering",
    "metals",
    "polymers",
    "plastics",
    "machinery",
    "works",
  ],
  pharmaceuticals: [
    "pharma",
    "pharmaceuticals",
    "biotech",
    "lifesciences",
    "life sciences",
    "labs",
    "laboratories",
    "med",
    "healthcare",
  ],
  "healthcare & medical": [
    "health",
    "healthcare",
    "medical",
    "hospital",
    "clinic",
    "diagnostics",
    "medtech",
    "pharma",
  ],
  "automotive & engineering": [
    "auto",
    "automotive",
    "motors",
    "engineering",
    "mobility",
    "ev",
  ],
  "food & beverage": [
    "food",
    "foods",
    "beverage",
    "beverages",
    "agro",
    "dairy",
    "hospitality",
    "kitchen",
  ],
  "renewable energy": [
    "solar",
    "energy",
    "power",
    "renewables",
    "green",
    "infra",
  ],
};

function toTitleCase(str = "") {
  return String(str)
    .toLowerCase()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function resolveStateCode(filters = {}) {
  const stateInput = String(filters.state || "").toLowerCase().trim();
  if (stateInput && KNOWN_STATES.includes(stateInput)) {
    return stateInput;
  }

  const cityInput = String(filters.city || "").toLowerCase().trim();
  if (cityInput && cityInput !== "all" && CITY_TO_STATE_MAP[cityInput]) {
    return CITY_TO_STATE_MAP[cityInput];
  }

  const promptLower = String(filters.prompt || "").toLowerCase();
  for (const [cityKey, stateVal] of Object.entries(CITY_TO_STATE_MAP)) {
    if (promptLower.includes(cityKey)) {
      return stateVal;
    }
  }
  for (const stateName of KNOWN_STATES) {
    if (promptLower.includes(stateName)) {
      return stateName;
    }
  }

  return "telangana";
}

function extractKeywords(filters = {}) {
  const keywords = new Set();
  const industryLower = String(filters.industry || "").toLowerCase().trim();

  if (industryLower && industryLower !== "all" && industryLower !== "commercial enterprise") {
    const mapped = INDUSTRY_KEYWORD_MAP[industryLower];
    if (mapped) {
      mapped.forEach((k) => keywords.add(k));
    }
    industryLower
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2)
      .forEach((w) => keywords.add(w));
  }

  const promptLower = String(filters.prompt || "")
    .toLowerCase()
    .replace(
      /\b(find|search|companies|company|businesses|business|registered|active|in|near|and|or|for|the|with|founder|names|mobile|numbers|emails|websites|contact|details|india|hyderabad|bengaluru|bangalore|mumbai|delhi|pune|chennai|telangana|karnataka|maharashtra)\b/g,
      " "
    );

  promptLower
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2)
    .forEach((w) => keywords.add(w));

  return Array.from(keywords);
}

function parseCityFromAddress(address = "", fallbackCity = "") {
  if (!address) return fallbackCity || null;
  const parts = String(address)
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && !/^na$/i.test(p) && !/^\d{6}/.test(p));

  if (parts.length >= 3) {
    // Typical MCA format: ..., Locality, City, State, PIN-India
    return toTitleCase(parts[parts.length - 3] || parts[parts.length - 2] || fallbackCity || "");
  }
  return fallbackCity || null;
}

export class McaSearchProvider extends BaseSearchProvider {
  constructor() {
    super("MCA India (data.gov.in)");
  }

  getApiKey() {
    return (process.env.DATA_GOV_IN_API_KEY || DEFAULT_DATA_GOV_API_KEY).trim();
  }

  isConfigured() {
    return Boolean(this.getApiKey());
  }

  async searchBusinesses(filters = {}, context = {}) {
    const start = Date.now();
    const apiKey = this.getApiKey();
    if (!apiKey) {
      return {
        provider: this.name,
        status: "unconfigured",
        results: [],
        durationMs: 0,
        error: "DATA_GOV_IN_API_KEY not configured",
      };
    }

    const stateCode = resolveStateCode(filters);
    const requestedLimit = filters.limit
      ? Math.min(Math.max(parseInt(filters.limit, 10) || 10, 1), 50)
      : 10;
    const fetchLimit = Math.min(Math.max(requestedLimit * 5, 50), 100);

    const url = new URL(`https://api.data.gov.in/resource/${DATA_GOV_RESOURCE_ID}`);
    url.searchParams.set("api-key", apiKey);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", String(fetchLimit));
    url.searchParams.set("filters[CompanyStateCode]", stateCode);
    url.searchParams.set("filters[CompanyStatus]", "Active");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(url.toString(), {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
        },
      });
      const durationMs = Date.now() - start;

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        return {
          provider: this.name,
          status: "error",
          results: [],
          durationMs,
          error: `data.gov.in MCA API returned status ${response.status}${errText ? `: ${errText.slice(0, 120)}` : ""}`,
        };
      }

      const data = await response.json();
      const records = Array.isArray(data?.records) ? data.records : [];
      if (records.length === 0) {
        return {
          provider: this.name,
          status: "success",
          results: [],
          durationMs,
          error: null,
        };
      }

      const keywords = extractKeywords(filters);
      const targetCity =
        filters.city && filters.city !== "All" ? String(filters.city).toLowerCase().trim() : "";
      const retrievedAt = new Date().toISOString();

      const scored = records
        .filter((rec) => rec?.CompanyName)
        .map((rec) => {
          const nameUpper = String(rec.CompanyName || "");
          const classification = String(rec.CompanyIndustrialClassification || "");
          const address = String(rec.Registered_Office_Address || "");
          const roc = String(rec.CompanyROCcode || "");
          const haystack = `${nameUpper} ${classification} ${address}`.toLowerCase();

          let score = 0;
          if (targetCity && (address.toLowerCase().includes(targetCity) || roc.toLowerCase().includes(targetCity))) {
            score += 5;
          }
          for (const kw of keywords) {
            if (haystack.includes(kw)) {
              score += nameUpper.toLowerCase().includes(kw) ? 4 : 2;
            }
          }

          return { rec, score };
        })
        .sort((a, b) => b.score - a.score);

      const selected = scored.slice(0, requestedLimit).map(({ rec, score }) => {
        const companyName = toTitleCase(rec.CompanyName);
        const stateTitle = toTitleCase(rec.CompanyStateCode || stateCode);
        const cityParsed =
          targetCity && String(rec.Registered_Office_Address || "").toLowerCase().includes(targetCity)
            ? toTitleCase(filters.city)
            : parseCityFromAddress(rec.Registered_Office_Address, toTitleCase(filters.city && filters.city !== "All" ? filters.city : ""));

        const paidUp = Number(rec.PaidupCapital || 0);
        const authCap = Number(rec.AuthorizedCapital || 0);
        const capitalInfo = paidUp
          ? `Paid-up Capital: ₹${paidUp.toLocaleString("en-IN")}`
          : authCap
          ? `Authorized Capital: ₹${authCap.toLocaleString("en-IN")}`
          : "";

        const descriptionParts = [
          rec.CompanyClass ? `${rec.CompanyClass} Company` : null,
          rec.CIN ? `CIN: ${rec.CIN}` : null,
          rec.CompanyROCcode || null,
          rec.CompanyRegistrationdate_date ? `Inc: ${rec.CompanyRegistrationdate_date}` : null,
          capitalInfo || null,
        ].filter(Boolean);

        return {
          cin: rec.CIN || null,
          companyName,
          website: "",
          industry:
            rec.CompanyIndustrialClassification && rec.CompanyIndustrialClassification !== "NA"
              ? rec.CompanyIndustrialClassification
              : filters.industry && filters.industry !== "All"
              ? filters.industry
              : null,
          description: descriptionParts.join(" • "),
          location: {
            locality: "",
            city: cityParsed,
            state: stateTitle,
            country: "India",
            raw: rec.Registered_Office_Address || `${cityParsed || ""} ${stateTitle}`.trim(),
          },
          city: cityParsed,
          state: stateTitle,
          country: "India",
          phone: null,
          email: null,
          decisionMaker: null,
          founders: [],
          sources: [
            {
              url: `https://api.data.gov.in/resource/${DATA_GOV_RESOURCE_ID}`,
              field: "companyName",
              accessedAt: retrievedAt,
              provider: this.name,
            },
          ],
          sourceUrl: `https://api.data.gov.in/resource/${DATA_GOV_RESOURCE_ID}`,
          source: this.name,
          confidenceScore: score > 0 ? 90 : 82,
          matchReasons: [
            `Official MCA Registry (${rec.CompanyStatus || "Active"})`,
            rec.CIN ? `CIN: ${rec.CIN}` : `State: ${stateTitle}`,
          ],
          retrievedAt,
        };
      });

      return {
        provider: this.name,
        status: "success",
        results: selected,
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
        error: isTimeout ? "data.gov.in MCA API request timed out" : err.message,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export default McaSearchProvider;
