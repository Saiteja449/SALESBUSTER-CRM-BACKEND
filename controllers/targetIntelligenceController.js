import mongoose from "mongoose";
import xlsx from "xlsx";
import asyncHandler from "../utils/asyncHandler.js";
import { getTenantScope } from "../utils/tenantScope.js";
import { sendSuccess } from "../utils/responseHandler.js";
import { NotFoundError, BadRequestError } from "../utils/AppError.js";
import { decryptApiKey } from "../utils/encryption.js";
import {
  discoveryService,
  computeProspectKey,
} from "../services/targetIntelligence/discoveryService.js";
import rapidApiScraperProvider from "../services/targetIntelligence/providers/rapidApiScraperProvider.js";
import { enrichCompanyWebsite } from "../services/targetIntelligence/enrichmentService.js";
import {
  getMonthlyQuotaService,
  saveSearchAndCacheCompaniesService,
  resolveProspectCoreService,
  unresolveProspectCoreService,
  queryTargetListsService,
  createTargetListService,
  updateTargetListService,
  deleteTargetListService,
} from "../services/targetIntelligenceService.js";

/**
 * Resolve active Gemini API key from organization settings or environment
 */
export function resolveGeminiKey(req) {
  const orgKey = req.organization?.aiSettings?.geminiApiKey;
  if (orgKey && typeof orgKey === "string" && orgKey.trim().length > 5) {
    try {
      const decrypted = decryptApiKey(orgKey.trim());
      if (decrypted && decrypted.trim().length > 5) {
        return decrypted.trim();
      }
    } catch {
      if (orgKey.startsWith("AIza")) {
        return orgKey.trim();
      }
    }
  }
  if (process.env.GEMINI_API_KEY) {
    return process.env.GEMINI_API_KEY.trim();
  }
  return null;
}

/**
 * Resolve active Tavily API key from organization settings or environment
 */
export function resolveTavilyKey(req) {
  const orgKey = req?.organization?.aiSettings?.tavilyApiKey;
  if (orgKey && typeof orgKey === "string" && orgKey.trim().length > 5) {
    try {
      const decrypted = decryptApiKey(orgKey.trim());
      if (decrypted && decrypted.trim().length > 5) {
        return decrypted.trim();
      }
    } catch {
      if (orgKey.startsWith("tvly-")) {
        return orgKey.trim();
      }
    }
  }
  if (process.env.TAVILY_API_KEY) {
    return process.env.TAVILY_API_KEY.trim();
  }
  return null;
}

// @desc    Get Target Intelligence Usage & Monthly Quota
// @route   GET /api/target-intelligence/quota
export const getQuota = asyncHandler(async (req, res) => {
  const { tenantModels } = getTenantScope(req);
  const data = await getMonthlyQuotaService({
    tenantModels,
    organization: req.organization,
  });

  return sendSuccess(res, { data });
});

// @desc    Interpret Natural Language Prompt with AI
// @route   POST /api/target-intelligence/interpret-prompt
export const interpretPrompt = asyncHandler(async (req, res) => {
  const { prompt } = req.body;
  const apiKey = resolveGeminiKey(req);
  const parsed = await discoveryService.interpretPrompt(prompt.trim(), apiKey);

  return sendSuccess(res, {
    data: parsed || {
      city: "All",
      state: "",
      country: "India",
      industry: "",
      need: "",
      decisionMakerRoles: ["Founder", "CEO", "Managing Director"],
    },
  });
});

// @desc    Execute Business Discovery Search across Multiple Sources
// @route   POST /api/target-intelligence/search
export const searchProspects = asyncHandler(async (req, res) => {
  const startTime = Date.now();
  const { tenantModels, organizationId, userId } = getTenantScope(req);
  const {
    prompt,
    city,
    industry,
    need,
    roles,
    searchType = "all",
    limit,
  } = req.body;

  // Enforce monthly credit cap (default 100/month)
  const currentQuota = await getMonthlyQuotaService({
    tenantModels,
    organization: req.organization,
  });
  if (
    currentQuota.searchesLimit &&
    currentQuota.searchesUsedThisMonth >= currentQuota.searchesLimit
  ) {
    return res.status(429).json({
      success: false,
      message: `Monthly Target Intelligence credit limit (${currentQuota.searchesUsedThisMonth}/${currentQuota.searchesLimit}) reached. Credits reset on ${currentQuota.resetDate}.`,
      data: {
        quota: currentQuota,
      },
    });
  }

  const apiKey = resolveGeminiKey(req);
  const tavilyKey = resolveTavilyKey(req);

  const filters = {
    prompt: (prompt || "").trim(),
    city: city || "All",
    industry: industry || "",
    need: need || "",
    roles: Array.isArray(roles) ? roles : [],
    searchType,
    limit: limit ? parseInt(limit, 10) : 10,
  };

  const discoveryResult = await discoveryService.discoverBusinesses(filters, {
    apiKey,
    tavilyKey,
    organizationId,
    tenantModels,
  });

  const durationMs = Date.now() - startTime;
  const companies = discoveryResult.companies || [];

  if (discoveryResult.outcome === "all_providers_failed") {
    return res.status(502).json({
      success: false,
      message: "All live search providers failed or are unavailable. Please check provider connectivity or API keys.",
      data: {
        totalCount: 0,
        prospects: [],
        creditsDeducted: 0,
        quota: currentQuota,
        searchProviders: discoveryResult.usedProviders,
        providerStatuses: discoveryResult.providerStatuses,
        outcome: discoveryResult.outcome,
        timings: discoveryResult.timings,
        durationMs,
        executedAt: new Date().toISOString(),
      },
    });
  }

  const { searchRecord, creditsDeducted } = await saveSearchAndCacheCompaniesService({
    tenantModels,
    organizationId,
    userId,
    filters,
    discoveryResult,
    durationMs,
  });

  const updatedQuota = await getMonthlyQuotaService({
    tenantModels,
    organization: req.organization,
  });

  return sendSuccess(res, {
    data: {
      searchId: searchRecord ? searchRecord._id.toString() : `ti-search-${Date.now()}`,
      totalCount: companies.length,
      excludedResolvedCount: discoveryResult.excludedResolvedCount || 0,
      creditsDeducted,
      quota: updatedQuota,
      prospects: companies,
      searchProviders: discoveryResult.usedProviders,
      providerStatuses: discoveryResult.providerStatuses,
      outcome: discoveryResult.outcome,
      timings: discoveryResult.timings,
      durationMs,
      executedAt: new Date().toISOString(),
    },
  });
});

// @desc    Get Search History
// @route   GET /api/target-intelligence/searches
export const getSearches = asyncHandler(async (req, res) => {
  const { tenantModels, organizationId } = getTenantScope(req);
  const { TargetSearch } = tenantModels;
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;

  const searches = TargetSearch
    ? await TargetSearch.find({ organizationId }).sort({ createdAt: -1 }).limit(limit).lean()
    : [];

  return sendSuccess(res, { data: searches });
});

// @desc    Get Discovered Companies
// @route   GET /api/target-intelligence/companies
export const getCompanies = asyncHandler(async (req, res) => {
  const { tenantModels, organizationId } = getTenantScope(req);
  const { TargetCompany } = tenantModels;
  const { city, industry, search, isResolved, page = 1, limit = 20 } = req.query;

  const filter = { organizationId };
  if (city && city !== "All") filter["location.city"] = new RegExp(`^${city}$`, "i");
  if (industry && industry !== "All") filter.industry = new RegExp(industry, "i");
  if (isResolved !== undefined) filter.isResolved = isResolved === "true";
  if (search) {
    const rx = new RegExp(search.trim(), "i");
    filter.$or = [{ companyName: rx }, { website: rx }, { description: rx }];
  }

  const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
  const [companies, total] = TargetCompany
    ? await Promise.all([
        TargetCompany.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit, 10)).lean(),
        TargetCompany.countDocuments(filter),
      ])
    : [[], 0];

  return sendSuccess(res, {
    data: {
      companies,
      pagination: {
        total,
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        pages: Math.ceil(total / parseInt(limit, 10)),
      },
    },
  });
});

// @desc    Get Company by ID
// @route   GET /api/target-intelligence/companies/:id
export const getCompanyById = asyncHandler(async (req, res) => {
  const { tenantModels, organizationId } = getTenantScope(req);
  const { TargetCompany, TargetContact } = tenantModels;

  const company = TargetCompany
    ? await TargetCompany.findOne({ _id: req.params.id, organizationId }).lean()
    : null;

  if (!company) {
    throw new NotFoundError("Company not found");
  }

  const contacts = TargetContact
    ? await TargetContact.find({ companyId: req.params.id, organizationId }).lean()
    : [];

  return sendSuccess(res, { data: { ...company, contacts } });
});

// @desc    Enrich Company Website
// @route   POST /api/target-intelligence/companies/:id/enrich
export const enrichCompany = asyncHandler(async (req, res) => {
  const { tenantModels, organizationId } = getTenantScope(req);
  const { TargetCompany } = tenantModels;

  const company = TargetCompany
    ? await TargetCompany.findOne({ _id: req.params.id, organizationId })
    : null;

  if (!company) {
    throw new NotFoundError("Company not found");
  }

  if (!company.website) {
    throw new BadRequestError("Company does not have a website to enrich");
  }

  const tavilyKey = resolveTavilyKey(req);
  const enriched = await enrichCompanyWebsite(company.website, {
    companyName: company.companyName,
    tavilyKey,
  });

  if (enriched) {
    if (enriched.description && (!company.description || company.description.length < 50)) {
      company.description = enriched.description;
    }
    if (enriched.industry && !company.industry) company.industry = enriched.industry;
    if (enriched.contact) {
      company.contact = { ...(company.contact || {}), ...enriched.contact };
    }
    if (enriched.technologies?.length) {
      company.technologies = Array.from(new Set([...(company.technologies || []), ...enriched.technologies]));
    }
    company.enrichmentStatus = "completed";
    company.enrichedAt = new Date();
    await company.save();
  }

  return sendSuccess(res, {
    data: company,
    message: "Company enriched successfully",
  });
});

// @desc    Mark a Prospect as Resolved
// @route   POST /api/target-intelligence/resolve
export const resolveProspect = asyncHandler(async (req, res) => {
  const { tenantModels, organizationId } = getTenantScope(req);
  const { prospect, notes } = req.body;

  const result = await resolveProspectCoreService({
    tenantModels,
    organizationId,
    prospect,
    notes,
    user: req.user,
  });

  return sendSuccess(res, {
    data: result,
    message: "Prospect marked as resolved successfully",
  });
});

// @desc    Unresolve a Prospect
// @route   POST /api/target-intelligence/unresolve
export const unresolveProspect = asyncHandler(async (req, res) => {
  const { tenantModels, organizationId } = getTenantScope(req);
  const { prospectKey, companyId } = req.body;

  const result = await unresolveProspectCoreService({
    tenantModels,
    organizationId,
    prospectKey,
    companyId,
  });

  return sendSuccess(res, {
    data: result,
    message: "Prospect marked as unresolved successfully",
  });
});

// @desc    Bulk Resolve Prospects
// @route   POST /api/target-intelligence/bulk-resolve
export const bulkResolveProspects = asyncHandler(async (req, res) => {
  const { tenantModels, organizationId } = getTenantScope(req);
  const { prospects, notes } = req.body;

  let resolvedCount = 0;
  for (const p of prospects) {
    if (!p.companyName) continue;
    try {
      await resolveProspectCoreService({
        tenantModels,
        organizationId,
        prospect: p,
        notes,
        user: req.user,
      });
      resolvedCount++;
    } catch (_) {}
  }

  return sendSuccess(res, {
    data: { resolvedCount, totalSubmitted: prospects.length },
    message: `Successfully resolved ${resolvedCount} prospects`,
  });
});

// @desc    Get All Resolved Prospects
// @route   GET /api/target-intelligence/resolved-list
export const getResolvedProspects = asyncHandler(async (req, res) => {
  const { tenantModels, organizationId } = getTenantScope(req);
  const { ResolvedProspect } = tenantModels;

  const list = ResolvedProspect
    ? await ResolvedProspect.find({ organizationId }).sort({ resolvedAt: -1 }).lean()
    : [];

  return sendSuccess(res, { data: list });
});

// @desc    Export Discovered Prospects to Excel (.xlsx) or CSV
// @route   POST /api/target-intelligence/export
export const exportProspects = asyncHandler(async (req, res) => {
  const { prospects, format = "xlsx" } = req.body;

  const rows = prospects.map((p, idx) => ({
    "S.No": idx + 1,
    "Company Name": p.companyName || "",
    "Website": p.website || "",
    "Industry": p.industry || "",
    "City": p.location?.city || p.city || "",
    "State": p.location?.state || "",
    "Location": p.location?.raw || p.location?.city || "",
    "Decision Maker": p.founders?.[0]?.name || p.decisionMaker?.name || "",
    "Designation": p.founders?.[0]?.title || p.decisionMaker?.title || "",
    "Business Phone": p.contact?.businessPhone || p.phone || "",
    "Business Email": p.contact?.businessEmail || p.email || "",
    "Contact Page": p.contact?.contactPage || "",
    "Confidence Score": `${p.confidenceScore || 80}%`,
    "Resolution Status": p.isResolved ? "Resolved" : "Unresolved",
    "Resolved At": p.resolvedAt ? new Date(p.resolvedAt).toLocaleDateString() : "",
    "Data Source": p.source || "Public Directory",
  }));

  const worksheet = xlsx.utils.json_to_sheet(rows);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "Target Intelligence");

  const buffer = xlsx.write(workbook, {
    type: "buffer",
    bookType: format === "csv" ? "csv" : "xlsx",
  });

  const filename = `Target_Intelligence_${Date.now()}.${format === "csv" ? "csv" : "xlsx"}`;
  res.setHeader(
    "Content-Type",
    format === "csv"
      ? "text/csv"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.status(200).send(buffer);
});

// @desc    Target Lists CRUD
export const getTargetLists = asyncHandler(async (req, res) => {
  const { tenantModels, organizationId } = getTenantScope(req);
  const lists = await queryTargetListsService({ tenantModels, organizationId });
  return sendSuccess(res, { data: lists });
});

export const createTargetList = asyncHandler(async (req, res) => {
  const { tenantModels, organizationId } = getTenantScope(req);
  const list = await createTargetListService({
    tenantModels,
    organizationId,
    user: req.user,
    data: req.body,
  });

  return sendSuccess(res, {
    statusCode: 201,
    data: list,
    message: "Target list created successfully",
  });
});

export const updateTargetList = asyncHandler(async (req, res) => {
  const { tenantModels, organizationId } = getTenantScope(req);
  const list = await updateTargetListService({
    tenantModels,
    organizationId,
    listId: req.params.id,
    data: req.body,
  });

  return sendSuccess(res, {
    data: list,
    message: "Target list updated successfully",
  });
});

export const deleteTargetList = asyncHandler(async (req, res) => {
  const { tenantModels, organizationId } = getTenantScope(req);
  const result = await deleteTargetListService({
    tenantModels,
    organizationId,
    listId: req.params.id,
  });

  return sendSuccess(res, {
    data: result,
    message: "Target list deleted successfully",
  });
});

// @desc    Get Provider Status
export const getProviderStatus = asyncHandler(async (req, res) => {
  const apiKey = resolveGeminiKey(req);
  const tavilyKey = resolveTavilyKey(req);

  return sendSuccess(res, {
    data: {
      gemini: {
        configured: Boolean(apiKey),
        model: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
      },
      tavily: {
        configured: Boolean(tavilyKey),
      },
      openStreetMap: {
        available: true,
        overpass: true,
      },
      duckDuckGo: {
        available: true,
      },
      mcaRegistry: {
        configured: true,
        available: true,
        source: "api.data.gov.in",
      },
      rapidApi: {
        configured: rapidApiScraperProvider.isConfigured(),
        host: rapidApiScraperProvider.host,
      },
    },
  });
});

export default {
  getQuota,
  interpretPrompt,
  searchProspects,
  getSearches,
  getCompanies,
  getCompanyById,
  enrichCompany,
  resolveProspect,
  unresolveProspect,
  bulkResolveProspects,
  getResolvedProspects,
  exportProspects,
  getTargetLists,
  createTargetList,
  updateTargetList,
  deleteTargetList,
  getProviderStatus,
};
