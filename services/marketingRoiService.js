const getGraphApiVersion = () => process.env.META_GRAPH_API_VERSION || "v21.0";
const getGraphApiBaseUrl = () => `https://graph.facebook.com/${getGraphApiVersion()}`;

/**
 * Calculates high-level summary KPIs from campaign records
 */
export const calculateRoiMetrics = (records = []) => {
  let totalSpend = 0;
  let totalLeads = 0;
  let totalConverted = 0;
  let totalRevenue = 0;
  let totalImpressions = 0;
  let totalClicks = 0;

  records.forEach((r) => {
    const spend = Number(r.spend) || 0;
    // Prefer CRM leads if recorded, fallback to external ad platform leads
    const leads = (Number(r.crmLeads) > 0 ? Number(r.crmLeads) : Number(r.externalLeads)) || Number(r.leads) || 0;
    const converted = Number(r.convertedLeads) || 0;
    const rev = Number(r.revenue) || 0;

    totalSpend += spend;
    totalLeads += leads;
    totalConverted += converted;
    totalRevenue += rev;
    totalImpressions += Number(r.impressions) || 0;
    totalClicks += Number(r.clicks) || 0;
  });

  const conversionRate = totalLeads > 0 ? (totalConverted / totalLeads) * 100 : 0;
  const avgCPL = totalLeads > 0 ? totalSpend / totalLeads : 0;
  const avgCPCL = totalConverted > 0 ? totalSpend / totalConverted : 0;
  const roas = totalSpend > 0 ? (totalRevenue / totalSpend) * 100 : 0;
  const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;

  return {
    totalSpend: Math.round(totalSpend * 100) / 100,
    totalLeads,
    totalConverted,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    conversionRate: Math.round(conversionRate * 10) / 10,
    avgCPL: Math.round(avgCPL * 100) / 100,
    avgCPCL: Math.round(avgCPCL * 100) / 100,
    roas: Math.round(roas * 10) / 10,
    totalImpressions,
    totalClicks,
    ctr: Math.round(ctr * 10) / 10,
  };
};

/**
 * Calculates percentage delta comparing current vs previous period
 */
export const calculatePeriodDelta = (currentVal, prevVal) => {
  const current = Number(currentVal) || 0;
  const prev = Number(prevVal) || 0;
  if (prev === 0) {
    return current > 0 ? 100 : 0;
  }
  return Math.round(((current - prev) / prev) * 1000) / 10;
};

/**
 * Builds continuous daily timeseries array for GA4-style timeline charts
 */
export const buildTimeseriesTimeline = (records = [], fromDateStr, toDateStr) => {
  const dateMap = {};

  records.forEach((r) => {
    const d = r.date;
    if (!d) return;
    if (!dateMap[d]) {
      dateMap[d] = {
        date: d,
        spend: 0,
        leads: 0,
        convertedLeads: 0,
        revenue: 0,
        impressions: 0,
        clicks: 0,
      };
    }
    const leads = (Number(r.crmLeads) > 0 ? Number(r.crmLeads) : Number(r.externalLeads)) || Number(r.leads) || 0;
    dateMap[d].spend += Number(r.spend) || 0;
    dateMap[d].leads += leads;
    dateMap[d].convertedLeads += Number(r.convertedLeads) || 0;
    dateMap[d].revenue += Number(r.revenue) || 0;
    dateMap[d].impressions += Number(r.impressions) || 0;
    dateMap[d].clicks += Number(r.clicks) || 0;
  });

  // Sort chronologically
  const sortedDays = Object.keys(dateMap).sort();
  return sortedDays.map((date) => {
    const item = dateMap[date];
    const cpl = item.leads > 0 ? Math.round((item.spend / item.leads) * 100) / 100 : 0;
    const cpcl = item.convertedLeads > 0 ? Math.round((item.spend / item.convertedLeads) * 100) / 100 : 0;
    const convRate = item.leads > 0 ? Math.round(((item.convertedLeads / item.leads) * 100) * 10) / 10 : 0;

    return {
      ...item,
      cpl,
      cpcl,
      conversionRate: convRate,
    };
  });
};

/**
 * Builds channel/source breakdown with % share of spend and CPL efficiency
 */
export const buildPlatformBreakdown = (records = []) => {
  const sources = ["Google Ads", "Meta Ads", "YouTube", "Justdial", "LinkedIn Ads", "Custom"];
  const aggregated = {};
  let totalOverallSpend = 0;

  records.forEach((r) => {
    const src = r.source || "Custom";
    if (!aggregated[src]) {
      aggregated[src] = {
        source: src,
        spend: 0,
        leads: 0,
        convertedLeads: 0,
        revenue: 0,
        campaignsCount: new Set(),
      };
    }
    const spend = Number(r.spend) || 0;
    const leads = (Number(r.crmLeads) > 0 ? Number(r.crmLeads) : Number(r.externalLeads)) || Number(r.leads) || 0;
    aggregated[src].spend += spend;
    aggregated[src].leads += leads;
    aggregated[src].convertedLeads += Number(r.convertedLeads) || 0;
    aggregated[src].revenue += Number(r.revenue) || 0;
    if (r.campaignName) aggregated[src].campaignsCount.add(r.campaignName);
    totalOverallSpend += spend;
  });

  return Object.values(aggregated).map((item) => {
    const spend = Math.round(item.spend * 100) / 100;
    const shareOfSpend = totalOverallSpend > 0 ? Math.round((spend / totalOverallSpend) * 1000) / 10 : 0;
    const cpl = item.leads > 0 ? Math.round((spend / item.leads) * 100) / 100 : 0;
    const cpcl = item.convertedLeads > 0 ? Math.round((spend / item.convertedLeads) * 100) / 100 : 0;
    const convRate = item.leads > 0 ? Math.round(((item.convertedLeads / item.leads) * 100) * 10) / 10 : 0;

    return {
      source: item.source,
      spend,
      leads: item.leads,
      convertedLeads: item.convertedLeads,
      revenue: item.revenue,
      activeCampaigns: item.campaignsCount.size,
      shareOfSpend,
      cpl,
      cpcl,
      conversionRate: convRate,
    };
  });
};

/**
 * Auto-syncs CRM Leads into Marketing Campaigns
 * Matches CRM Leads created within the date range by `source` or `campaignName`
 */
export const syncCrmLeadsToMarketingCampaigns = async ({
  organizationId,
  tenantModels,
  fromDate,
  toDate,
}) => {
  const { Lead, MarketingCampaign } = tenantModels;
  if (!Lead || !MarketingCampaign) return;

  const matchFilter = { organizationId };
  if (fromDate || toDate) {
    matchFilter.createdAt = {};
    if (fromDate) matchFilter.createdAt.$gte = new Date(`${fromDate}T00:00:00.000Z`);
    if (toDate) matchFilter.createdAt.$lte = new Date(`${toDate}T23:59:59.999Z`);
  }

  // Aggregate leads by date and source
  const aggregatedLeads = await Lead.aggregate([
    { $match: matchFilter },
    {
      $group: {
        _id: {
          dateStr: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          source: "$source",
          campaignName: { $ifNull: ["$campaignName", ""] },
        },
        totalLeads: { $sum: 1 },
        convertedLeads: {
          $sum: { $cond: [{ $eq: ["$status", "Converted"] }, 1, 0] },
        },
        totalRevenue: {
          $sum: { $cond: [{ $eq: ["$status", "Converted"] }, { $ifNull: ["$dealValue", 0] }, 0] },
        },
      },
    },
  ]);

  // Update or create campaigns matching the aggregated CRM data
  for (const group of aggregatedLeads) {
    const { dateStr, source, campaignName } = group._id;
    if (!dateStr || !source) continue;

    // Map lead source to standard marketing sources
    let mappedSource = source;
    if (source === "Instagram") mappedSource = "Meta Ads";

    const filter = {
      organizationId,
      date: dateStr,
      source: mappedSource,
    };
    if (campaignName) {
      filter.campaignName = campaignName;
    }

    const existing = await MarketingCampaign.findOne(filter);
    if (existing) {
      existing.crmLeads = group.totalLeads;
      existing.convertedLeads = group.convertedLeads;
      existing.revenue = group.totalRevenue;
      existing.lastSyncedAt = new Date();
      await existing.save();
    }
  }
};

/**
 * Helper: Seeds initial sample campaigns if the tenant has 0 records
 * Ensures the user has an immediate, rich, interactive GA4-style experience
 */
export const seedSampleDataIfEmpty = async (organizationId, tenantModels) => {
  const { MarketingCampaign } = tenantModels;
  if (!MarketingCampaign) return;

  const count = await MarketingCampaign.countDocuments({ organizationId });
  if (count > 0) return;

  const today = new Date();
  const getOffset = (days) => {
    const d = new Date(today);
    d.setDate(d.getDate() + days);
    return d.toISOString().split("T")[0];
  };

  const sampleEntries = [
    // Google Ads
    { date: getOffset(-2), source: "Google Ads", campaignName: "Search Campaign - High Intent", spend: 4500, crmLeads: 32, convertedLeads: 8, revenue: 96000, impressions: 8400, clicks: 420 },
    { date: getOffset(-5), source: "Google Ads", campaignName: "Search Campaign - High Intent", spend: 5200, crmLeads: 40, convertedLeads: 12, revenue: 144000, impressions: 9800, clicks: 510 },
    { date: getOffset(-8), source: "Google Ads", campaignName: "Local Search Ads", spend: 3100, crmLeads: 22, convertedLeads: 5, revenue: 55000, impressions: 5600, clicks: 310 },
    { date: getOffset(-12), source: "Google Ads", campaignName: "Local Search Ads", spend: 2800, crmLeads: 18, convertedLeads: 4, revenue: 42000, impressions: 4900, clicks: 270 },

    // Meta Ads
    { date: getOffset(-1), source: "Meta Ads", campaignName: "Lead Gen Reel & Feed Ads", spend: 3800, crmLeads: 45, convertedLeads: 9, revenue: 81000, impressions: 14500, clicks: 680 },
    { date: getOffset(-4), source: "Meta Ads", campaignName: "Lead Gen Reel & Feed Ads", spend: 4200, crmLeads: 50, convertedLeads: 11, revenue: 110000, impressions: 16200, clicks: 740 },
    { date: getOffset(-7), source: "Meta Ads", campaignName: "Instagram Retargeting", spend: 2400, crmLeads: 15, convertedLeads: 6, revenue: 72000, impressions: 8900, clicks: 390 },
    { date: getOffset(-10), source: "Meta Ads", campaignName: "Instagram Retargeting", spend: 2600, crmLeads: 19, convertedLeads: 7, revenue: 84000, impressions: 9500, clicks: 430 },

    // Justdial
    { date: getOffset(-3), source: "Justdial", campaignName: "Premium Verified Listing", spend: 1800, crmLeads: 14, convertedLeads: 3, revenue: 36000, impressions: 2100, clicks: 120 },
    { date: getOffset(-6), source: "Justdial", campaignName: "Premium Verified Listing", spend: 1800, crmLeads: 16, convertedLeads: 4, revenue: 48000, impressions: 2300, clicks: 140 },
    { date: getOffset(-9), source: "Justdial", campaignName: "Standard Area Listing", spend: 900, crmLeads: 8, convertedLeads: 1, revenue: 12000, impressions: 1200, clicks: 75 },

    // YouTube
    { date: getOffset(-2), source: "YouTube", campaignName: "In-Stream Video Pitch", spend: 6000, crmLeads: 28, convertedLeads: 4, revenue: 52000, impressions: 22000, clicks: 890 },
    { date: getOffset(-6), source: "YouTube", campaignName: "Brand Awareness Bumper", spend: 5500, crmLeads: 20, convertedLeads: 2, revenue: 26000, impressions: 28000, clicks: 620 },
    { date: getOffset(-14), source: "YouTube", campaignName: "In-Stream Video Pitch", spend: 6200, crmLeads: 31, convertedLeads: 5, revenue: 65000, impressions: 24500, clicks: 940 },
  ];

  await MarketingCampaign.insertMany(
    sampleEntries.map((e) => ({
      ...e,
      organizationId,
      isAutoSynced: false,
      syncStatus: "manual",
    }))
  );
};
