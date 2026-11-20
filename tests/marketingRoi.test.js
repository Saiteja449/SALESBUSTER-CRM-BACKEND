import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Models
import MarketingCampaign, { marketingCampaignSchema } from "../models/MarketingCampaign.js";
import Lead from "../models/Lead.js";

// Services & Helpers
import {
  calculateRoiMetrics,
  calculatePeriodDelta,
  buildTimeseriesTimeline,
  buildPlatformBreakdown,
} from "../services/marketingRoiService.js";

describe("Marketing Investment ROI - Database Models & Schemas", () => {
  it("MarketingCampaign schema defines all required ROI and sync fields", () => {
    const paths = marketingCampaignSchema.paths;

    assert.ok(paths.organizationId, "organizationId should exist");
    assert.ok(paths.date, "date should exist");
    assert.ok(paths.source, "source should exist");
    assert.ok(paths.campaignName, "campaignName should exist");
    assert.ok(paths.spend, "spend should exist");
    assert.ok(paths.crmLeads, "crmLeads should exist");
    assert.ok(paths.convertedLeads, "convertedLeads should exist");
    assert.ok(paths.revenue, "revenue should exist");
    assert.ok(paths.isAutoSynced, "isAutoSynced should exist");
    assert.ok(paths.syncStatus, "syncStatus should exist");

    const sourceEnum = paths.source.enumValues;
    assert.deepEqual(
      sourceEnum,
      ["Google Ads", "Meta Ads", "YouTube", "Justdial", "LinkedIn Ads", "Custom"],
      "Source enum must cover all major paid platforms"
    );
  });

  it("MarketingCampaign schema enforces compound index on organizationId + date + source + campaignName", () => {
    const indexes = marketingCampaignSchema.indexes();
    const hasCompound = indexes.some(
      ([fields]) =>
        fields.organizationId === 1 &&
        fields.date === -1 &&
        fields.source === 1 &&
        fields.campaignName === 1
    );
    assert.ok(hasCompound, "MarketingCampaign must have compound query index");
  });

  it("Lead model source enum includes Google Ads, YouTube, Justdial, and LinkedIn Ads", () => {
    const sourceEnum = Lead.schema.paths.source.enumValues;
    assert.ok(sourceEnum.includes("Google Ads"), "Lead source enum must include 'Google Ads'");
    assert.ok(sourceEnum.includes("YouTube"), "Lead source enum must include 'YouTube'");
    assert.ok(sourceEnum.includes("Justdial"), "Lead source enum must include 'Justdial'");
    assert.ok(sourceEnum.includes("LinkedIn Ads"), "Lead source enum must include 'LinkedIn Ads'");
  });
});

describe("Marketing Investment ROI - Calculation & Analytics Logic", () => {
  it("calculateRoiMetrics accurately computes CPL, CPCL, Conv Rate, and ROAS", () => {
    const sampleRecords = [
      {
        spend: 4000,
        crmLeads: 20,
        convertedLeads: 4,
        revenue: 40000,
        impressions: 10000,
        clicks: 500,
      },
      {
        spend: 6000,
        crmLeads: 30,
        convertedLeads: 6,
        revenue: 60000,
        impressions: 15000,
        clicks: 750,
      },
    ];

    const metrics = calculateRoiMetrics(sampleRecords);

    assert.equal(metrics.totalSpend, 10000, "Total spend should be 10,000");
    assert.equal(metrics.totalLeads, 50, "Total leads should be 50");
    assert.equal(metrics.totalConverted, 10, "Total converted leads should be 10");
    assert.equal(metrics.totalRevenue, 100000, "Total revenue should be 100,000");

    // Derived metrics
    assert.equal(metrics.conversionRate, 20.0, "Conversion rate should be (10/50)*100 = 20.0%");
    assert.equal(metrics.avgCPL, 200, "Avg CPL should be 10000/50 = ₹200");
    assert.equal(metrics.avgCPCL, 1000, "Avg CPCL should be 10000/10 = ₹1,000");
    assert.equal(metrics.roas, 1000, "ROAS should be (100000/10000)*100 = 1000.0%");
    assert.equal(metrics.ctr, 5.0, "CTR should be (1250/25000)*100 = 5.0%");
  });

  it("calculatePeriodDelta computes percentage comparisons correctly", () => {
    assert.equal(calculatePeriodDelta(120, 100), 20.0, "Should be +20%");
    assert.equal(calculatePeriodDelta(80, 100), -20.0, "Should be -20%");
    assert.equal(calculatePeriodDelta(50, 0), 100.0, "Should be +100% when starting from 0");
    assert.equal(calculatePeriodDelta(0, 0), 0.0, "Should be 0% when both are 0");
  });

  it("buildTimeseriesTimeline aggregates daily metrics and sorts chronologically", () => {
    const records = [
      { date: "2026-11-02", spend: 2000, crmLeads: 10, convertedLeads: 2 },
      { date: "2026-11-01", spend: 1000, crmLeads: 5, convertedLeads: 1 },
      { date: "2026-11-01", spend: 1500, crmLeads: 5, convertedLeads: 1 },
    ];

    const timeline = buildTimeseriesTimeline(records);

    assert.equal(timeline.length, 2, "Should group into 2 days");
    assert.equal(timeline[0].date, "2026-11-01", "Should be sorted ascending");
    assert.equal(timeline[0].spend, 2500, "2026-11-01 total spend should be 2,500");
    assert.equal(timeline[0].leads, 10, "2026-11-01 total leads should be 10");
    assert.equal(timeline[0].cpl, 250, "2026-11-01 CPL should be 250");
    assert.equal(timeline[1].date, "2026-11-02");
    assert.equal(timeline[1].spend, 2000);
  });

  it("buildPlatformBreakdown calculates share of spend across platforms", () => {
    const records = [
      { source: "Google Ads", spend: 3000, crmLeads: 15, convertedLeads: 3, campaignName: "C1" },
      { source: "Meta Ads", spend: 7000, crmLeads: 35, convertedLeads: 7, campaignName: "C2" },
    ];

    const breakdown = buildPlatformBreakdown(records);
    const google = breakdown.find((b) => b.source === "Google Ads");
    const meta = breakdown.find((b) => b.source === "Meta Ads");

    assert.ok(google, "Google Ads should be in breakdown");
    assert.ok(meta, "Meta Ads should be in breakdown");
    assert.equal(google.shareOfSpend, 30.0, "Google share of spend should be 30%");
    assert.equal(meta.shareOfSpend, 70.0, "Meta share of spend should be 70%");
    assert.equal(google.cpl, 200, "Google CPL should be 200");
    assert.equal(meta.cpl, 200, "Meta CPL should be 200");
  });
});
