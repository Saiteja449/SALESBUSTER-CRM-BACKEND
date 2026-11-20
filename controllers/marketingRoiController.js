import { getTenantModels } from "../services/tenantManager.js";
import {
  calculateRoiMetrics,
  calculatePeriodDelta,
  buildTimeseriesTimeline,
  buildPlatformBreakdown,
  syncCrmLeadsToMarketingCampaigns,
  seedSampleDataIfEmpty,
} from "../services/marketingRoiService.js";

/**
 * Helper to retrieve tenant models from request context
 */
const getModels = (req) => {
  return (
    req.tenantModels ||
    getTenantModels(req.organization?.tenantDbName || req.user?.organizationId)
  );
};

/**
 * GET /api/marketing-roi/dashboard
 * Aggregates all KPI scorecards, delta comparisons, timeline, and platform share
 */
export const getRoiDashboardData = async (req, res) => {
  try {
    const organizationId = req.user?.organizationId || req.organization?._id;
    if (!organizationId) {
      return res.status(400).json({ success: false, message: "Organization required." });
    }

    const tenantModels = getModels(req);
    const { MarketingCampaign } = tenantModels;

    // Seed sample records if brand new organization
    await seedSampleDataIfEmpty(organizationId, tenantModels);

    const {
      fromDate,
      toDate,
      source = "ALL",
      campaign = "ALL",
      search = "",
      compare = "true",
    } = req.query;

    // 1. Build Query Filter
    const query = { organizationId };
    if (fromDate || toDate) {
      query.date = {};
      if (fromDate) query.date.$gte = fromDate;
      if (toDate) query.date.$lte = toDate;
    }
    if (source && source !== "ALL") {
      query.source = source;
    }
    if (campaign && campaign !== "ALL") {
      query.campaignName = campaign;
    }
    if (search && search.trim()) {
      const s = search.trim();
      query.$or = [
        { campaignName: { $regex: s, $options: "i" } },
        { source: { $regex: s, $options: "i" } },
        { customSource: { $regex: s, $options: "i" } },
      ];
    }

    // Fetch current period records
    const currentRecords = await MarketingCampaign.find(query).sort({ date: -1 }).lean();

    // 2. Calculate Current Metrics
    const currentMetrics = calculateRoiMetrics(currentRecords);

    // 3. Calculate Previous Period Metrics (if dates provided)
    let prevMetrics = null;
    let deltas = null;

    if (fromDate && toDate && compare === "true") {
      const start = new Date(fromDate);
      const end = new Date(toDate);
      const diffMs = end.getTime() - start.getTime();
      const diffDays = Math.max(Math.round(diffMs / (1000 * 60 * 60 * 24)), 1);

      const prevEnd = new Date(start);
      prevEnd.setDate(prevEnd.getDate() - 1);
      const prevStart = new Date(prevEnd);
      prevStart.setDate(prevStart.getDate() - diffDays + 1);

      const prevStartStr = prevStart.toISOString().split("T")[0];
      const prevEndStr = prevEnd.toISOString().split("T")[0];

      const prevQuery = {
        ...query,
        date: { $gte: prevStartStr, $lte: prevEndStr },
      };

      const prevRecords = await MarketingCampaign.find(prevQuery).lean();
      prevMetrics = calculateRoiMetrics(prevRecords);

      deltas = {
        spendDelta: calculatePeriodDelta(currentMetrics.totalSpend, prevMetrics.totalSpend),
        leadsDelta: calculatePeriodDelta(currentMetrics.totalLeads, prevMetrics.totalLeads),
        convertedDelta: calculatePeriodDelta(currentMetrics.totalConverted, prevMetrics.totalConverted),
        convRateDelta: Math.round((currentMetrics.conversionRate - prevMetrics.conversionRate) * 10) / 10,
        cplDelta: calculatePeriodDelta(currentMetrics.avgCPL, prevMetrics.avgCPL),
        cpclDelta: calculatePeriodDelta(currentMetrics.avgCPCL, prevMetrics.avgCPCL),
        revenueDelta: calculatePeriodDelta(currentMetrics.totalRevenue, prevMetrics.totalRevenue),
        roasDelta: Math.round((currentMetrics.roas - prevMetrics.roas) * 10) / 10,
      };
    }

    // 4. Timeline for GA4 Recharts Graph
    const timeline = buildTimeseriesTimeline(currentRecords, fromDate, toDate);

    // 5. Platform Breakdown
    const platforms = buildPlatformBreakdown(currentRecords);

    // 6. Distinct campaigns for filter dropdowns
    const allCampaignNames = await MarketingCampaign.distinct("campaignName", { organizationId });

    return res.status(200).json({
      success: true,
      data: {
        metrics: currentMetrics,
        deltas,
        prevMetrics,
        timeline,
        platforms,
        filterOptions: {
          sources: ["Google Ads", "Meta Ads", "YouTube", "Justdial", "LinkedIn Ads", "Custom"],
          campaigns: allCampaignNames.sort(),
        },
        totalRecords: currentRecords.length,
      },
    });
  } catch (err) {
    console.error("[MarketingRoiController] Dashboard error:", err);
    return res.status(500).json({ success: false, message: err.message || "Failed to load ROI dashboard." });
  }
};

/**
 * GET /api/marketing-roi/campaigns
 * Retrieves campaign table records with sorting and totals
 */
export const getCampaignRecords = async (req, res) => {
  try {
    const organizationId = req.user?.organizationId || req.organization?._id;
    if (!organizationId) {
      return res.status(400).json({ success: false, message: "Organization required." });
    }

    const tenantModels = getModels(req);
    const { MarketingCampaign } = tenantModels;

    const {
      fromDate,
      toDate,
      source = "ALL",
      campaign = "ALL",
      search = "",
      sortColumn = "date",
      sortDir = "desc",
      page = 1,
      limit = 100,
    } = req.query;

    const query = { organizationId };
    if (fromDate || toDate) {
      query.date = {};
      if (fromDate) query.date.$gte = fromDate;
      if (toDate) query.date.$lte = toDate;
    }
    if (source && source !== "ALL") {
      query.source = source;
    }
    if (campaign && campaign !== "ALL") {
      query.campaignName = campaign;
    }
    if (search && search.trim()) {
      const s = search.trim();
      query.$or = [
        { campaignName: { $regex: s, $options: "i" } },
        { source: { $regex: s, $options: "i" } },
        { customSource: { $regex: s, $options: "i" } },
      ];
    }

    const sortOrder = sortDir === "asc" ? 1 : -1;
    const sortObj = {};
    if (sortColumn === "leads") {
      sortObj.crmLeads = sortOrder;
    } else if (sortColumn === "converted") {
      sortObj.convertedLeads = sortOrder;
    } else {
      sortObj[sortColumn] = sortOrder;
    }

    const skip = (Number(page) - 1) * Number(limit);
    const records = await MarketingCampaign.find(query)
      .sort(sortObj)
      .skip(skip)
      .limit(Number(limit))
      .lean();

    const totalCount = await MarketingCampaign.countDocuments(query);
    const allMatching = await MarketingCampaign.find(query).lean();
    const totals = calculateRoiMetrics(allMatching);

    return res.status(200).json({
      success: true,
      records: records.map((r) => {
        const leads = (r.crmLeads > 0 ? r.crmLeads : r.externalLeads) || 0;
        const cpl = leads > 0 ? Math.round((r.spend / leads) * 100) / 100 : null;
        const cpcl = r.convertedLeads > 0 ? Math.round((r.spend / r.convertedLeads) * 100) / 100 : null;
        const convRate = leads > 0 ? Math.round(((r.convertedLeads / leads) * 100) * 10) / 10 : 0;

        return {
          id: r._id,
          date: r.date,
          source: r.source,
          customSource: r.customSource,
          campaignName: r.campaignName,
          spend: r.spend,
          leads,
          convertedLeads: r.convertedLeads,
          revenue: r.revenue,
          convRate,
          cpl,
          cpcl,
          isAutoSynced: r.isAutoSynced,
          notes: r.notes,
        };
      }),
      totals,
      totalCount,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (err) {
    console.error("[MarketingRoiController] Table records error:", err);
    return res.status(500).json({ success: false, message: err.message || "Failed to load campaigns." });
  }
};

/**
 * POST /api/marketing-roi/campaign
 * Creates a new manual campaign record
 */
export const createCampaignRecord = async (req, res) => {
  try {
    const organizationId = req.user?.organizationId || req.organization?._id;
    if (!organizationId) {
      return res.status(400).json({ success: false, message: "Organization required." });
    }

    const {
      date,
      source,
      customSource,
      campaignName,
      spend = 0,
      leads = 0,
      convertedLeads = 0,
      revenue = 0,
      notes = "",
    } = req.body;

    if (!date) {
      return res.status(400).json({ success: false, message: "Date is required." });
    }
    if (!source) {
      return res.status(400).json({ success: false, message: "Advertising source is required." });
    }
    if (!campaignName || !campaignName.trim()) {
      return res.status(400).json({ success: false, message: "Campaign name is required." });
    }
    if (Number(convertedLeads) > Number(leads)) {
      return res.status(400).json({
        success: false,
        message: "Converted leads cannot exceed total leads generated.",
      });
    }

    const tenantModels = getModels(req);
    const { MarketingCampaign } = tenantModels;

    const newRecord = await MarketingCampaign.create({
      organizationId,
      userId: req.user?._id || null,
      date,
      source,
      customSource: source === "Custom" ? customSource : "",
      campaignName: campaignName.trim(),
      spend: Math.max(Number(spend) || 0, 0),
      crmLeads: Math.max(Number(leads) || 0, 0),
      convertedLeads: Math.max(Number(convertedLeads) || 0, 0),
      revenue: Math.max(Number(revenue) || 0, 0),
      notes: notes.trim(),
      isAutoSynced: false,
      syncStatus: "manual",
    });

    return res.status(201).json({
      success: true,
      message: "Campaign performance entry saved successfully.",
      data: newRecord,
    });
  } catch (err) {
    console.error("[MarketingRoiController] Create campaign error:", err);
    return res.status(500).json({ success: false, message: err.message || "Failed to create campaign record." });
  }
};

/**
 * PUT /api/marketing-roi/campaign/:id
 * Updates an existing campaign record
 */
export const updateCampaignRecord = async (req, res) => {
  try {
    const organizationId = req.user?.organizationId || req.organization?._id;
    const { id } = req.params;
    const {
      date,
      source,
      customSource,
      campaignName,
      spend,
      leads,
      convertedLeads,
      revenue,
      notes,
    } = req.body;

    if (leads !== undefined && convertedLeads !== undefined && Number(convertedLeads) > Number(leads)) {
      return res.status(400).json({
        success: false,
        message: "Converted leads cannot exceed total leads generated.",
      });
    }

    const tenantModels = getModels(req);
    const { MarketingCampaign } = tenantModels;

    const record = await MarketingCampaign.findOne({ _id: id, organizationId });
    if (!record) {
      return res.status(404).json({ success: false, message: "Campaign record not found." });
    }

    if (date) record.date = date;
    if (source) record.source = source;
    if (customSource !== undefined) record.customSource = customSource;
    if (campaignName) record.campaignName = campaignName.trim();
    if (spend !== undefined) record.spend = Math.max(Number(spend) || 0, 0);
    if (leads !== undefined) record.crmLeads = Math.max(Number(leads) || 0, 0);
    if (convertedLeads !== undefined) record.convertedLeads = Math.max(Number(convertedLeads) || 0, 0);
    if (revenue !== undefined) record.revenue = Math.max(Number(revenue) || 0, 0);
    if (notes !== undefined) record.notes = notes;

    await record.save();

    return res.status(200).json({
      success: true,
      message: "Campaign record updated.",
      data: record,
    });
  } catch (err) {
    console.error("[MarketingRoiController] Update campaign error:", err);
    return res.status(500).json({ success: false, message: err.message || "Failed to update record." });
  }
};

/**
 * DELETE /api/marketing-roi/campaign/:id
 * Removes a campaign entry
 */
export const deleteCampaignRecord = async (req, res) => {
  try {
    const organizationId = req.user?.organizationId || req.organization?._id;
    const { id } = req.params;

    const tenantModels = getModels(req);
    const { MarketingCampaign } = tenantModels;

    const deleted = await MarketingCampaign.findOneAndDelete({ _id: id, organizationId });
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Campaign record not found." });
    }

    return res.status(200).json({ success: true, message: "Record deleted successfully." });
  } catch (err) {
    console.error("[MarketingRoiController] Delete campaign error:", err);
    return res.status(500).json({ success: false, message: err.message || "Failed to delete record." });
  }
};

/**
 * POST /api/marketing-roi/sync
 * Triggers live synchronization with CRM Leads and connected ad platforms
 */
export const triggerPlatformSync = async (req, res) => {
  try {
    const organizationId = req.user?.organizationId || req.organization?._id;
    if (!organizationId) {
      return res.status(400).json({ success: false, message: "Organization required." });
    }

    const tenantModels = getModels(req);
    const { fromDate, toDate } = req.body;

    // Cross-sync with CRM Leads
    await syncCrmLeadsToMarketingCampaigns({
      organizationId,
      tenantModels,
      fromDate,
      toDate,
    });

    return res.status(200).json({
      success: true,
      message: "Marketing performance synchronized with CRM lead statistics.",
      syncedAt: new Date(),
    });
  } catch (err) {
    console.error("[MarketingRoiController] Sync error:", err);
    return res.status(500).json({ success: false, message: err.message || "Failed to sync platform data." });
  }
};

/**
 * GET /api/marketing-roi/export
 * Exports campaign records as CSV
 */
export const exportRoiCsv = async (req, res) => {
  try {
    const organizationId = req.user?.organizationId || req.organization?._id;
    const tenantModels = getModels(req);
    const { MarketingCampaign } = tenantModels;

    const { fromDate, toDate, source, campaign } = req.query;
    const query = { organizationId };
    if (fromDate || toDate) {
      query.date = {};
      if (fromDate) query.date.$gte = fromDate;
      if (toDate) query.date.$lte = toDate;
    }
    if (source && source !== "ALL") query.source = source;
    if (campaign && campaign !== "ALL") query.campaignName = campaign;

    const records = await MarketingCampaign.find(query).sort({ date: -1 }).lean();

    const header = [
      "Date",
      "Source",
      "Campaign Name",
      "Amount Spent (INR)",
      "Total Leads",
      "Converted Leads",
      "Conversion Rate (%)",
      "Cost Per Lead (CPL)",
      "Cost Per Converted Lead (CPCL)",
      "Revenue Generated (INR)",
    ];

    const rows = records.map((r) => {
      const leads = (r.crmLeads > 0 ? r.crmLeads : r.externalLeads) || 0;
      const cpl = leads > 0 ? (r.spend / leads).toFixed(2) : "0.00";
      const cpcl = r.convertedLeads > 0 ? (r.spend / r.convertedLeads).toFixed(2) : "0.00";
      const convRate = leads > 0 ? ((r.convertedLeads / leads) * 100).toFixed(1) : "0.0";

      return [
        r.date,
        `"${r.source}"`,
        `"${r.campaignName.replace(/"/g, '""')}"`,
        r.spend.toFixed(2),
        leads,
        r.convertedLeads,
        `${convRate}%`,
        cpl,
        cpcl,
        (r.revenue || 0).toFixed(2),
      ].join(",");
    });

    const csvContent = [header.join(","), ...rows].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=marketing-roi-${Date.now()}.csv`);
    return res.status(200).send(csvContent);
  } catch (err) {
    console.error("[MarketingRoiController] CSV export error:", err);
    return res.status(500).json({ success: false, message: "Failed to generate CSV export." });
  }
};
