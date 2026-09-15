import {
  verifyCredentials,
  fetchTemplates,
  uploadResumableMedia,
  createMessageTemplate,
  deleteMessageTemplate,
} from "../services/whatsappCloudService.js";
import {
  encryptApiKey,
  decryptApiKey,
  maskApiKey,
} from "../utils/encryption.js";
import { getMasterModels } from "../services/tenantManager.js";

/**
 * Normalizes phone string to clean digits only.
 */
export const normalizePhoneNumber = (phone) => {
  if (!phone) return "";
  let clean = String(phone).replace(/\D/g, "");
  if (clean.length === 10) {
    clean = "91" + clean; // Default country code 91 for 10-digit Indian numbers
  }
  return clean;
};

/**
 * Extracts parameter count and variable names like {{1}}, {{2}} from template components.
 */
export const extractTemplateVariables = (components) => {
  let count = 0;
  const variableNames = [];

  if (!Array.isArray(components)) return { count, variableNames };

  for (const comp of components) {
    if (comp.text && typeof comp.text === "string") {
      const matches = comp.text.match(/\{\{(\d+)\}\}/g);
      if (matches) {
        matches.forEach((m) => {
          const num = m.replace(/\D/g, "");
          if (!variableNames.includes(num)) {
            variableNames.push(num);
            count++;
          }
        });
      }
    }
  }

  return { count, variableNames: variableNames.sort((a, b) => Number(a) - Number(b)) };
};

/**
 * Gets WhatsApp Cloud API configuration status for the authenticated organization.
 */
export const getCloudStatus = async (req, res) => {
  try {
    const org = req.organization;
    if (!org) {
      return res.status(404).json({ success: false, message: "Organization not found." });
    }

    const cloud = org.whatsappCloudSettings || {};
    const orgId = org._id ? org._id.toString() : "";
    const webhookVerifyToken = cloud.webhookVerifyToken || "salesbuster_whatsapp_cloud_verify_token_2026";
    const webhookCallbackUrl = `https://api.salesbuster.ai/api/whatsapp/cloud/webhook/${orgId}`;

    res.status(200).json({
      success: true,
      data: {
        orgId,
        webhookCallbackUrl,
        webhookVerifyToken,
        isConfigured: !!cloud.isConfigured,
        wabaId: cloud.wabaId || "",
        phoneNumberId: cloud.phoneNumberId || "",
        displayPhoneNumber: cloud.displayPhoneNumber || "",
        verifiedName: cloud.verifiedName || "",
        qualityRating: cloud.qualityRating || "UNKNOWN",
        messagingLimitTier: cloud.messagingLimitTier || "TIER_1K",
        messagesPerSecond: cloud.messagesPerSecond || 5,
        hasToken: !!cloud.accessTokenEncrypted,
        maskedToken: cloud.accessTokenEncrypted ? maskApiKey(decryptApiKey(cloud.accessTokenEncrypted)) : "",
        hasWebhookVerifyToken: !!cloud.webhookVerifyToken,
        maskedWebhookVerifyToken: cloud.webhookVerifyToken ? maskApiKey(cloud.webhookVerifyToken) : "",
        lastSyncedAt: cloud.lastSyncedAt || null,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Connects and verifies WhatsApp Business Account credentials for the organization.
 */
export const connectCloudAccount = async (req, res) => {
  try {
    const { wabaId, phoneNumberId, accessToken, messagesPerSecond } = req.body;
    if (!wabaId || !phoneNumberId) {
      return res.status(400).json({
        success: false,
        message: "wabaId and phoneNumberId are required.",
      });
    }

    const { Organization } = getMasterModels();
    const org = await Organization.findById(req.organization._id);
    if (!org) {
      return res.status(404).json({ success: false, message: "Organization not found." });
    }

    // Use provided token or fall back to previously saved encrypted token
    let tokenToUse = accessToken ? accessToken.trim() : "";
    if (!tokenToUse && org.whatsappCloudSettings?.accessTokenEncrypted) {
      tokenToUse = decryptApiKey(org.whatsappCloudSettings.accessTokenEncrypted);
    }

    if (!tokenToUse) {
      return res.status(400).json({
        success: false,
        message: "Meta Access Token is required.",
      });
    }

    // 1. Verify against Meta Graph API
    const verified = await verifyCredentials(phoneNumberId.trim(), tokenToUse);

    // 2. Encrypt token using AES-256-GCM if a new token was provided, else keep existing
    const encryptedToken = accessToken
      ? encryptApiKey(tokenToUse)
      : org.whatsappCloudSettings.accessTokenEncrypted;

    // 3. Save to Master Organization record
    org.whatsappCloudSettings = {
      isConfigured: true,
      wabaId: wabaId.trim(),
      phoneNumberId: phoneNumberId.trim(),
      displayPhoneNumber: verified.displayPhoneNumber || "",
      verifiedName: verified.verifiedName || "",
      accessTokenEncrypted: encryptedToken,
      qualityRating: verified.qualityRating || "UNKNOWN",
      messagingLimitTier: verified.messagingLimitTier || "TIER_1K",
      messagesPerSecond: messagesPerSecond ? Math.min(80, Math.max(1, parseInt(messagesPerSecond))) : 5,
      webhookVerifyToken: org.whatsappCloudSettings?.webhookVerifyToken || "",
      lastSyncedAt: new Date(),
    };

    await org.save();

    res.status(200).json({
      success: true,
      message: "WhatsApp Business Account connected successfully.",
      data: {
        isConfigured: true,
        verifiedName: verified.verifiedName,
        displayPhoneNumber: verified.displayPhoneNumber,
        qualityRating: verified.qualityRating,
        messagingLimitTier: verified.messagingLimitTier,
      },
    });
  } catch (error) {
    const metaMessage = error.meta?.message || error.message;
    res.status(400).json({
      success: false,
      message: `Failed to connect WhatsApp account: ${metaMessage}`,
      error: error.meta || null,
    });
  }
};

/**
 * Disconnects Cloud API account from the organization.
 */
export const disconnectCloudAccount = async (req, res) => {
  try {
    const { Organization } = getMasterModels();
    const org = await Organization.findById(req.organization._id);
    if (!org) {
      return res.status(404).json({ success: false, message: "Organization not found." });
    }

    org.whatsappCloudSettings = {
      isConfigured: false,
      wabaId: "",
      phoneNumberId: "",
      displayPhoneNumber: "",
      verifiedName: "",
      accessTokenEncrypted: "",
      qualityRating: "UNKNOWN",
      messagingLimitTier: "TIER_1K",
      messagesPerSecond: 5,
      webhookVerifyToken: "",
      lastSyncedAt: null,
    };

    await org.save();

    res.status(200).json({
      success: true,
      message: "WhatsApp Business Account disconnected successfully.",
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Synchronizes approved message templates from Meta WABA into the tenant database.
 */
export const syncTemplates = async (req, res) => {
  try {
    const org = req.organization;
    const cloud = org?.whatsappCloudSettings;

    if (!cloud || !cloud.isConfigured || !cloud.wabaId || !cloud.accessTokenEncrypted) {
      return res.status(400).json({
        success: false,
        message: "WhatsApp Cloud API is not connected. Please connect credentials first.",
      });
    }

    const accessToken = decryptApiKey(cloud.accessTokenEncrypted);
    const metaTemplates = await fetchTemplates(cloud.wabaId, accessToken);

    const { WhatsAppTemplate } = req.tenantModels;
    const syncedTemplates = [];

    for (const mt of metaTemplates) {
      const { count, variableNames } = extractTemplateVariables(mt.components);

      const templateData = {
        metaTemplateId: mt.id,
        name: mt.name,
        language: mt.language || "en_US",
        category: mt.category || "UTILITY",
        status: mt.status || "APPROVED",
        components: mt.components || [],
        variableCount: count,
        variableNames,
        lastSyncedAt: new Date(),
      };

      const doc = await WhatsAppTemplate.findOneAndUpdate(
        { name: mt.name, language: templateData.language },
        templateData,
        { upsert: true, new: true }
      );
      syncedTemplates.push(doc);
    }

    // Update lastSyncedAt on Organization
    const { Organization } = getMasterModels();
    await Organization.findByIdAndUpdate(org._id, {
      "whatsappCloudSettings.lastSyncedAt": new Date(),
    });

    res.status(200).json({
      success: true,
      message: `Successfully synchronized ${syncedTemplates.length} message templates.`,
      count: syncedTemplates.length,
      templates: syncedTemplates,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Gets cached templates from tenant database.
 */
export const getTemplates = async (req, res) => {
  try {
    const { WhatsAppTemplate } = req.tenantModels;
    const { status, category, search } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (category) filter.category = category;
    if (search) filter.name = new RegExp(search.trim(), "i");

    const templates = await WhatsAppTemplate.find(filter).sort({ name: 1 });
    res.status(200).json({ success: true, data: templates });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Creates a new WhatsApp Message Template on Meta and persists it in the tenant DB.
 */
export const createTemplate = async (req, res) => {
  try {
    const org = req.organization;
    const cloud = org?.whatsappCloudSettings;

    if (!cloud || !cloud.isConfigured || !cloud.wabaId || !cloud.accessTokenEncrypted) {
      return res.status(400).json({
        success: false,
        message: "WhatsApp Cloud API is not connected. Please configure your Meta credentials in Settings first.",
      });
    }

    const accessToken = decryptApiKey(cloud.accessTokenEncrypted);

    // Parse body if sent via FormData
    let templatePayload = req.body;
    if (req.body.template && typeof req.body.template === "string") {
      try {
        templatePayload = JSON.parse(req.body.template);
      } catch (e) {
        return res.status(400).json({ success: false, message: "Invalid JSON in template field." });
      }
    }

    let { name, category, language, components, sampleVariables } = templatePayload;

    if (!name || typeof name !== "string") {
      return res.status(400).json({ success: false, message: "Template name is required." });
    }

    // Sanitize name: Meta requires lowercase letters, numbers, and underscores only
    const sanitizedName = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");

    if (!sanitizedName) {
      return res.status(400).json({
        success: false,
        message: "Template name must contain valid alphanumeric characters.",
      });
    }

    const validCategories = ["MARKETING", "UTILITY", "AUTHENTICATION"];
    const templateCategory = validCategories.includes(category) ? category : "MARKETING";
    const templateLanguage = language || "en_US";

    let metaComponents = Array.isArray(components) ? [...components] : [];

    // Handle uploaded media sample file if present
    if (req.file) {
      const mimeType = req.file.mimetype || "image/jpeg";
      const originalName = req.file.originalname || "sample_file";
      const handle = await uploadResumableMedia(
        accessToken,
        req.file.buffer,
        mimeType,
        originalName
      );

      const headerIdx = metaComponents.findIndex((c) => c.type === "HEADER");
      if (headerIdx !== -1) {
        metaComponents[headerIdx].example = {
          header_handle: [handle],
        };
      }
    }

    // Ensure variable examples are properly formatted for Meta review
    const bodyIdx = metaComponents.findIndex((c) => c.type === "BODY");
    if (bodyIdx !== -1) {
      const bodyText = metaComponents[bodyIdx].text || "";
      const varMatches = bodyText.match(/\{\{(\d+)\}\}/g);
      if (varMatches && varMatches.length > 0) {
        const uniqueVars = Array.from(new Set(varMatches)).sort((a, b) => {
          return parseInt(a.replace(/\D/g, "")) - parseInt(b.replace(/\D/g, ""));
        });

        const samplesArray = [];
        uniqueVars.forEach((v, idx) => {
          const varNum = v.replace(/\D/g, "");
          const val =
            (sampleVariables && (sampleVariables[varNum] || sampleVariables[idx])) ||
            `Sample${varNum}`;
          samplesArray.push(String(val));
        });

        metaComponents[bodyIdx].example = {
          body_text: [samplesArray],
        };
      }
    }

    // Ensure TEXT header with variables has example
    const headerIdx = metaComponents.findIndex((c) => c.type === "HEADER");
    if (headerIdx !== -1 && metaComponents[headerIdx].format === "TEXT") {
      const headerText = metaComponents[headerIdx].text || "";
      const varMatches = headerText.match(/\{\{(\d+)\}\}/g);
      if (varMatches && varMatches.length > 0) {
        const sampleVal =
          (sampleVariables && (sampleVariables["header"] || sampleVariables["h1"])) ||
          "Header Sample";
        metaComponents[headerIdx].example = {
          header_text: [String(sampleVal)],
        };
      }
    }

    const metaRequestData = {
      name: sanitizedName,
      category: templateCategory,
      language: templateLanguage,
      components: metaComponents,
    };

    // Submit to Meta Graph API
    const metaResult = await createMessageTemplate(cloud.wabaId, accessToken, metaRequestData);

    // Save to local tenant database
    const { WhatsAppTemplate } = req.tenantModels;
    const { count, variableNames } = extractTemplateVariables(metaComponents);

    const templateDoc = await WhatsAppTemplate.findOneAndUpdate(
      { name: sanitizedName, language: templateLanguage },
      {
        metaTemplateId: metaResult.id,
        name: sanitizedName,
        language: templateLanguage,
        category: metaResult.category || templateCategory,
        status: metaResult.status || "APPROVED",
        components: metaComponents,
        variableCount: count,
        variableNames,
        lastSyncedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    res.status(201).json({
      success: true,
      message: `Template "${sanitizedName}" created successfully with status: ${metaResult.status || "PENDING"}.`,
      data: templateDoc,
      meta: metaResult,
    });
  } catch (error) {
    console.error("Create template error:", error);
    const metaMessage = error.meta?.message || error.message;
    res.status(400).json({
      success: false,
      message: `Failed to create WhatsApp template: ${metaMessage}`,
      error: error.meta || null,
    });
  }
};

/**
 * Deletes a WhatsApp template from Meta and the tenant DB.
 */
export const deleteTemplate = async (req, res) => {
  try {
    const org = req.organization;
    const cloud = org?.whatsappCloudSettings;

    if (!cloud || !cloud.isConfigured || !cloud.wabaId || !cloud.accessTokenEncrypted) {
      return res.status(400).json({
        success: false,
        message: "WhatsApp Cloud API is not connected.",
      });
    }

    const { id } = req.params;
    const { WhatsAppTemplate } = req.tenantModels;
    const template = await WhatsAppTemplate.findById(id);

    if (!template) {
      return res.status(404).json({ success: false, message: "Template not found." });
    }

    const accessToken = decryptApiKey(cloud.accessTokenEncrypted);

    // Delete on Meta
    try {
      await deleteMessageTemplate(
        cloud.wabaId,
        accessToken,
        template.name,
        template.metaTemplateId
      );
    } catch (metaErr) {
      console.warn("Warning deleting template from Meta (may already be deleted):", metaErr.message);
    }

    // Delete from tenant DB
    await WhatsAppTemplate.findByIdAndDelete(id);

    res.status(200).json({
      success: true,
      message: `Template "${template.name}" deleted successfully.`,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Estimates audience size and excludes opted-out/invalid contacts based on filter criteria.
 */
export const estimateAudience = async (req, res) => {
  try {
    const { audienceCriteria } = req.body;
    const { Lead, WhatsAppOptOut } = req.tenantModels;

    const leadFilter = buildLeadAudienceQuery(audienceCriteria);
    const leads = await Lead.find(leadFilter).select("phone isOptedOut hasWhatsAppConsent");

    const optOutRecords = await WhatsAppOptOut.find({}).select("phone");
    const optOutSet = new Set(optOutRecords.map((r) => r.phone));

    const requireConsent = audienceCriteria?.requireConsent !== false;

    let totalMatching = leads.length;
    let optedOutCount = 0;
    let unconsentedCount = 0;
    let invalidPhoneCount = 0;
    let eligibleCount = 0;

    for (const lead of leads) {
      const clean = normalizePhoneNumber(lead.phone);
      if (!clean || clean.length < 10) {
        invalidPhoneCount++;
        continue;
      }
      if (lead.isOptedOut || optOutSet.has(clean)) {
        optedOutCount++;
        continue;
      }
      if (requireConsent && lead.hasWhatsAppConsent === false) {
        unconsentedCount++;
        continue;
      }
      eligibleCount++;
    }

    res.status(200).json({
      success: true,
      data: {
        totalMatching,
        optedOutCount,
        unconsentedCount,
        invalidPhoneCount,
        eligibleCount,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Helper to construct MongoDB Lead query from audienceCriteria.
 */
export const buildLeadAudienceQuery = (criteria = {}) => {
  const query = {};

  // Respect explicit opt-in consent requirement (default: true)
  if (criteria.requireConsent !== false) {
    query.hasWhatsAppConsent = { $ne: false };
  }

  if (criteria.filterType === "all") {
    return query;
  }

  if (criteria.filterType === "manual_selection" && Array.isArray(criteria.manualLeadIds)) {
    query._id = { $in: criteria.manualLeadIds };
    return query;
  }

  if (criteria.leadType === "old_leads_only") {
    query.isOldLead = true;
  } else if (criteria.leadType === "new_leads_only") {
    query.isOldLead = { $ne: true };
  }

  if (Array.isArray(criteria.leadStatus) && criteria.leadStatus.length > 0) {
    query.status = { $in: criteria.leadStatus };
  }

  if (Array.isArray(criteria.services) && criteria.services.length > 0) {
    query.service = { $in: criteria.services };
  }

  if (Array.isArray(criteria.assignedTo) && criteria.assignedTo.length > 0) {
    query.assignedTo = { $in: criteria.assignedTo };
  }

  if (Array.isArray(criteria.cities) && criteria.cities.length > 0) {
    query.city = { $in: criteria.cities };
  }

  if (Array.isArray(criteria.tags) && criteria.tags.length > 0) {
    query.tags = { $in: criteria.tags };
  }

  if (criteria.dateRange?.start || criteria.dateRange?.end) {
    query.createdAt = {};
    if (criteria.dateRange.start) {
      query.createdAt.$gte = new Date(criteria.dateRange.start);
    }
    if (criteria.dateRange.end) {
      query.createdAt.$lte = new Date(criteria.dateRange.end);
    }
  }

  return query;
};
