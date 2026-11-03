import TavilySearchProvider from "./providers/tavilyProvider.js";
import OsmSearchProvider from "./providers/osmProvider.js";
import GeminiSearchProvider from "./providers/geminiProvider.js";
import { verifyEmail, normalizeAndVerifyPhone, normalizeDomain } from "./verificationService.js";

const tavilyProvider = new TavilySearchProvider();
const osmProvider = new OsmSearchProvider();
const geminiProvider = new GeminiSearchProvider();

/**
 * Compute canonical prospect key based on normalized company name and domain or location
 */
export function computeProspectKey(p) {
  if (!p) return `key_${Date.now()}`;
  const company = (p.companyName || "").toLowerCase().trim().replace(/[^a-z0-9]/g, "");
  const domain = normalizeDomain(p.website || p.contact?.businessEmail || "");
  const city = (p.location?.city || p.city || "").toLowerCase().trim().replace(/[^a-z0-9]/g, "");
  return `comp_${company}_${domain || city || "in"}`.slice(0, 100);
}

/**
 * Main Discovery Service
 */
export class DiscoveryService {
  /**
   * Interpret Prompt into structured ICP filters
   */
  async interpretPrompt(promptText, apiKey) {
    return await geminiProvider.interpretPrompt(promptText, apiKey);
  }

  /**
   * Execute Multi-Provider Live Business Discovery
   * Concurrently queries independent providers via Promise.allSettled.
   * Does NOT use hard-coded registries, seeded results, or LLM-invented facts.
   */
  async discoverBusinesses(filters, context = {}) {
    const { apiKey, tavilyKey, organizationId, tenantModels = {} } = context;
    const { ResolvedModel, ProviderUsageModel } = tenantModels;

    const timings = {
      totalMs: 0,
      providerSearchMs: 0,
      extractionMs: 0,
      resolutionLookupMs: 0,
    };
    const overallStart = Date.now();

    const providerStatuses = {
      tavily: {
        status: tavilyKey ? "pending" : "unconfigured",
        count: 0,
        durationMs: 0,
        error: tavilyKey ? null : "Tavily API key not configured",
      },
      openStreetMap: {
        status: "pending",
        count: 0,
        durationMs: 0,
        error: null,
      },
    };

    // 1. Run independent live provider searches concurrently
    const providerTasks = [];

    if (tavilyKey) {
      providerTasks.push(
        tavilyProvider
          .searchBusinesses(filters, { tavilyKey })
          .then((res) => ({ providerKey: "tavily", ...res }))
          .catch((err) => ({
            providerKey: "tavily",
            status: "error",
            results: [],
            durationMs: 0,
            error: err.message,
          }))
      );
    }

    providerTasks.push(
      osmProvider
        .searchBusinesses(filters)
        .then((res) => ({ providerKey: "openStreetMap", ...res }))
        .catch((err) => ({
          providerKey: "openStreetMap",
          status: "error",
          results: [],
          durationMs: 0,
          error: err.message,
        }))
    );

    const providerStart = Date.now();
    const providerSettled = await Promise.allSettled(providerTasks);
    timings.providerSearchMs = Date.now() - providerStart;

    const rawCandidates = [];
    const usedProviders = [];

    for (const settled of providerSettled) {
      if (settled.status === "fulfilled") {
        const val = settled.value;
        const pKey = val.providerKey;

        providerStatuses[pKey] = {
          status: val.status,
          count: Array.isArray(val.results) ? val.results.length : 0,
          durationMs: val.durationMs || 0,
          error: val.error || null,
        };

        if (val.status === "success" && Array.isArray(val.results) && val.results.length > 0) {
          usedProviders.push(val.provider || pKey);

          if (pKey === "tavily") {
            // Extract structured claims from retrieved Tavily web results using Gemini with bounded retry
            let extracted = [];
            if (apiKey) {
              const extractionStart = Date.now();
              try {
                extracted = await geminiProvider.synthesizeWebResults(val.results, filters, apiKey);
              } catch (err) {
                console.warn("[DiscoveryService] Gemini extraction error:", err.message);
              }
              timings.extractionMs = Date.now() - extractionStart;
            }

            if (Array.isArray(extracted) && extracted.length > 0) {
              rawCandidates.push(...extracted);
            } else {
              // Direct mapping of Tavily live search citations if AI extraction is unavailable or produced 0 items
              const mapped = val.results
                .map((r) => {
                  const titleClean = (r.title || "").split(/[-|–:]/)[0]?.trim();
                  return {
                    companyName: titleClean,
                    website: r.url || "",
                    industry: filters.industry && filters.industry !== "All" ? filters.industry : null,
                    description: r.content || r.snippet || null,
                    location: null,
                    city: filters.city && filters.city !== "All" ? filters.city : null,
                    phone: null,
                    email: null,
                    decisionMaker: null,
                    founders: [],
                    sources: [{ url: r.url, field: "companyName", accessedAt: new Date().toISOString(), provider: "Tavily" }],
                    sourceUrl: r.url,
                    source: "Tavily Web Search",
                    confidenceScore: 75,
                    matchReasons: ["Direct live web citation from Tavily search index"],
                    retrievedAt: new Date().toISOString(),
                  };
                })
                .filter((r) => r.companyName && !/^(top \d+|companies in|list of|directory|pharmaceutical manufacturing companies)/i.test(r.companyName));
              rawCandidates.push(...mapped);
            }
          } else if (pKey === "openStreetMap") {
            // OSM candidates are already strictly grounded in actual OSM node/way data
            rawCandidates.push(...val.results);
          }
        }
      }
    }

    // 2. Format, verify fields, and deduplicate by normalized domain and company identity
    const reconciled = [];
    const seenProspectKeys = new Map(); // key -> reconciled index
    const seenDomains = new Map(); // domain -> reconciled index

    for (const item of rawCandidates) {
      const compName = (item.companyName || "").trim();
      if (!compName) continue; // Reject any nameless candidates

      const rawPhone = item.phone || item.decisionMaker?.phone || "";
      const rawEmail = item.email || item.decisionMaker?.email || "";

      const verifiedPhone = rawPhone ? normalizeAndVerifyPhone(rawPhone) : null;
      const verifiedEmail = rawEmail ? await verifyEmail(rawEmail, true) : null;

      const normDomain = normalizeDomain(item.website || item.url || "");
      const retrievedAt = item.retrievedAt || new Date().toISOString();

      const itemSources = Array.isArray(item.sources) && item.sources.length > 0
        ? [...item.sources]
        : item.sourceUrl
        ? [{ url: item.sourceUrl, field: "companyName", accessedAt: retrievedAt, provider: item.source || "Live Search" }]
        : [];

      // Decision makers / founders: only preserve if an actual person name was returned
      const decisionMakerName = (item.decisionMaker?.name || "").trim();
      const founders = [];
      if (Array.isArray(item.founders) && item.founders.length > 0) {
        for (const f of item.founders) {
          if (f && f.name && f.name.trim()) {
            founders.push({
              name: f.name.trim(),
              title: f.title || null,
              designation: f.designation || f.title || null,
              email: f.email || null,
              phone: f.phone || null,
              verificationStatus: "unknown",
            });
          }
        }
      } else if (decisionMakerName && !/executive|office|commercial|business|director of operations/i.test(decisionMakerName)) {
        founders.push({
          name: decisionMakerName,
          title: item.decisionMaker?.title || null,
          designation: item.decisionMaker?.title || null,
          email: item.decisionMaker?.email || null,
          phone: item.decisionMaker?.phone || null,
          verificationStatus: "unknown",
        });
      }

      const formattedItem = {
        companyName: compName,
        website: item.website || item.url || "",
        normalizedDomain: normDomain,
        // Only return factual field if present in source evidence; never generic fallback
        industry: item.industry || null,
        description: item.description || null,
        location: {
          locality: item.location?.locality || "",
          city: item.city || item.location?.city || null,
          state: item.state || item.location?.state || null,
          country: item.country || "India",
          raw: item.location?.raw || (typeof item.location === "string" ? item.location : null),
        },
        founders,
        contact: {
          businessPhone: verifiedPhone?.normalized || (verifiedPhone?.isValidFormat ? verifiedPhone.phone : null),
          phoneType: verifiedPhone?.phoneType || "none",
          phoneVerificationStatus: verifiedPhone?.isValidFormat ? "unknown" : "Not Found",
          businessEmail: verifiedEmail?.isValidFormat ? verifiedEmail.email : null,
          emailType: verifiedEmail?.type || "none",
          emailVerificationStatus: verifiedEmail?.isValidFormat ? "unknown" : "Not Found",
          contactPage: item.contactPage || null,
        },
        // Score reflects evidence availability, not hard-coded generic 85
        confidenceScore: item.confidenceScore || (item.website && (verifiedPhone || verifiedEmail) ? 85 : 75),
        matchReasons: Array.isArray(item.matchReasons) && item.matchReasons.length > 0 ? item.matchReasons : [],
        source: item.source || "Live Search",
        sourceUrl: item.sourceUrl || itemSources[0]?.url || "",
        sources: itemSources,
        retrievedAt,
        cached: false,
      };

      formattedItem.prospectKey = computeProspectKey(formattedItem);

      // Deduplication check: match by prospectKey or normalized domain
      let existingIndex = seenProspectKeys.get(formattedItem.prospectKey);
      if (existingIndex === undefined && normDomain) {
        existingIndex = seenDomains.get(normDomain);
      }

      if (existingIndex !== undefined) {
        // Merge sources and missing fields into existing prospect
        const existing = reconciled[existingIndex];
        if (!existing.website && formattedItem.website) existing.website = formattedItem.website;
        if (!existing.contact.businessPhone && formattedItem.contact.businessPhone) {
          existing.contact.businessPhone = formattedItem.contact.businessPhone;
          existing.contact.phoneType = formattedItem.contact.phoneType;
          existing.contact.phoneVerificationStatus = formattedItem.contact.phoneVerificationStatus;
        }
        if (!existing.contact.businessEmail && formattedItem.contact.businessEmail) {
          existing.contact.businessEmail = formattedItem.contact.businessEmail;
          existing.contact.emailType = formattedItem.contact.emailType;
          existing.contact.emailVerificationStatus = formattedItem.contact.emailVerificationStatus;
        }
        if (existing.founders.length === 0 && formattedItem.founders.length > 0) {
          existing.founders = formattedItem.founders;
        }
        // Merge sources avoiding duplicate URLs
        for (const s of formattedItem.sources) {
          if (!existing.sources.some((es) => es.url === s.url && es.field === s.field)) {
            existing.sources.push(s);
          }
        }
      } else {
        const newIndex = reconciled.length;
        reconciled.push(formattedItem);
        seenProspectKeys.set(formattedItem.prospectKey, newIndex);
        if (normDomain) {
          seenDomains.set(normDomain, newIndex);
        }
      }
    }

    // 3. Targeted Resolution Lookup: query ONLY the returned prospect keys & company names
    if (organizationId && ResolvedModel && reconciled.length > 0) {
      const resolutionStart = Date.now();
      try {
        const candidateKeys = reconciled.map((r) => r.prospectKey).filter(Boolean);
        const candidateNames = reconciled.map((r) => r.companyName.trim()).filter(Boolean);

        const resolvedDocs = await ResolvedModel.find({
          organization: organizationId,
          $or: [
            { prospectKey: { $in: candidateKeys } },
            { companyName: { $in: candidateNames } },
          ],
        }).select("prospectKey companyName resolvedAt resolvedByName notes");

        const resolvedKeyMap = new Map();
        const resolvedNameMap = new Map();

        resolvedDocs.forEach((r) => {
          if (r.prospectKey) resolvedKeyMap.set(r.prospectKey, r);
          if (r.companyName) resolvedNameMap.set(r.companyName.toLowerCase().trim(), r);
        });

        reconciled.forEach((item) => {
          const match =
            resolvedKeyMap.get(item.prospectKey) ||
            resolvedNameMap.get(item.companyName.toLowerCase().trim());
          if (match) {
            item.isResolved = true;
            item.resolvedAt = match.resolvedAt;
            item.resolvedByName = match.resolvedByName || "Team Member";
            item.resolvedNotes = match.notes || "";
          } else {
            item.isResolved = false;
          }
        });
      } catch (rErr) {
        console.warn("[DiscoveryService] Resolution check warning:", rErr.message);
      } finally {
        timings.resolutionLookupMs = Date.now() - resolutionStart;
      }
    } else {
      reconciled.forEach((item) => {
        item.isResolved = false;
      });
    }

    // 4. Record Provider Usage
    if (organizationId && ProviderUsageModel) {
      const today = new Date().toISOString().split("T")[0];
      for (const providerName of usedProviders) {
        try {
          await ProviderUsageModel.findOneAndUpdate(
            { organizationId, provider: providerName, date: today },
            { $inc: { requests: 1, creditsUsed: 1 } },
            { upsert: true }
          );
        } catch {}
      }
    }

    timings.totalMs = Date.now() - overallStart;

    // 5. Determine high-level outcome state
    const allProvidersFailed = Object.values(providerStatuses).every(
      (ps) => ps.status === "error" || ps.status === "timeout" || ps.status === "unconfigured"
    );
    const hasAnySuccess = Object.values(providerStatuses).some((ps) => ps.status === "success");
    const hasAnyFailure = Object.values(providerStatuses).some(
      (ps) => ps.status === "error" || ps.status === "timeout"
    );

    let outcome = "success";
    if (allProvidersFailed) {
      outcome = "all_providers_failed";
    } else if (hasAnyFailure && hasAnySuccess) {
      outcome = "partial_failure";
    } else if (reconciled.length === 0) {
      outcome = "no_matches";
    }

    return {
      companies: reconciled,
      totalCount: reconciled.length,
      usedProviders,
      providerStatuses,
      outcome,
      timings,
    };
  }
}

export const discoveryService = new DiscoveryService();
export default discoveryService;
