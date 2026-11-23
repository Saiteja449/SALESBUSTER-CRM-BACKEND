import mongoose from "mongoose";
import { NotFoundError, BadRequestError } from "../utils/AppError.js";

/**
 * Calculates current month search usage and limits for the organization.
 */
export const getMonthlyQuotaService = async ({ tenantModels, organization }) => {
  const { TargetSearch } = tenantModels;
  const orgId = organization?._id;

  const searchesLimit =
    typeof organization?.targetIntelligenceQuota?.searchesLimit === "number"
      ? organization.targetIntelligenceQuota.searchesLimit
      : null;
  const isConfigured = searchesLimit !== null;

  let searchesUsedThisMonth = 0;
  if (orgId && TargetSearch) {
    try {
      const now = new Date();
      const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      searchesUsedThisMonth = await TargetSearch.countDocuments({
        organizationId: orgId,
        createdAt: { $gte: startOfMonth },
      });
    } catch (_) {
      searchesUsedThisMonth = organization?.targetIntelligenceQuota?.searchesUsed || 0;
    }
  } else if (typeof organization?.targetIntelligenceQuota?.searchesUsed === "number") {
    searchesUsedThisMonth = organization.targetIntelligenceQuota.searchesUsed;
  }

  const now = new Date();
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const resetDate = nextMonth.toISOString().split("T")[0];

  return {
    isConfigured,
    searchesUsedThisMonth,
    searchesLimit,
    resetDate: isConfigured ? resetDate : null,
  };
};

/**
 * Persists search record and caches discovered companies in TargetCompany collection.
 */
export const saveSearchAndCacheCompaniesService = async ({
  tenantModels,
  organizationId,
  userId,
  filters,
  discoveryResult,
  durationMs,
}) => {
  const { TargetSearch, TargetCompany } = tenantModels;
  const companies = discoveryResult.companies || [];

  let searchRecord = null;
  const generatedSearchId = `ti_${new mongoose.Types.ObjectId().toString()}`;

  if (organizationId && TargetSearch) {
    try {
      searchRecord = await TargetSearch.create({
        searchId: generatedSearchId,
        organizationId,
        userId: userId || null,
        originalPrompt: filters.prompt || `${filters.industry} in ${filters.city}`,
        extractedFilters: {
          industry: filters.industry,
          city: filters.city,
          need: filters.need,
          roles: filters.roles,
          searchType: filters.searchType,
          limit: filters.limit,
        },
        status: "completed",
        totalDiscovered: companies.length,
        totalMatched: companies.length,
        searchProviders: discoveryResult.usedProviders,
        durationMs,
      });
    } catch (saveErr) {
      console.warn("[TargetIntelligenceService] Search save warning:", saveErr.message);
    }
  }

  if (organizationId && TargetCompany) {
    for (const c of companies) {
      if (!c.prospectKey) continue;
      try {
        await TargetCompany.findOneAndUpdate(
          { organizationId, prospectKey: c.prospectKey },
          {
            $set: {
              organizationId,
              searchId: searchRecord?._id || null,
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
            },
            $setOnInsert: {
              isResolved: false,
              resolvedAt: null,
              resolvedByName: "",
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      } catch (_) {}
    }
  }

  return searchRecord;
};

/**
 * Marks a single prospect as resolved in the tenant database.
 */
export const resolveProspectCoreService = async ({
  tenantModels,
  organizationId,
  prospect,
  notes = "",
  user = null,
}) => {
  const { TargetCompany, ResolvedProspect } = tenantModels;
  const prospectKey = prospect.prospectKey || `${prospect.companyName}_${prospect.website || 'nowebsite'}`.toLowerCase().replace(/[^a-z0-9]/g, "_");
  const resolvedByName = user?.name || "Sales Manager";
  const resolvedAt = new Date();

  let resolvedCompany = null;
  if (TargetCompany) {
    resolvedCompany = await TargetCompany.findOneAndUpdate(
      { organizationId, prospectKey },
      {
        $set: {
          organizationId,
          prospectKey,
          companyName: prospect.companyName,
          website: prospect.website || "",
          industry: prospect.industry || "",
          location: prospect.location || {},
          founders: prospect.founders || [],
          contact: prospect.contact || {},
          confidenceScore: prospect.confidenceScore || 80,
          isResolved: true,
          resolvedAt,
          resolvedByName,
          resolutionNotes: notes,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  if (ResolvedProspect) {
    try {
      await ResolvedProspect.findOneAndUpdate(
        { organizationId, prospectKey },
        {
          $set: {
            organizationId,
            prospectKey,
            companyName: prospect.companyName,
            domain: prospect.normalizedDomain || prospect.website || "",
            resolvedBy: user?._id || user?.id || null,
            resolvedByName,
            resolvedAt,
            notes,
          },
        },
        { upsert: true, new: true }
      );
    } catch (_) {}
  }

  return {
    prospectKey,
    isResolved: true,
    resolvedAt,
    resolvedByName,
    company: resolvedCompany,
  };
};

/**
 * Unmarks a resolved prospect.
 */
export const unresolveProspectCoreService = async ({
  tenantModels,
  organizationId,
  prospectKey = null,
  companyId = null,
}) => {
  const { TargetCompany, ResolvedProspect } = tenantModels;
  let targetKey = prospectKey;

  if (!targetKey && companyId && TargetCompany) {
    const comp = await TargetCompany.findById(companyId).select("prospectKey").lean();
    if (comp) targetKey = comp.prospectKey;
  }

  if (targetKey && TargetCompany) {
    await TargetCompany.updateOne(
      { organizationId, prospectKey: targetKey },
      {
        $set: {
          isResolved: false,
          resolvedAt: null,
          resolvedByName: "",
          resolutionNotes: "",
        },
      }
    );
  }

  if (targetKey && ResolvedProspect) {
    await ResolvedProspect.deleteOne({ organizationId, prospectKey: targetKey });
  }

  return {
    prospectKey: targetKey,
    isResolved: false,
  };
};

/**
 * Target Lists Management
 */
export const queryTargetListsService = async ({ tenantModels, organizationId }) => {
  const { TargetList } = tenantModels;
  if (!TargetList) return [];

  return await TargetList.find({ organizationId })
    .populate("companies", "companyName website industry location isResolved")
    .sort({ createdAt: -1 })
    .lean();
};

export const createTargetListService = async ({ tenantModels, organizationId, user, data }) => {
  const { TargetList } = tenantModels;
  const { name, description = "", companyIds = [] } = data;

  return await TargetList.create({
    organizationId,
    name: name.trim(),
    description: description.trim(),
    companies: Array.isArray(companyIds) ? companyIds : [],
    createdBy: user?._id || user?.id || null,
  });
};

export const updateTargetListService = async ({ tenantModels, organizationId, listId, data }) => {
  const { TargetList } = tenantModels;
  const list = await TargetList.findOne({ _id: listId, organizationId });
  if (!list) {
    throw new NotFoundError("Target List not found.");
  }

  const { name, description, companyIds, addCompanyId, removeCompanyId } = data;
  if (name !== undefined) list.name = name.trim();
  if (description !== undefined) list.description = description.trim();
  if (Array.isArray(companyIds)) list.companies = companyIds;
  if (addCompanyId && !list.companies.includes(addCompanyId)) {
    list.companies.push(addCompanyId);
  }
  if (removeCompanyId) {
    list.companies = list.companies.filter((c) => c.toString() !== removeCompanyId.toString());
  }

  return await list.save();
};

export const deleteTargetListService = async ({ tenantModels, organizationId, listId }) => {
  const { TargetList } = tenantModels;
  const result = await TargetList.findOneAndDelete({ _id: listId, organizationId });
  if (!result) {
    throw new NotFoundError("Target List not found.");
  }
  return { id: listId, deleted: true };
};

export default {
  getMonthlyQuotaService,
  saveSearchAndCacheCompaniesService,
  resolveProspectCoreService,
  unresolveProspectCoreService,
  queryTargetListsService,
  createTargetListService,
  updateTargetListService,
  deleteTargetListService,
};
