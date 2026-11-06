import mongoose from "mongoose";
import xlsx from "xlsx";
import TargetSearch from "../models/TargetSearch.js";
import TargetCompany from "../models/TargetCompany.js";
import TargetContact from "../models/TargetContact.js";
import TargetList from "../models/TargetList.js";
import ProviderUsage from "../models/ProviderUsage.js";
import ResolvedProspect from "../models/ResolvedProspect.js";
import User from "../models/User.js";
import { getIO } from "../socket/socket.js";
import { decryptApiKey } from "../utils/encryption.js";
import {
  discoveryService,
  computeProspectKey,
} from "../services/targetIntelligence/discoveryService.js";
import rapidApiScraperProvider from "../services/targetIntelligence/providers/rapidApiScraperProvider.js";
import { enrichCompanyWebsite } from "../services/targetIntelligence/enrichmentService.js";
import {
  verifyEmail,
  normalizeAndVerifyPhone,
  normalizeDomain,
} from "../services/targetIntelligence/verificationService.js";

/**
 * Helper to get tenant-scoped models with fallbacks
 */
const getModels = (req) => ({
  TargetSearchModel: req.tenantModels?.TargetSearch || TargetSearch,
  TargetCompanyModel: req.tenantModels?.TargetCompany || TargetCompany,
  TargetContactModel: req.tenantModels?.TargetContact || TargetContact,
  TargetListModel: req.tenantModels?.TargetList || TargetList,
  ProviderUsageModel: req.tenantModels?.ProviderUsage || ProviderUsage,
  ResolvedModel: req.tenantModels?.ResolvedProspect || ResolvedProspect,
  UserModel: req.tenantModels?.User || User,
});

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
export const getQuota = async (req, res) => {
  try {
    const org = req.organization;
    const { TargetSearchModel } = getModels(req);
    const orgId = org?._id;

    // Check if authoritative quota limit is configured on the organization
    const searchesLimit =
      typeof org?.targetIntelligenceQuota?.searchesLimit === "number"
        ? org.targetIntelligenceQuota.searchesLimit
        : null;
    const isConfigured = searchesLimit !== null;

    // Read actual search usage for current calendar month from TargetSearch records
    let searchesUsedThisMonth = 0;
    if (orgId && TargetSearchModel && TargetSearchModel.db?.readyState === 1) {
      const now = new Date();
      const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      searchesUsedThisMonth = await TargetSearchModel.countDocuments({
        organizationId: orgId,
        createdAt: { $gte: startOfMonth },
      });
    } else if (typeof org?.targetIntelligenceQuota?.searchesUsed === "number") {
      searchesUsedThisMonth = org.targetIntelligenceQuota.searchesUsed;
    }

    // Calculate dynamic reset date: 1st of next calendar month
    const now = new Date();
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const resetDate = nextMonth.toISOString().split("T")[0];

    res.status(200).json({
      success: true,
      data: {
        isConfigured,
        searchesUsedThisMonth,
        searchesLimit, // null if unconfigured
        resetDate: isConfigured ? resetDate : null,
      },
    });
  } catch (err) {
    console.error("[TargetIntelligence] getQuota error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch usage quota" });
  }
};

// @desc    Interpret Natural Language Prompt with AI (No employee count, No social media)
// @route   POST /api/target-intelligence/interpret-prompt
export const interpretPrompt = async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ success: false, message: "Prompt string is required" });
    }

    const apiKey = resolveGeminiKey(req);
    const parsed = await discoveryService.interpretPrompt(prompt.trim(), apiKey);

    res.status(200).json({
      success: true,
      data: parsed || {
        city: "All",
        state: "",
        country: "India",
        industry: "",
        need: "",
        decisionMakerRoles: ["Founder", "CEO", "Managing Director"],
      },
    });
  } catch (err) {
    console.error("[TargetIntelligence] interpretPrompt error:", err);
    res.status(500).json({ success: false, message: "Failed to interpret prompt" });
  }
};

// @desc    Execute Business Discovery Search across Multiple Sources
// @route   POST /api/target-intelligence/search
export const searchProspects = async (req, res) => {
  const startTime = Date.now();
  try {
    const {
      prompt,
      city,
      industry,
      need,
      roles,
      searchType = "all",
    } = req.body;

    const apiKey = resolveGeminiKey(req);
    const tavilyKey = resolveTavilyKey(req);
    const orgId = req.organization?._id;
    const userId = req.user?._id;
    const models = getModels(req);

    const filters = {
      prompt: (prompt || "").trim(),
      city: city || "All",
      industry: industry || "",
      need: need || "",
      roles: Array.isArray(roles) ? roles : [],
      searchType,
    };

    const discoveryResult = await discoveryService.discoverBusinesses(filters, {
      apiKey,
      tavilyKey,
      organizationId: orgId,
      tenantModels: models,
    });

    const durationMs = Date.now() - startTime;
    const companies = discoveryResult.companies || [];

    // Make provider failures visible: If all live providers failed or are unavailable, return an explicit 502
    if (discoveryResult.outcome === "all_providers_failed") {
      return res.status(502).json({
        success: false,
        message: "All live search providers failed or are unavailable. Please check provider connectivity or API keys.",
        data: {
          totalCount: 0,
          prospects: [],
          searchProviders: discoveryResult.usedProviders,
          providerStatuses: discoveryResult.providerStatuses,
          outcome: discoveryResult.outcome,
          timings: discoveryResult.timings,
          durationMs,
          executedAt: new Date().toISOString(),
        },
      });
    }

    // Persist TargetSearch Record
    let searchRecord = null;
    if (orgId && models.TargetSearchModel && (models.TargetSearchModel.db?.readyState === 1 || !models.TargetSearchModel.db)) {
      try {
        searchRecord = await models.TargetSearchModel.create({
          organizationId: orgId,
          userId: userId || null,
          originalPrompt: filters.prompt || `${filters.industry} in ${filters.city}`,
          extractedFilters: {
            industry: filters.industry,
            city: filters.city,
            need: filters.need,
            roles: filters.roles,
            searchType,
          },
          status: "completed",
          totalDiscovered: companies.length,
          totalMatched: companies.length,
          searchProviders: discoveryResult.usedProviders,
          durationMs,
        });

        // Upsert Discovered Companies into TargetCompany collection for persistent caching
        for (const c of companies) {
          try {
            await models.TargetCompanyModel.findOneAndUpdate(
              { organizationId: orgId, prospectKey: c.prospectKey },
              {
                organizationId: orgId,
                searchId: searchRecord._id,
                prospectKey: c.prospectKey,
                companyName: c.companyName,
                normalizedDomain: c.normalizedDomain,
                website: c.website,
                industry: c.industry,
                description: c.description,
                location: c.location,
                founders: c.founders,
                contact: c.contact,
                socialLinks: c.socialLinks || {},
                technologies: c.technologies || [],
                sources: c.sources || [],
                confidenceScore: c.confidenceScore,
                enrichmentStatus: "discovered",
                isResolved: Boolean(c.isResolved),
                resolvedAt: c.resolvedAt || null,
                resolvedByName: c.resolvedByName || "",
              },
              { upsert: true, new: true, setDefaultsOnInsert: true }
            );
          } catch {}
        }
      } catch (saveErr) {
        console.warn("[TargetIntelligence] Save search history warning:", saveErr.message);
      }
    }

    res.status(200).json({
      success: true,
      data: {
        searchId: searchRecord ? searchRecord._id.toString() : `ti-search-${Date.now()}`,
        totalCount: companies.length,
        excludedResolvedCount: discoveryResult.excludedResolvedCount || 0,
        prospects: companies,
        searchProviders: discoveryResult.usedProviders,
        providerStatuses: discoveryResult.providerStatuses,
        outcome: discoveryResult.outcome,
        timings: discoveryResult.timings,
        durationMs,
        executedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("[TargetIntelligence] searchProspects error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to execute business discovery search",
    });
  }
};

// @desc    Mark a Prospect as Resolved
// @route   POST /api/target-intelligence/resolve
export const resolveProspect = async (req, res) => {
  try {
    const { prospect, notes } = req.body;
    if (!prospect || typeof prospect !== "object") {
      return res.status(400).json({ success: false, message: "Prospect payload is required" });
    }

    const { ResolvedModel, TargetCompanyModel } = getModels(req);
    const orgId = req.organization?._id;
    if (!orgId) {
      return res.status(400).json({ success: false, message: "Organization context is missing" });
    }

    const key = prospect.prospectKey || computeProspectKey(prospect);
    const company = (prospect.companyName || prospect.name || "Company").trim();
    const person = (prospect.founders?.[0]?.name || prospect.decisionMaker?.name || "").trim();
    const title = (prospect.founders?.[0]?.title || prospect.decisionMaker?.title || "").trim();
    const email = (prospect.contact?.businessEmail || prospect.email || "").trim();
    const phone = (prospect.contact?.businessPhone || prospect.phone || "").trim();
    const website = (prospect.website || "").trim();
    const location = (prospect.location?.raw || prospect.location?.city || prospect.city || "").trim();
    const resolverName = req.user?.name || "Sales Manager";

    const record = await ResolvedModel.findOneAndUpdate(
      { organization: orgId, prospectKey: key },
      {
        organization: orgId,
        prospectKey: key,
        entityType: "company",
        companyName: company,
        personName: person,
        title,
        email,
        phone,
        website,
        linkedin: (prospect.socialLinks?.linkedin || prospect.linkedin || "").trim(),
        socialLinks: prospect.socialLinks || {},
        technologies: Array.isArray(prospect.technologies) ? prospect.technologies : [],
        location,
        resolvedBy: req.user?._id,
        resolvedByName: resolverName,
        resolvedAt: new Date(),
        notes: notes || "",
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Also update TargetCompany collection if present and database is connected
    if (TargetCompanyModel && TargetCompanyModel.db?.readyState === 1 && mongoose.Types.ObjectId.isValid(orgId)) {
      await TargetCompanyModel.updateMany(
        { organizationId: orgId, prospectKey: key },
        {
          isResolved: true,
          resolvedAt: record.resolvedAt,
          resolvedByName: resolverName,
          resolvedNotes: notes || "",
        }
      );
    }

    res.status(200).json({
      success: true,
      message: `"${company}" marked as resolved successfully`,
      data: {
        prospectKey: key,
        isResolved: true,
        resolvedAt: record.resolvedAt,
        resolvedByName: record.resolvedByName,
        resolvedNotes: record.notes,
      },
    });
  } catch (err) {
    console.error("[TargetIntelligence] resolveProspect error:", err);
    res.status(500).json({ success: false, message: "Failed to mark prospect as resolved" });
  }
};

// @desc    Unresolve a Prospect
// @route   POST /api/target-intelligence/unresolve
export const unresolveProspect = async (req, res) => {
  try {
    const { prospectKey, companyName } = req.body;
    const { ResolvedModel, TargetCompanyModel } = getModels(req);
    const orgId = req.organization?._id;

    if (!orgId) {
      return res.status(400).json({ success: false, message: "Organization context is missing" });
    }

    const filter = { organization: orgId };
    if (prospectKey) {
      filter.prospectKey = prospectKey;
    } else if (companyName) {
      filter.companyName = new RegExp("^" + companyName.trim() + "$", "i");
    } else {
      return res.status(400).json({ success: false, message: "prospectKey or companyName is required" });
    }

    await ResolvedModel.findOneAndDelete(filter);

    if (TargetCompanyModel && TargetCompanyModel.db?.readyState === 1 && prospectKey && mongoose.Types.ObjectId.isValid(orgId)) {
      await TargetCompanyModel.updateMany(
        { organizationId: orgId, prospectKey },
        { isResolved: false, resolvedAt: null, resolvedByName: "", resolvedNotes: "" }
      );
    }

    res.status(200).json({
      success: true,
      message: "Prospect resolution cleared",
      data: {
        prospectKey,
        isResolved: false,
      },
    });
  } catch (err) {
    console.error("[TargetIntelligence] unresolveProspect error:", err);
    res.status(500).json({ success: false, message: "Failed to clear resolution" });
  }
};

// @desc    Bulk Mark Multiple Prospects as Resolved
// @route   POST /api/target-intelligence/bulk-resolve
export const bulkResolveProspects = async (req, res) => {
  try {
    const { prospects, notes } = req.body;
    if (!Array.isArray(prospects) || prospects.length === 0) {
      return res.status(400).json({ success: false, message: "Array of prospects required" });
    }

    const { ResolvedModel, TargetCompanyModel } = getModels(req);
    const orgId = req.organization?._id;
    const resolverName = req.user?.name || "Sales Manager";
    const resolvedKeys = [];

    for (const p of prospects) {
      const key = p.prospectKey || computeProspectKey(p);
      const company = (p.companyName || p.name || "Company").trim();
      const person = (p.founders?.[0]?.name || p.decisionMaker?.name || "").trim();
      const title = (p.founders?.[0]?.title || p.decisionMaker?.title || "").trim();
      const email = (p.contact?.businessEmail || p.email || "").trim();
      const phone = (p.contact?.businessPhone || p.phone || "").trim();
      const website = (p.website || "").trim();
      const location = (p.location?.raw || p.location?.city || p.city || "").trim();

      await ResolvedModel.findOneAndUpdate(
        { organization: orgId, prospectKey: key },
        {
          organization: orgId,
          prospectKey: key,
          entityType: "company",
          companyName: company,
          personName: person,
          title,
          email,
          phone,
          website,
          linkedin: (p.socialLinks?.linkedin || p.linkedin || "").trim(),
          socialLinks: p.socialLinks || {},
          technologies: Array.isArray(p.technologies) ? p.technologies : [],
          location,
          resolvedBy: req.user?._id,
          resolvedByName: resolverName,
          resolvedAt: new Date(),
          notes: notes || "",
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      if (TargetCompanyModel && TargetCompanyModel.db?.readyState === 1 && mongoose.Types.ObjectId.isValid(orgId)) {
        await TargetCompanyModel.updateMany(
          { organizationId: orgId, prospectKey: key },
          {
            isResolved: true,
            resolvedAt: new Date(),
            resolvedByName: resolverName,
            resolvedNotes: notes || "",
          }
        );
      }

      resolvedKeys.push(key);
    }

    res.status(200).json({
      success: true,
      message: `Successfully marked ${resolvedKeys.length} prospects as resolved`,
      data: {
        resolvedCount: resolvedKeys.length,
        resolvedKeys,
      },
    });
  } catch (err) {
    console.error("[TargetIntelligence] bulkResolveProspects error:", err);
    res.status(500).json({ success: false, message: "Failed to bulk resolve prospects" });
  }
};

// @desc    Get List of All Resolved Prospects
// @route   GET /api/target-intelligence/resolved-list
export const getResolvedProspects = async (req, res) => {
  try {
    const { ResolvedModel } = getModels(req);
    const orgId = req.organization?._id;

    if (!orgId) {
      return res.status(400).json({ success: false, message: "Organization context is missing" });
    }

    const list = await ResolvedModel.find({ organization: orgId }).sort({ resolvedAt: -1 }).limit(300);

    res.status(200).json({
      success: true,
      data: list,
    });
  } catch (err) {
    console.error("[TargetIntelligence] getResolvedProspects error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch resolved prospects" });
  }
};

// @desc    Get Search History & Saved Searches
// @route   GET /api/target-intelligence/searches
export const getSearches = async (req, res) => {
  try {
    const { TargetSearchModel } = getModels(req);
    const orgId = req.organization?._id;

    const searches = await TargetSearchModel.find({ organizationId: orgId })
      .sort({ createdAt: -1 })
      .limit(50);

    res.status(200).json({
      success: true,
      data: searches,
    });
  } catch (err) {
    console.error("[TargetIntelligence] getSearches error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch searches" });
  }
};

// @desc    Get Discovered Companies with Filtering & Sorting
// @route   GET /api/target-intelligence/companies
export const getCompanies = async (req, res) => {
  try {
    const { TargetCompanyModel } = getModels(req);
    const orgId = req.organization?._id;
    const { search, city, industry, isResolved, page = 1, limit = 25 } = req.query;

    const filter = { organizationId: orgId };
    if (search) {
      filter.$or = [
        { companyName: new RegExp(search.trim(), "i") },
        { website: new RegExp(search.trim(), "i") },
      ];
    }
    if (city && city !== "All") {
      filter["location.city"] = new RegExp(city.trim(), "i");
    }
    if (industry && industry !== "All") {
      filter.industry = new RegExp(industry.trim(), "i");
    }
    if (isResolved === "true") {
      filter.isResolved = true;
    } else if (isResolved === "false") {
      filter.isResolved = false;
    }

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const [companies, total] = await Promise.all([
      TargetCompanyModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit, 10)),
      TargetCompanyModel.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: {
        companies,
        total,
        page: parseInt(page, 10),
        pages: Math.ceil(total / parseInt(limit, 10)),
      },
    });
  } catch (err) {
    console.error("[TargetIntelligence] getCompanies error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch companies" });
  }
};

// @desc    Get Full Details of a Single Company
// @route   GET /api/target-intelligence/companies/:id
export const getCompanyById = async (req, res) => {
  try {
    const { TargetCompanyModel, TargetContactModel } = getModels(req);
    const orgId = req.organization?._id;
    const { id } = req.params;

    const company = await TargetCompanyModel.findOne({ _id: id, organizationId: orgId });
    if (!company) {
      return res.status(404).json({ success: false, message: "Company not found" });
    }

    const contacts = await TargetContactModel.find({ companyId: company._id, organizationId: orgId });

    res.status(200).json({
      success: true,
      data: {
        ...company.toObject(),
        contacts,
      },
    });
  } catch (err) {
    console.error("[TargetIntelligence] getCompanyById error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch company details" });
  }
};

// @desc    Trigger On-Demand Website Enrichment for a Company
// @route   POST /api/target-intelligence/companies/:id/enrich
export const enrichCompany = async (req, res) => {
  try {
    const { TargetCompanyModel } = getModels(req);
    const orgId = req.organization?._id;
    const { id } = req.params;

    const company = await TargetCompanyModel.findOne({ _id: id, organizationId: orgId });
    if (!company) {
      return res.status(404).json({ success: false, message: "Company not found" });
    }

    if (!company.website) {
      return res.status(400).json({ success: false, message: "Company lacks website URL for enrichment" });
    }

    const apiKey = resolveGeminiKey(req);
    const enriched = await enrichCompanyWebsite(company.website, company.companyName, apiKey);

    // Update Company Record
    if (enriched.description && !company.description) {
      company.description = enriched.description;
    }
    if (enriched.businessPhone && !company.contact.businessPhone) {
      company.contact.businessPhone = enriched.businessPhone;
      company.contact.phoneType = enriched.phoneType;
      company.contact.phoneVerificationStatus = "unknown";
    }
    if (enriched.businessEmail && !company.contact.businessEmail) {
      company.contact.businessEmail = enriched.businessEmail;
      company.contact.emailType = enriched.emailType;
      company.contact.emailVerificationStatus = "unknown";
    }
    if (enriched.contactPageUrl) {
      company.contact.contactPage = enriched.contactPageUrl;
    }
    if (Array.isArray(enriched.decisionMakers) && enriched.decisionMakers.length > 0) {
      company.founders = enriched.decisionMakers;
    }
    if (Array.isArray(enriched.sources)) {
      company.sources.push(...enriched.sources);
    }
    company.enrichmentStatus = "enriched";
    company.confidenceScore = Math.max(company.confidenceScore, enriched.confidenceScore);

    await company.save();

    res.status(200).json({
      success: true,
      message: "Company enriched successfully",
      data: company,
    });
  } catch (err) {
    console.error("[TargetIntelligence] enrichCompany error:", err);
    res.status(500).json({ success: false, message: "Failed to enrich company" });
  }
};

// @desc    Export Discovered Prospects to Excel (.xlsx) or CSV
// @route   POST /api/target-intelligence/export
export const exportProspects = async (req, res) => {
  try {
    const { prospects, format = "xlsx" } = req.body;
    if (!Array.isArray(prospects) || prospects.length === 0) {
      return res.status(400).json({ success: false, message: "No prospects selected for export" });
    }

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
    res.status(200).send(buffer);
  } catch (err) {
    console.error("[TargetIntelligence] exportProspects error:", err);
    res.status(500).json({ success: false, message: "Failed to export data" });
  }
};

// @desc    Target Lists CRUD
// @route   GET, POST /api/target-intelligence/lists
export const getTargetLists = async (req, res) => {
  try {
    const { TargetListModel } = getModels(req);
    const orgId = req.organization?._id;

    const lists = await TargetListModel.find({ organizationId: orgId })
      .populate("companies", "companyName website industry location isResolved")
      .sort({ createdAt: -1 });

    res.status(200).json({ success: true, data: lists });
  } catch (err) {
    console.error("[TargetIntelligence] getTargetLists error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch target lists" });
  }
};

export const createTargetList = async (req, res) => {
  try {
    const { name, description, companyIds } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "List name is required" });
    }

    const { TargetListModel } = getModels(req);
    const orgId = req.organization?._id;

    const list = await TargetListModel.create({
      organizationId: orgId,
      name: name.trim(),
      description: (description || "").trim(),
      companies: Array.isArray(companyIds) ? companyIds : [],
      createdBy: req.user?._id,
    });

    res.status(201).json({ success: true, data: list });
  } catch (err) {
    console.error("[TargetIntelligence] createTargetList error:", err);
    res.status(500).json({ success: false, message: "Failed to create target list" });
  }
};

export const updateTargetList = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, companyIds, addCompanyId, removeCompanyId } = req.body;
    const { TargetListModel } = getModels(req);
    const orgId = req.organization?._id;

    const list = await TargetListModel.findOne({ _id: id, organizationId: orgId });
    if (!list) {
      return res.status(404).json({ success: false, message: "List not found" });
    }

    if (name) list.name = name.trim();
    if (description !== undefined) list.description = description.trim();
    if (Array.isArray(companyIds)) list.companies = companyIds;
    if (addCompanyId && !list.companies.includes(addCompanyId)) {
      list.companies.push(addCompanyId);
    }
    if (removeCompanyId) {
      list.companies = list.companies.filter((c) => c.toString() !== removeCompanyId.toString());
    }

    await list.save();
    res.status(200).json({ success: true, data: list });
  } catch (err) {
    console.error("[TargetIntelligence] updateTargetList error:", err);
    res.status(500).json({ success: false, message: "Failed to update target list" });
  }
};

export const deleteTargetList = async (req, res) => {
  try {
    const { id } = req.params;
    const { TargetListModel } = getModels(req);
    const orgId = req.organization?._id;

    await TargetListModel.findOneAndDelete({ _id: id, organizationId: orgId });
    res.status(200).json({ success: true, message: "Target list deleted" });
  } catch (err) {
    console.error("[TargetIntelligence] deleteTargetList error:", err);
    res.status(500).json({ success: false, message: "Failed to delete target list" });
  }
};

// @desc    Get Provider Status
// @route   GET /api/target-intelligence/providers/status
export const getProviderStatus = async (req, res) => {
  try {
    const apiKey = resolveGeminiKey(req);
    const tavilyKey = resolveTavilyKey(req);

    res.status(200).json({
      success: true,
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
        },
        rapidApi: {
          configured: rapidApiScraperProvider.isConfigured(),
          host: rapidApiScraperProvider.host,
        },
      },
    });
  } catch (err) {
    console.error("[TargetIntelligence] getProviderStatus error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch provider status" });
  }
};
