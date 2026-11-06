import TavilySearchProvider from "./providers/tavilyProvider.js";
import OsmSearchProvider from "./providers/osmProvider.js";
import GeminiSearchProvider from "./providers/geminiProvider.js";
import rapidApiScraperProvider from "./providers/rapidApiScraperProvider.js";
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
   * 1. Searches target businesses & official websites
   * 2. Excludes already-resolved businesses from search results
   * 3. Scrapes verified contact details (phones, emails, socials) via RapidAPI
   */
  async discoverBusinesses(filters, context = {}) {
    const { apiKey, tavilyKey, organizationId, tenantModels = {} } = context;
    const { ResolvedModel, ProviderUsageModel } = tenantModels;

    const timings = {
      totalMs: 0,
      providerSearchMs: 0,
      extractionMs: 0,
      contactScrapingMs: 0,
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
      rapidApi: {
        status: rapidApiScraperProvider.isConfigured() ? "pending" : "unconfigured",
        count: 0,
        durationMs: 0,
        error: rapidApiScraperProvider.isConfigured() ? null : "RAPIDAPI_KEY not configured in .env",
      },
    };

    // 0. Pre-fetch all resolved prospect keys & domains for this organization
    const resolvedKeysSet = new Set();
    const resolvedDomainsSet = new Set();
    const resolvedNamesSet = new Set();

    if (organizationId && ResolvedModel && (ResolvedModel.db?.readyState === 1 || !ResolvedModel.db)) {
      const resStart = Date.now();
      try {
        const allResolved = await ResolvedModel.find({ organization: organizationId })
          .select("prospectKey companyName website")
          .lean();
        if (Array.isArray(allResolved)) {
          allResolved.forEach((r) => {
            if (r.prospectKey) resolvedKeysSet.add(r.prospectKey);
            if (r.companyName) resolvedNamesSet.add(r.companyName.toLowerCase().trim());
            const d = normalizeDomain(r.website || "");
            if (d) resolvedDomainsSet.add(d);
          });
        }
      } catch (rErr) {
        console.warn("[DiscoveryService] Fetch resolved history warning:", rErr.message);
      } finally {
        timings.resolutionLookupMs = Date.now() - resStart;
      }
    }

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
            rawCandidates.push(...val.results);
          }
        }
      }
    }

    // 2. Format, deduplicate, and EXCLUDE previously resolved businesses
    const reconciled = [];
    const seenProspectKeys = new Map(); // key -> reconciled index
    const seenDomains = new Map(); // domain -> reconciled index
    let excludedResolvedCount = 0;

    for (const item of rawCandidates) {
      const compName = (item.companyName || "").trim();
      if (!compName) continue; // Reject any nameless candidates

      const normDomain = normalizeDomain(item.website || item.url || "");
      const tempKey = computeProspectKey({
        companyName: compName,
        website: item.website || item.url || "",
        location: item.location,
        city: item.city,
      });

      // CHECK RESOLVED STATUS: Exclude from current search results so they are not shown again
      const isAlreadyResolved =
        resolvedKeysSet.has(tempKey) ||
        (normDomain && resolvedDomainsSet.has(normDomain)) ||
        resolvedNamesSet.has(compName.toLowerCase());

      if (isAlreadyResolved) {
        excludedResolvedCount++;
        continue; // Keep in history and do not show in next search!
      }

      const rawPhone = item.phone || item.decisionMaker?.phone || "";
      const rawEmail = item.email || item.decisionMaker?.email || "";

      const verifiedPhone = rawPhone ? normalizeAndVerifyPhone(rawPhone) : null;
      const verifiedEmail = rawEmail ? await verifyEmail(rawEmail, true) : null;
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
          allPhones: [],
          allEmails: [],
        },
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
        confidenceScore: item.confidenceScore || (item.website && (verifiedPhone || verifiedEmail) ? 85 : 75),
        matchReasons: Array.isArray(item.matchReasons) && item.matchReasons.length > 0 ? item.matchReasons : [],
        source: item.source || "Live Search",
        sourceUrl: item.sourceUrl || itemSources[0]?.url || "",
        sources: itemSources,
        retrievedAt,
        cached: false,
        isResolved: false,
      };

      formattedItem.prospectKey = computeProspectKey(formattedItem);

      // Deduplication check: match by prospectKey or normalized domain
      let existingIndex = seenProspectKeys.get(formattedItem.prospectKey);
      if (existingIndex === undefined && normDomain) {
        existingIndex = seenDomains.get(normDomain);
      }

      if (existingIndex !== undefined) {
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

    // 3. Contact Details Extraction via RapidAPI Website Contacts Scraper
    if (rapidApiScraperProvider.isConfigured() && reconciled.length > 0) {
      const contactStart = Date.now();
      const concurrency = 4;
      let enrichedCount = 0;

      for (let i = 0; i < reconciled.length; i += concurrency) {
        const batch = reconciled.slice(i, i + concurrency);
        await Promise.all(
          batch.map(async (company) => {
            const targetUrl = company.website;
            if (!targetUrl) return;

            try {
              const scraped = await rapidApiScraperProvider.fetchWebsiteContacts(targetUrl);
              if (scraped.success) {
                // Phone numbers
                if (scraped.primaryPhone) {
                  company.contact.businessPhone = scraped.primaryPhone;
                  company.contact.phoneType = scraped.phoneType;
                  company.contact.phoneVerificationStatus = "Verified";
                }
                if (Array.isArray(scraped.allPhones) && scraped.allPhones.length > 0) {
                  company.contact.allPhones = scraped.allPhones;
                }

                // Emails
                if (scraped.primaryEmail) {
                  company.contact.businessEmail = scraped.primaryEmail;
                  company.contact.emailType = scraped.emailType;
                  company.contact.emailVerificationStatus = "Verified";
                }
                if (Array.isArray(scraped.allEmails) && scraped.allEmails.length > 0) {
                  company.contact.allEmails = scraped.allEmails;
                }

                // Social Links
                if (scraped.socialLinks) {
                  company.socialLinks = {
                    ...company.socialLinks,
                    ...scraped.socialLinks,
                  };
                }

                // Tech stack
                if (Array.isArray(scraped.technologies) && scraped.technologies.length > 0) {
                  company.technologies = scraped.technologies;
                }

                // Description backfill
                if (scraped.description && (!company.description || company.description.length < 20)) {
                  company.description = scraped.description;
                }

                // Add source
                if (Array.isArray(scraped.sources)) {
                  company.sources.push(...scraped.sources);
                }

                // Confidence scoring
                const hasContact = Boolean(company.contact.businessPhone || company.contact.businessEmail);
                const hasSocials = Boolean(
                  company.socialLinks.linkedin ||
                  company.socialLinks.twitter ||
                  company.socialLinks.facebook ||
                  company.socialLinks.instagram ||
                  company.socialLinks.whatsapp
                );

                if (hasContact && hasSocials) {
                  company.confidenceScore = 95;
                } else if (hasContact) {
                  company.confidenceScore = 90;
                } else {
                  company.confidenceScore = 80;
                }

                enrichedCount++;
              }
            } catch (err) {
              console.warn(`[DiscoveryService] RapidAPI contact scraping error for ${targetUrl}:`, err.message);
            }
          })
        );
      }

      timings.contactScrapingMs = Date.now() - contactStart;
      usedProviders.push("RapidAPI Contacts Scraper");
      providerStatuses.rapidApi = {
        status: "success",
        count: enrichedCount,
        durationMs: timings.contactScrapingMs,
        error: null,
      };
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

    if (providerStatuses.rapidApi.status === "pending") {
      providerStatuses.rapidApi.status = "idle";
    }

    // 5. Determine high-level outcome state based on live discovery providers
    const searchProviders = [providerStatuses.tavily, providerStatuses.openStreetMap];
    const allProvidersFailed = searchProviders.every(
      (ps) => ps.status === "error" || ps.status === "timeout" || ps.status === "unconfigured"
    );
    const hasAnySuccess = searchProviders.some((ps) => ps.status === "success");
    const hasAnyFailure = searchProviders.some(
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
      excludedResolvedCount,
      usedProviders,
      providerStatuses,
      outcome,
      timings,
    };
  }
}

export const discoveryService = new DiscoveryService();
export default discoveryService;
