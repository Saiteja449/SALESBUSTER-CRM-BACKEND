import mongoose from "mongoose";
import crypto from "crypto";

// Import all base models
import User from "../models/User.js";
import Lead from "../models/Lead.js";
import Followup from "../models/Followup.js";
import Notification from "../models/Notification.js";
import Conversation from "../models/Conversation.js";
import Message from "../models/Message.js";
import AILog from "../models/AILog.js";
import AILimit from "../models/AILimit.js";
import AssignmentState from "../models/AssignmentState.js";
import TelecallerAnalytics from "../models/TelecallerAnalytics.js";
import SystemSettings from "../models/SystemSettings.js";
import WhatsAppAuthState from "../models/WhatsAppAuthState.js";
import WhatsAppSession from "../models/WhatsAppSession.js";
import WhatsAppTemplate from "../models/WhatsAppTemplate.js";
import WhatsAppCampaign from "../models/WhatsAppCampaign.js";
import WhatsAppCampaignRecipient from "../models/WhatsAppCampaignRecipient.js";
import WhatsAppOptOut from "../models/WhatsAppOptOut.js";
import AIAssistantChat from "../models/AIAssistantChat.js";
import Event from "../models/Event.js";
import EventContact from "../models/EventContact.js";
import ResolvedProspect from "../models/ResolvedProspect.js";
import TargetSearch from "../models/TargetSearch.js";
import TargetCompany from "../models/TargetCompany.js";
import TargetContact from "../models/TargetContact.js";
import TargetList from "../models/TargetList.js";
import ProviderUsage from "../models/ProviderUsage.js";
import CallRecord from "../models/CallRecord.js";
import Organization, { organizationSchema } from "../models/Organization.js";
import AuthUser, { authUserSchema } from "../models/AuthUser.js";
import AppRelease, { appReleaseSchema } from "../models/AppRelease.js";
import WAAccount, { waAccountSchema } from "../models/WhatsAppAccount.js";
import WAContact, { waContactSchema } from "../models/WhatsAppContact.js";
import WAMessage, { waMessageSchema } from "../models/WhatsAppMessage.js";
import WAWebhookEvent, { waWebhookEventSchema } from "../models/WhatsAppWebhookEvent.js";
import ShowcaseService, { showcaseServiceSchema } from "../models/ShowcaseService.js";
import ShortUrl, { shortUrlSchema } from "../models/ShortUrl.js";
import AppGuideVideo, { appGuideVideoSchema } from "../models/AppGuideVideo.js";
import InstagramAccount, { instagramAccountSchema } from "../models/InstagramAccount.js";
import InstagramContact, { instagramContactSchema } from "../models/InstagramContact.js";
import InstagramAutomationRule, { instagramAutomationRuleSchema } from "../models/InstagramAutomationRule.js";
import InstagramMessage, { instagramMessageSchema } from "../models/InstagramMessage.js";
import MarketingCampaign, { marketingCampaignSchema } from "../models/MarketingCampaign.js";
import CashfreeOrder, { cashfreeOrderSchema } from "../models/CashfreeOrder.js";
import CashfreeWebhookEvent, { cashfreeWebhookEventSchema } from "../models/CashfreeWebhookEvent.js";
import CashfreeSubscription, { cashfreeSubscriptionSchema } from "../models/CashfreeSubscription.js";
import ApiActivityLog, { apiActivityLogSchema } from "../models/ApiActivityLog.js";
import UserSession, { userSessionSchema } from "../models/UserSession.js";

let _masterModelsOverride = null;
let _tenantModelsOverride = null;
const _tenantModelsCache = new Map();

export const setMasterModelsMock = (mockFn) => {
  _masterModelsOverride = mockFn;
};

export const setTenantModelsMock = (mockFn) => {
  _tenantModelsOverride = mockFn;
  _tenantModelsCache.clear();
};

/**
 * Gets master database connection and models
 */
export const getMasterModels = () => {
  if (typeof _masterModelsOverride === "function") {
    return _masterModelsOverride();
  }
  const masterDbName = process.env.MASTER_DB_NAME || "salesbuster_master";
  const masterDb = mongoose.connection.useDb(masterDbName);

  const MasterOrg =
    masterDb.models.Organization ||
    masterDb.model("Organization", organizationSchema);
  const MasterAuthUser =
    masterDb.models.AuthUser || masterDb.model("AuthUser", authUserSchema);
  const MasterAppRelease =
    masterDb.models.AppRelease ||
    masterDb.model("AppRelease", appReleaseSchema);
  const MasterWAAccount =
    masterDb.models.WAAccount ||
    masterDb.model("WAAccount", waAccountSchema);
  const MasterWAWebhookEvent =
    masterDb.models.WAWebhookEvent ||
    masterDb.model("WAWebhookEvent", waWebhookEventSchema);
  const MasterShowcaseService =
    masterDb.models.ShowcaseService ||
    masterDb.model("ShowcaseService", showcaseServiceSchema);
  const MasterShortUrl =
    masterDb.models.ShortUrl ||
    masterDb.model("ShortUrl", shortUrlSchema);
  const MasterAppGuideVideo =
    masterDb.models.AppGuideVideo ||
    masterDb.model("AppGuideVideo", appGuideVideoSchema);
  const MasterInstagramAccount =
    masterDb.models.InstagramAccount ||
    masterDb.model("InstagramAccount", instagramAccountSchema);

  return {
    Organization: MasterOrg,
    AuthUser: MasterAuthUser,
    AppRelease: MasterAppRelease,
    WAAccount: MasterWAAccount,
    WAWebhookEvent: MasterWAWebhookEvent,
    ShowcaseService: MasterShowcaseService,
    ShortUrl: MasterShortUrl,
    AppGuideVideo: MasterAppGuideVideo,
    InstagramAccount: MasterInstagramAccount,
    MarketingCampaign:
      masterDb.models.MarketingCampaign ||
      masterDb.model("MarketingCampaign", marketingCampaignSchema),
    CashfreeOrder:
      masterDb.models.CashfreeOrder ||
      masterDb.model("CashfreeOrder", cashfreeOrderSchema),
    CashfreeWebhookEvent:
      masterDb.models.CashfreeWebhookEvent ||
      masterDb.model("CashfreeWebhookEvent", cashfreeWebhookEventSchema),
    CashfreeSubscription:
      masterDb.models.CashfreeSubscription ||
      masterDb.model("CashfreeSubscription", cashfreeSubscriptionSchema),
    ApiActivityLog:
      masterDb.models.ApiActivityLog ||
      masterDb.model("ApiActivityLog", apiActivityLogSchema),
    UserSession:
      masterDb.models.UserSession ||
      masterDb.model("UserSession", userSessionSchema),
    SystemSettings:
      masterDb.models.SystemSettings ||
      masterDb.model("SystemSettings", SystemSettings.schema),
    masterDb,
  };
};

/**
 * Gets isolated tenant database connection
 */
export const getTenantConnection = (tenantDbName) => {
  if (!tenantDbName) {
    return mongoose.connection;
  }
  return mongoose.connection.useDb(tenantDbName, { useCache: true });
};

/**
 * Registers and returns all models scoped to the specified tenant database
 */
export const getTenantModels = (tenantDbName) => {
  if (typeof _tenantModelsOverride === "function") {
    return _tenantModelsOverride(tenantDbName);
  }
  const effectiveDbName = tenantDbName || process.env.MASTER_DB_NAME || "salesbuster_master";
  if (_tenantModelsCache.has(effectiveDbName)) {
    return _tenantModelsCache.get(effectiveDbName);
  }
  const db = getTenantConnection(effectiveDbName);

  const models = {
    User: db.models.User || db.model("User", User.schema),
    Lead: db.models.Lead || db.model("Lead", Lead.schema),
    Followup: db.models.Followup || db.model("Followup", Followup.schema),
    Notification:
      db.models.Notification || db.model("Notification", Notification.schema),
    Conversation:
      db.models.Conversation || db.model("Conversation", Conversation.schema),
    Message: db.models.Message || db.model("Message", Message.schema),
    AILog: db.models.AILog || db.model("AILog", AILog.schema),
    AILimit: db.models.AILimit || db.model("AILimit", AILimit.schema),
    AssignmentState:
      db.models.AssignmentState ||
      db.model("AssignmentState", AssignmentState.schema),
    TelecallerAnalytics:
      db.models.TelecallerAnalytics ||
      db.model("TelecallerAnalytics", TelecallerAnalytics.schema),
    SystemSettings:
      db.models.SystemSettings ||
      db.model("SystemSettings", SystemSettings.schema),
    WhatsAppAuthState:
      db.models.WhatsAppAuthState ||
      db.model("WhatsAppAuthState", WhatsAppAuthState.schema),
    WhatsAppSession:
      db.models.WhatsAppSession ||
      db.model("WhatsAppSession", WhatsAppSession.schema),
    WhatsAppTemplate:
      db.models.WhatsAppTemplate ||
      db.model("WhatsAppTemplate", WhatsAppTemplate.schema),
    WhatsAppCampaign:
      db.models.WhatsAppCampaign ||
      db.model("WhatsAppCampaign", WhatsAppCampaign.schema),
    WhatsAppCampaignRecipient:
      db.models.WhatsAppCampaignRecipient ||
      db.model("WhatsAppCampaignRecipient", WhatsAppCampaignRecipient.schema),
    WhatsAppOptOut:
      db.models.WhatsAppOptOut ||
      db.model("WhatsAppOptOut", WhatsAppOptOut.schema),
    AIAssistantChat:
      db.models.AIAssistantChat ||
      db.model("AIAssistantChat", AIAssistantChat.schema),
    WAAccount:
      db.models.WAAccount || db.model("WAAccount", waAccountSchema),
    WAContact:
      db.models.WAContact || db.model("WAContact", waContactSchema),
    WAMessage:
      db.models.WAMessage || db.model("WAMessage", waMessageSchema),
    WAWebhookEvent:
      db.models.WAWebhookEvent || db.model("WAWebhookEvent", waWebhookEventSchema),
    InstagramAccount:
      db.models.InstagramAccount ||
      db.model("InstagramAccount", instagramAccountSchema),
    InstagramContact:
      db.models.InstagramContact ||
      db.model("InstagramContact", instagramContactSchema),
    InstagramAutomationRule:
      db.models.InstagramAutomationRule ||
      db.model("InstagramAutomationRule", instagramAutomationRuleSchema),
    InstagramMessage:
      db.models.InstagramMessage ||
      db.model("InstagramMessage", instagramMessageSchema),
    Event:
      db.models.Event || db.model("Event", Event.schema),
    EventContact:
      db.models.EventContact ||
      db.model("EventContact", EventContact.schema),
    ResolvedProspect:
      db.models.ResolvedProspect ||
      db.model("ResolvedProspect", ResolvedProspect.schema),
    TargetSearch:
      db.models.TargetSearch ||
      db.model("TargetSearch", TargetSearch.schema),
    TargetCompany:
      db.models.TargetCompany ||
      db.model("TargetCompany", TargetCompany.schema),
    TargetContact:
      db.models.TargetContact ||
      db.model("TargetContact", TargetContact.schema),
    TargetList:
      db.models.TargetList ||
      db.model("TargetList", TargetList.schema),
    ProviderUsage:
      db.models.ProviderUsage ||
      db.model("ProviderUsage", ProviderUsage.schema),
    CallRecord:
      db.models.CallRecord ||
      db.model("CallRecord", CallRecord.schema),
    MarketingCampaign:
      db.models.MarketingCampaign ||
      db.model("MarketingCampaign", marketingCampaignSchema),
    CashfreeOrder:
      db.models.CashfreeOrder ||
      db.model("CashfreeOrder", cashfreeOrderSchema),
    CashfreeWebhookEvent:
      db.models.CashfreeWebhookEvent ||
      db.model("CashfreeWebhookEvent", cashfreeWebhookEventSchema),
    db,
  };
  _tenantModelsCache.set(effectiveDbName, models);
  return models;
};

/**
 * Generates a clean, unique MongoDB database name for a new tenant
 */
export const generateTenantDbName = (orgName) => {
  const slug = (orgName || "tenant")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 24)
    .replace(/^_|_$/g, "");

  const randomSuffix = crypto.randomBytes(3).toString("hex");
  return `sb_tenant_${slug}_${randomSuffix}`;
};

/**
 * Generates a secure random initial password for tenant owner onboarding
 */
export const generateSecurePassword = (orgName = "") => {
  const clean = orgName.replace(/[^a-zA-Z]/g, "").slice(0, 4) || "Sales";
  const capitalized =
    clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
  const randomChars = crypto.randomBytes(4).toString("hex");
  const specialChars = ["!", "@", "#", "$", "*"];
  const special = specialChars[Math.floor(Math.random() * specialChars.length)];
  return `${capitalized}#${randomChars}${special}`;
};
