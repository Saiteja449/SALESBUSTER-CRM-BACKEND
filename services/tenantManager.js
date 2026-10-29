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
import Organization, { organizationSchema } from "../models/Organization.js";
import AuthUser, { authUserSchema } from "../models/AuthUser.js";
import AppRelease, { appReleaseSchema } from "../models/AppRelease.js";
import WAAccount, { waAccountSchema } from "../models/WhatsAppAccount.js";
import WAContact, { waContactSchema } from "../models/WhatsAppContact.js";
import WAMessage, { waMessageSchema } from "../models/WhatsAppMessage.js";
import WAWebhookEvent, { waWebhookEventSchema } from "../models/WhatsAppWebhookEvent.js";

/**
 * Gets master database connection and models
 */
export const getMasterModels = () => {
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

  return {
    Organization: MasterOrg,
    AuthUser: MasterAuthUser,
    AppRelease: MasterAppRelease,
    WAAccount: MasterWAAccount,
    WAWebhookEvent: MasterWAWebhookEvent,
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
  const db = getTenantConnection(tenantDbName);

  return {
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
    Event:
      db.models.Event || db.model("Event", Event.schema),
    EventContact:
      db.models.EventContact ||
      db.model("EventContact", EventContact.schema),
    db,
  };
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
