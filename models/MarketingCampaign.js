import mongoose from "mongoose";

export const marketingCampaignSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    date: {
      type: String, // Format: YYYY-MM-DD
      required: true,
      index: true,
    },
    source: {
      type: String,
      required: true,
      enum: ["Google Ads", "Meta Ads", "YouTube", "Justdial", "LinkedIn Ads", "Custom"],
      default: "Custom",
      index: true,
    },
    customSource: {
      type: String,
      trim: true,
      default: "",
    },
    campaignName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    campaignId: {
      type: String,
      trim: true,
      default: "",
    },
    spend: {
      type: Number,
      default: 0,
      min: 0,
    },
    impressions: {
      type: Number,
      default: 0,
      min: 0,
    },
    clicks: {
      type: Number,
      default: 0,
      min: 0,
    },
    externalLeads: {
      type: Number,
      default: 0,
      min: 0,
    },
    crmLeads: {
      type: Number,
      default: 0,
      min: 0,
    },
    convertedLeads: {
      type: Number,
      default: 0,
      min: 0,
    },
    revenue: {
      type: Number,
      default: 0,
      min: 0,
    },
    isAutoSynced: {
      type: Boolean,
      default: false,
    },
    syncStatus: {
      type: String,
      enum: ["synced", "pending", "manual", "error"],
      default: "manual",
    },
    lastSyncedAt: {
      type: Date,
      default: null,
    },
    notes: {
      type: String,
      default: "",
    },
    rawInsights: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for fast period queries, platform filtering, and deduplication
marketingCampaignSchema.index(
  { organizationId: 1, date: -1, source: 1, campaignName: 1 },
  { name: "org_date_source_campaign_idx" }
);

const MarketingCampaign =
  mongoose.models.MarketingCampaign ||
  mongoose.model("MarketingCampaign", marketingCampaignSchema);

export default MarketingCampaign;
