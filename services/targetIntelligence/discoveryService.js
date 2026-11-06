import TavilySearchProvider from "./providers/tavilyProvider.js";
import OsmSearchProvider from "./providers/osmProvider.js";
import GeminiSearchProvider from "./providers/geminiProvider.js";
import rapidApiScraperProvider from "./providers/rapidApiScraperProvider.js";
import { verifyEmail, normalizeAndVerifyPhone, normalizeDomain } from "./verificationService.js";

const tavilyProvider = new TavilySearchProvider();
const osmProvider = new OsmSearchProvider();
const geminiProvider = new GeminiSearchProvider();

/**
 * Known non-company domains (social networks, user-generated content, directories)
 * to exclude from becoming business prospect entries
 */
export const NON_COMPANY_DOMAINS = new Set([
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
  "medium.com",
  "wikipedia.org",
  "google.com",
  "yahoo.com",
  "bing.com",
  "duckduckgo.com",
  "threads.net",
  "sulekha.com",
  "justdial.com",
  "indiamart.com",
  "tradeindia.com",
  "smergers.com",
  "yellowpages.in",
  "indiaonline.in",
  "petbacker.com",
]);

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
    const { ResolvedModel, TargetCompanyModel, ProviderUsageModel } = tenantModels;

    const timings = {
      totalMs: 0,
      providerSearchMs: 0,
      extractionMs: 0,
      contactScrapingMs: 0,
      resolutionLookupMs: 0,
      mongoCacheLookupMs: 0,
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

    // 0. Pre-fetch all resolved prospect keys & domains for this organization from MongoDB
    const resolvedKeysSet = new Set();
    const resolvedDomainsSet = new Set();
    const resolvedNamesSet = new Set();

    if (organizationId) {
      const resStart = Date.now();
      try {
        // A. Check ResolvedProspect collection
        if (ResolvedModel && (ResolvedModel.db?.readyState === 1 || !ResolvedModel.db)) {
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
        }

        // B. Check TargetCompany collection for resolved records
        if (TargetCompanyModel && typeof TargetCompanyModel.find === "function" && (TargetCompanyModel.db?.readyState === 1 || !TargetCompanyModel.db)) {
          const tcQuery = TargetCompanyModel.find({
            organizationId,
            isResolved: true,
          });
          const resolvedCompanies = await (typeof tcQuery?.select === "function"
            ? tcQuery.select("prospectKey companyName website normalizedDomain").lean()
            : typeof tcQuery?.lean === "function"
            ? tcQuery.lean()
            : tcQuery);
          if (Array.isArray(resolvedCompanies)) {
            resolvedCompanies.forEach((r) => {
              if (r.prospectKey) resolvedKeysSet.add(r.prospectKey);
              if (r.companyName) resolvedNamesSet.add(r.companyName.toLowerCase().trim());
              const d = r.normalizedDomain || normalizeDomain(r.website || "");
              if (d) resolvedDomainsSet.add(d);
            });
          }
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
              rawCandidates.push(
                ...extracted.filter((item) => {
                  const d = normalizeDomain(item.website || item.sourceUrl || "");
                  return d && !NON_COMPANY_DOMAINS.has(d);
                })
              );
            } else {
              // Direct mapping of Tavily live search citations if AI extraction is unavailable or produced 0 items
              const mapped = val.results
                .map((r) => {
                  const normDomain = normalizeDomain(r.url || "");
                  if (!normDomain || NON_COMPANY_DOMAINS.has(normDomain)) return null;

                  const titleClean = (r.title || "")
                    .split(/[-|–:•]/)[0]
                    ?.replace(/\b(home|best|top|official website|welcome to|services|page)\b/gi, "")
                    ?.trim() || normDomain;

                  return {
                    companyName: titleClean,
                    website: `https://${normDomain}`,
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
                .filter(Boolean);
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
      if (normDomain && NON_COMPANY_DOMAINS.has(normDomain)) continue; // Skip non-company domains (social/search/directories)

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

    // Slice candidates to requested limit (default 10, max 50)
    const targetLimit = filters.limit ? Math.min(Math.max(parseInt(filters.limit, 10), 1), 50) : 10;
    const selectedCompanies = reconciled.slice(0, targetLimit);

    // 3. MongoDB Cache Lookup: Check if company contact & social data is already stored in MongoDB
    if (organizationId && TargetCompanyModel && (TargetCompanyModel.db?.readyState === 1 || !TargetCompanyModel.db) && selectedCompanies.length > 0) {
      const cacheStart = Date.now();
      try {
        const domainsToLookup = selectedCompanies.map((c) => c.normalizedDomain).filter(Boolean);
        const keysToLookup = selectedCompanies.map((c) => c.prospectKey).filter(Boolean);

        const cachedDocs = await TargetCompanyModel.find({
          organizationId,
          $or: [
            { prospectKey: { $in: keysToLookup } },
            { normalizedDomain: { $in: domainsToLookup } },
          ],
        }).lean();

        if (Array.isArray(cachedDocs) && cachedDocs.length > 0) {
          const cachedByKey = new Map();
          const cachedByDomain = new Map();
          for (const doc of cachedDocs) {
            if (doc.prospectKey) cachedByKey.set(doc.prospectKey, doc);
            if (doc.normalizedDomain) cachedByDomain.set(doc.normalizedDomain, doc);
          }

          for (const company of selectedCompanies) {
            const cached = cachedByKey.get(company.prospectKey) || cachedByDomain.get(company.normalizedDomain);
            if (cached && (cached.contact?.businessPhone || cached.contact?.businessEmail || cached.socialLinks?.linkedin || cached.socialLinks?.twitter || cached.socialLinks?.instagram || cached.socialLinks?.facebook || cached.socialLinks?.whatsapp)) {
              if (cached.contact?.businessPhone) {
                company.contact.businessPhone = cached.contact.businessPhone;
                company.contact.phoneType = cached.contact.phoneType || "none";
                company.contact.phoneVerificationStatus = cached.contact.phoneVerificationStatus || "Verified";
              }
              if (Array.isArray(cached.contact?.allPhones) && cached.contact.allPhones.length > 0) {
                company.contact.allPhones = cached.contact.allPhones;
              }
              if (cached.contact?.businessEmail) {
                company.contact.businessEmail = cached.contact.businessEmail;
                company.contact.emailType = cached.contact.emailType || "none";
                company.contact.emailVerificationStatus = cached.contact.emailVerificationStatus || "Verified";
              }
              if (Array.isArray(cached.contact?.allEmails) && cached.contact.allEmails.length > 0) {
                company.contact.allEmails = cached.contact.allEmails;
              }
              if (cached.socialLinks) {
                company.socialLinks = { ...company.socialLinks, ...cached.socialLinks };
              }
              if (Array.isArray(cached.technologies) && cached.technologies.length > 0) {
                company.technologies = cached.technologies;
              }
              if (cached.description && (!company.description || company.description.length < 20)) {
                company.description = cached.description;
              }
              if (cached.companyName && (!company.companyName || company.companyName.includes("."))) {
                company.companyName = cached.companyName;
              }
              company.cached = true;
              company.confidenceScore = cached.confidenceScore || 90;
            }
          }
        }
      } catch (cErr) {
        console.warn("[DiscoveryService] MongoDB cache lookup notice:", cErr.message);
      } finally {
        timings.mongoCacheLookupMs = Date.now() - cacheStart;
      }
    }

    // 4. Contact Details Extraction via RapidAPI Website Contacts Scraper
    // Only scrape candidates that are NOT cached from MongoDB and still need phone or email
    const companiesToScrape = selectedCompanies.filter(
      (c) => !c.cached && c.website && (!c.contact?.businessPhone || !c.contact?.businessEmail)
    );

    if (rapidApiScraperProvider.isConfigured() && companiesToScrape.length > 0) {
      const contactStart = Date.now();
      const concurrency = 4;
      let enrichedCount = 0;

      for (let i = 0; i < companiesToScrape.length; i += concurrency) {
        const batch = companiesToScrape.slice(i, i + concurrency);
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

                // Company name refinement from website metadata if current is raw domain
                if (scraped.companyName && (!company.companyName || company.companyName.includes(".") || company.companyName.length > 50)) {
                  company.companyName = scraped.companyName;
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
    } else if (rapidApiScraperProvider.isConfigured() && selectedCompanies.length > 0) {
      providerStatuses.rapidApi = {
        status: "idle",
        count: 0,
        durationMs: 0,
        error: null,
      };
    }

    // 5. Record Provider Usage
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

    // 6. Determine high-level outcome state based on live discovery providers
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
    } else if (selectedCompanies.length === 0) {
      outcome = "no_matches";
    }

    return {
      companies: selectedCompanies,
      totalCount: selectedCompanies.length,
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
