import bcrypt from "bcryptjs";
import fs from "fs";
import {
  getMasterModels,
  getTenantModels,
  generateTenantDbName,
  generateSecurePassword,
} from "../services/tenantManager.js";
import { getDefaultAISettings } from "../models/Organization.js";
import {
  ingestDocumentForOrg,
  deleteDocumentForOrg,
  listDocumentsForOrg,
} from "../services/knowledgeService.js";
import { sendTenantWelcomeEmail } from "../helpers/emailHelper.js";
import { getIO } from "../socket/socket.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { encryptApiKey, decryptApiKey } from "../utils/encryption.js";
import { invalidateVectorStoreForOrg } from "../ai/aiService.js";
import { checkAndResetDailyAiUsage } from "../services/aiUsageService.js";

/**
 * Calculates subscription end date given a start date and duration in months.
 * Sets time to 23:59:59.999.
 * Handles month and leap-year rollovers correctly (e.g. Sep 8 + 3 months -> Dec 8, Jan 31 + 1 month -> Feb 28/29, Aug 31 + 3 months -> Nov 30).
 */
const calculateSubscriptionEndDate = (startDate, months = 1) => {
  const start = new Date(startDate);
  const end = new Date(start);
  const targetMonth = end.getMonth() + months;
  end.setMonth(targetMonth);

  // Handle month rollover (e.g., August 31 + 1 month = Oct 1 -> roll back to Sep 30)
  if (end.getMonth() !== ((targetMonth % 12) + 12) % 12) {
    end.setDate(0);
  }

  end.setHours(23, 59, 59, 999);
  return end;
};

// Backward-compatible alias
const calculateOneMonthLater = calculateSubscriptionEndDate;

/**
 * Returns default duration in months for a given subscription plan
 */
const getDurationMonthsForPlan = (plan) => {
  const normalized = (plan || "").toLowerCase().trim();
  switch (normalized) {
    case "quarterly":
      return 3;
    case "annually":
    case "annual":
      return 12;
    case "monthly":
    default:
      return 1;
  }
};

// @desc    Provision a new client organization tenant
// @route   POST /api/organizations/provision
// @access  Protected (Super Admin)
export const provisionOrganization = async (req, res) => {
  try {
    const {
      name,
      email,
      mobile,
      website,
      seats,
      amountPaid,
      pricingPerSeat,
      paymentMethod,
      subscriptionPlan,
      months,
      subscriptionStartDate,
      notes,
    } = req.body;

    // 1. Validate required fields
    if (!name || !email || !mobile || seats == null || amountPaid == null) {
      return res.status(400).json({
        success: false,
        message:
          "Missing required fields: name, email, mobile, seats, and amountPaid are required.",
      });
    }

    const cleanEmail = email.toLowerCase().trim();
    const seatCount = parseInt(seats, 10);
    const paidAmount = Number(amountPaid);

    if (isNaN(seatCount) || seatCount < 1) {
      return res.status(400).json({
        success: false,
        message: "Seats must be a positive integer of at least 1.",
      });
    }

    if (isNaN(paidAmount) || paidAmount < 0) {
      return res.status(400).json({
        success: false,
        message: "Amount paid cannot be negative.",
      });
    }

    // Validate and normalize subscriptionPlan
    let normalizedPlan = (subscriptionPlan || "monthly").toLowerCase().trim();
    if (normalizedPlan === "annual") {
      normalizedPlan = "annually";
    }
    const allowedPlans = ["monthly", "quarterly", "annually"];
    if (!allowedPlans.includes(normalizedPlan)) {
      return res.status(400).json({
        success: false,
        message: `Invalid subscriptionPlan '${subscriptionPlan}'. Allowed values: ${allowedPlans.join(", ")}.`,
      });
    }

    const { Organization, AuthUser } = getMasterModels();

    // 2. Check if email is already in use
    const existingAuthUser = await AuthUser.findOne({ email: cleanEmail });
    if (existingAuthUser) {
      return res.status(400).json({
        success: false,
        message: `An account with email '${cleanEmail}' already exists.`,
      });
    }

    const existingOrg = await Organization.findOne({ email: cleanEmail });
    if (existingOrg) {
      return res.status(400).json({
        success: false,
        message: `An organization with billing email '${cleanEmail}' is already registered.`,
      });
    }

    // 3. Compute Subscription Dates based on selected plan or explicit months
    const durationMonths =
      months != null && !isNaN(parseInt(months, 10))
        ? Math.max(1, parseInt(months, 10))
        : getDurationMonthsForPlan(normalizedPlan);

    const startDate = subscriptionStartDate
      ? new Date(subscriptionStartDate)
      : new Date();
    const endDate = calculateSubscriptionEndDate(startDate, durationMonths);

    // 4. Generate unique tenant database name
    let tenantDbName = generateTenantDbName(name);
    let attempts = 0;
    while (await Organization.findOne({ tenantDbName })) {
      tenantDbName = generateTenantDbName(name);
      attempts++;
      if (attempts > 5) break;
    }

    // 5. Auto-generate secure password for the Organization Owner
    const temporaryPassword = generateSecurePassword(name);
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(temporaryPassword, salt);

    // 6. Create Organization in Master DB
    const organization = await Organization.create({
      name: name.trim(),
      email: cleanEmail,
      mobile: mobile.trim(),
      website: (website || "").trim(),
      seats: seatCount,
      amountPaid: paidAmount,
      pricingPerSeat:
        pricingPerSeat != null
          ? Number(pricingPerSeat)
          : Math.round(paidAmount / seatCount),
      paymentMethod: paymentMethod || "Manual",
      subscriptionPlan: normalizedPlan,
      subscriptionStartDate: startDate,
      subscriptionEndDate: endDate,
      status: "active",
      tenantDbName,
      notes: notes || "",
      aiSettings: getDefaultAISettings(name.trim()),
      createdBy: req.user?._id || null,
    });

    // 7. Register Owner in Master AuthUser registry
    const masterAuthUser = await AuthUser.create({
      email: cleanEmail,
      password: hashedPassword,
      name: `${name.trim()} Admin`,
      role: "sales manager",
      organizationId: organization._id,
      tenantDbName,
      isOrgOwner: true,
      status: "active",
    });

    // 8. Initialize tenant database and create Owner inside tenant DB
    const tenantModels = getTenantModels(tenantDbName);
    const tenantOwner = await tenantModels.User.create({
      _id: masterAuthUser._id, // Match AuthUser ID for consistent references
      name: `${name.trim()} Admin`,
      email: cleanEmail,
      password: hashedPassword,
      role: "sales manager",
      organizationId: organization._id,
      isOrgOwner: true,
      phone: mobile.trim(),
      status: "active",
    });

    // Link owner to Organization
    organization.ownerId = masterAuthUser._id;
    await organization.save();

    // 9. Dispatch Welcome Email to Organization Owner
    let emailSent = false;
    try {
      emailSent = await sendTenantWelcomeEmail({
        organization,
        ownerEmail: cleanEmail,
        temporaryPassword,
        loginUrl:
          process.env.FRONTEND_URL || "https://crm.salesbuster.com/login",
      });
    } catch (emailErr) {
      console.error("Failed to send welcome email:", emailErr);
    }

    // 10. Return success response with provisioned data and credentials
    res.status(201).json({
      success: true,
      message:
        "Tenant organization provisioned successfully. Welcome email with credentials dispatched.",
      data: {
        organization: {
          id: organization._id,
          name: organization.name,
          email: organization.email,
          mobile: organization.mobile,
          website: organization.website,
          seats: organization.seats,
          amountPaid: organization.amountPaid,
          pricingPerSeat: organization.pricingPerSeat,
          subscriptionPlan: organization.subscriptionPlan,
          subscriptionStartDate: organization.subscriptionStartDate,
          subscriptionEndDate: organization.subscriptionEndDate,
          status: organization.status,
          tenantDbName: organization.tenantDbName,
          createdBy: organization.createdBy || null,
        },
        emailSent,
        credentials: {
          email: cleanEmail,
          temporaryPassword,
          loginUrl:
            process.env.FRONTEND_URL || "https://crm.salesbuster.com/login",
        },
      },
    });
  } catch (error) {
    console.error("Error provisioning organization:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Server error while provisioning organization",
    });
  }
};

// @desc    Get all organizations with current seat metrics
// @route   GET /api/organizations
// @access  Protected (Super Admin)
export const getOrganizations = async (req, res) => {
  try {
    const { Organization } = getMasterModels();
    const organizations = await Organization.find().sort({ createdAt: -1 });

    // Populate live seat usage for each organization
    const orgsWithMetrics = await Promise.all(
      organizations.map(async (org) => {
        let usedSeats = 0;
        try {
          const tenantModels = getTenantModels(org.tenantDbName);
          usedSeats = await tenantModels.User.countDocuments({
            role: "sales person",
          });
        } catch (e) {
          console.error(
            `Error fetching user count for ${org.tenantDbName}:`,
            e,
          );
        }

        const isExpired =
          org.subscriptionEndDate &&
          new Date() > new Date(org.subscriptionEndDate);

        return {
          ...org.toJSON(),
          usedSeats,
          remainingSeats: Math.max(0, org.seats - usedSeats),
          isExpired: !!isExpired,
        };
      }),
    );

    res.status(200).json({
      success: true,
      count: orgsWithMetrics.length,
      data: orgsWithMetrics,
    });
  } catch (error) {
    console.error("Error fetching organizations:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching organizations",
    });
  }
};

// @desc    Get single organization by ID
// @route   GET /api/organizations/:id
// @access  Protected (Super Admin)
export const getOrganizationById = async (req, res) => {
  try {
    const { Organization } = getMasterModels();
    const org = await Organization.findById(req.params.id);

    if (!org) {
      return res.status(404).json({
        success: false,
        message: "Organization not found",
      });
    }

    let usedSeats = 0;
    try {
      const tenantModels = getTenantModels(org.tenantDbName);
      usedSeats = await tenantModels.User.countDocuments({
        role: "sales person",
      });
    } catch (e) {
      console.error(`Error counting users for ${org.tenantDbName}:`, e);
    }

    const isExpired =
      org.subscriptionEndDate && new Date() > new Date(org.subscriptionEndDate);

    res.status(200).json({
      success: true,
      data: {
        ...org.toJSON(),
        usedSeats,
        remainingSeats: Math.max(0, org.seats - usedSeats),
        isExpired: !!isExpired,
      },
    });
  } catch (error) {
    console.error("Error fetching organization:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching organization",
    });
  }
};

// @desc    Update organization licensed seats
// @route   PUT /api/organizations/:id/seats
// @access  Protected (Super Admin)
export const updateOrganizationSeats = async (req, res) => {
  try {
    const { seats } = req.body;
    const newSeats = parseInt(seats, 10);

    if (isNaN(newSeats) || newSeats < 1) {
      return res.status(400).json({
        success: false,
        message: "Seats must be a positive number of at least 1.",
      });
    }

    const { Organization } = getMasterModels();
    const org = await Organization.findById(req.params.id);

    if (!org) {
      return res.status(404).json({
        success: false,
        message: "Organization not found",
      });
    }

    // Check current used seats
    const tenantModels = getTenantModels(org.tenantDbName);
    const currentUsed = await tenantModels.User.countDocuments({
      role: "sales person",
    });

    org.seats = newSeats;
    await org.save();

    const io = getIO();
    if (io) {
      io.to(`org_${org._id}`).emit("organization_updated", {
        ...org.toJSON(),
        seats: newSeats,
        totalSeats: newSeats,
        usedSeats: currentUsed,
        remainingSeats: Math.max(0, newSeats - currentUsed),
      });
    }

    res.status(200).json({
      success: true,
      message: `Licensed seats updated to ${newSeats}`,
      data: {
        ...org.toJSON(),
        usedSeats: currentUsed,
        remainingSeats: Math.max(0, newSeats - currentUsed),
        seatWarning:
          currentUsed > newSeats
            ? `Warning: Current sales persons (${currentUsed}) exceeds new seat capacity (${newSeats}).`
            : null,
      },
    });
  } catch (error) {
    console.error("Error updating organization seats:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating seats",
    });
  }
};

// @desc    Renew organization subscription (Supports monthly, quarterly, annually, or custom months)
// @route   PUT /api/organizations/:id/renew
// @access  Protected (Super Admin)
export const renewSubscription = async (req, res) => {
  try {
    const { amountPaid, months, subscriptionPlan, paymentMethod } = req.body;

    const { Organization } = getMasterModels();
    const org = await Organization.findById(req.params.id);

    if (!org) {
      return res.status(404).json({
        success: false,
        message: "Organization not found",
      });
    }

    let targetPlan = org.subscriptionPlan || "monthly";
    if (subscriptionPlan) {
      let normalizedPlan = subscriptionPlan.toLowerCase().trim();
      if (normalizedPlan === "annual") normalizedPlan = "annually";
      const allowedPlans = ["monthly", "quarterly", "annually"];
      if (!allowedPlans.includes(normalizedPlan)) {
        return res.status(400).json({
          success: false,
          message: `Invalid subscriptionPlan '${subscriptionPlan}'. Allowed values: ${allowedPlans.join(", ")}.`,
        });
      }
      targetPlan = normalizedPlan;
    }

    const renewalMonths =
      months != null && !isNaN(parseInt(months, 10))
        ? Math.max(1, parseInt(months, 10))
        : getDurationMonthsForPlan(targetPlan);

    // If existing subscription is already expired, start from today
    // Otherwise extend from current subscriptionEndDate
    const now = new Date();
    const baseDate =
      org.subscriptionEndDate && new Date(org.subscriptionEndDate) > now
        ? new Date(org.subscriptionEndDate)
        : now;

    const newEndDate = calculateSubscriptionEndDate(baseDate, renewalMonths);

    org.subscriptionPlan = targetPlan;
    org.subscriptionEndDate = newEndDate;
    org.status = "active";
    if (amountPaid != null) {
      org.amountPaid = (org.amountPaid || 0) + Number(amountPaid);
    }
    if (paymentMethod) {
      org.paymentMethod = paymentMethod;
    }

    await org.save();

    const io = getIO();
    if (io) {
      io.to(`org_${org._id}`).emit("organization_updated", org.toJSON());
    }

    const planLabel = targetPlan.charAt(0).toUpperCase() + targetPlan.slice(1);

    res.status(200).json({
      success: true,
      message: `Subscription successfully renewed (${planLabel} plan) until ${newEndDate.toLocaleDateString("en-IN")}`,
      data: org,
    });
  } catch (error) {
    console.error("Error renewing subscription:", error);
    res.status(500).json({
      success: false,
      message: "Server error while renewing subscription",
    });
  }
};

// @desc    Toggle organization status (active / inactive / suspended)
// @route   PATCH /api/organizations/:id/status
// @access  Protected (Super Admin)
export const toggleStatus = async (req, res) => {
  try {
    const { status } = req.body;

    if (!["active", "inactive", "suspended"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Status must be 'active', 'inactive', or 'suspended'",
      });
    }

    const { Organization, AuthUser } = getMasterModels();
    const org = await Organization.findById(req.params.id);

    if (!org) {
      return res.status(404).json({
        success: false,
        message: "Organization not found",
      });
    }

    org.status = status;
    await org.save();

    // Sync status to all AuthUsers belonging to this org
    await AuthUser.updateMany(
      { organizationId: org._id },
      { status: status === "active" ? "active" : "inactive" },
    );

    // Also sync status to tenant database User collection
    try {
      if (org.tenantDbName) {
        const tenantModels = getTenantModels(org.tenantDbName);
        await tenantModels.User.updateMany(
          {},
          { status: status === "active" ? "active" : "inactive" },
        );
      }
    } catch (tenantUserErr) {
      console.error("Error updating tenant users status:", tenantUserErr);
    }

    const io = getIO();
    if (io) {
      io.to(`org_${org._id}`).emit("organization_updated", org.toJSON());
    }

    res.status(200).json({
      success: true,
      message: `Organization status set to '${status}'`,
      data: org,
    });
  } catch (error) {
    console.error("Error toggling organization status:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating organization status",
    });
  }
};

// @desc    Resend Welcome Email / regenerate credentials
// @route   POST /api/organizations/:id/resend-welcome
// @access  Protected (Super Admin)
export const resendWelcomeEmail = async (req, res) => {
  try {
    const { Organization, AuthUser } = getMasterModels();
    const org = await Organization.findById(req.params.id);

    if (!org) {
      return res.status(404).json({
        success: false,
        message: "Organization not found",
      });
    }

    const temporaryPassword = generateSecurePassword(org.name);
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(temporaryPassword, salt);

    // Update in Master AuthUser
    await AuthUser.updateOne(
      { _id: org.ownerId },
      { password: hashedPassword },
    );

    // Update in Tenant DB
    const tenantModels = getTenantModels(org.tenantDbName);
    await tenantModels.User.updateOne(
      { _id: org.ownerId },
      { password: hashedPassword },
    );

    const emailSent = await sendTenantWelcomeEmail({
      organization: org,
      ownerEmail: org.email,
      temporaryPassword,
      loginUrl: process.env.FRONTEND_URL || "https://crm.salesbuster.com/login",
    });

    res.status(200).json({
      success: true,
      message: "Welcome email resent with new temporary credentials.",
      emailSent,
      credentials: {
        email: org.email,
        temporaryPassword,
        loginUrl:
          process.env.FRONTEND_URL || "https://crm.salesbuster.com/login",
      },
    });
  } catch (error) {
    console.error("Error resending welcome email:", error);
    res.status(500).json({
      success: false,
      message: "Server error while resending welcome email",
    });
  }
};


// @desc    Get current organization profile (For Organization Owner)
// @route   GET /api/organizations/my-org
// @access  Protected (Org Owner / Manager)
export const getMyOrganization = async (req, res) => {
  try {
    const orgId = req.user?.organizationId || req.organization?._id;

    if (!orgId) {
      return res.status(404).json({
        success: false,
        message: "No organization profile associated with this account.",
      });
    }

    const { Organization } = getMasterModels();
    const org = await Organization.findById(orgId);

    if (!org) {
      return res.status(404).json({
        success: false,
        message: "Organization not found.",
      });
    }

    let usedSeats = 0;
    let totalLeads = 0;
    let totalFollowups = 0;

    try {
      const tenantModels = getTenantModels(org.tenantDbName);
      usedSeats = await tenantModels.User.countDocuments({
        role: "sales person",
      });
      totalLeads = await tenantModels.Lead.countDocuments();
      totalFollowups = await tenantModels.Followup.countDocuments();
    } catch (metricErr) {
      console.error(
        "Error fetching live tenant metrics for org profile:",
        metricErr,
      );
    }

    const now = new Date();
    const isExpired =
      org.subscriptionEndDate && new Date(org.subscriptionEndDate) < now;
    const remainingDays = org.subscriptionEndDate
      ? Math.ceil(
          (new Date(org.subscriptionEndDate) - now) / (1000 * 60 * 60 * 24),
        )
      : null;

    const defaults = getDefaultAISettings(org.name);
    checkAndResetDailyAiUsage(org);
    if (org.isModified()) {
      await org.save();
    }
    const orgJson = org.toJSON();
    const isAiConfigured = Boolean(
      org.aiSettings?.isAiConfigured !== undefined
        ? org.aiSettings.isAiConfigured
        : defaults.isAiConfigured,
    );
    const hasSalesPerson = usedSeats >= 1;

    const effectiveAiSettings = {
      ...defaults,
      ...(orgJson.aiSettings || {}),
      dailyAiUsage: org.aiSettings?.dailyAiUsage || defaults.dailyAiUsage,
      isAiConfigured,
      aiSetupCompletedAt:
        org.aiSettings?.aiSetupCompletedAt ||
        defaults.aiSetupCompletedAt ||
        null,
      services: Array.isArray(orgJson.aiSettings?.services)
        ? orgJson.aiSettings.services
        : defaults.services,
      qualificationFields: Array.isArray(orgJson.aiSettings?.qualificationFields)
        ? orgJson.aiSettings.qualificationFields
        : defaults.qualificationFields,
    };
    orgJson.aiSettings = effectiveAiSettings;
    orgJson.isAiConfigured = isAiConfigured;

    res.status(200).json({
      success: true,
      data: {
        ...orgJson,
        usedSeats,
        salesPersonCount: usedSeats,
        hasSalesPerson,
        isAiConfigured,
        remainingSeats: Math.max(0, org.seats - usedSeats),
        totalLeads,
        totalFollowups,
        isExpired: !!isExpired,
        remainingDays,
      },
    });
  } catch (error) {
    console.error("Error in getMyOrganization:", error);
    res.status(500).json({
      success: false,
      message:
        error.message || "Server error while fetching organization profile",
    });
  }
};

// ==========================================
// DYNAMIC AI SETTINGS & KNOWLEDGE BASE APIS
// ==========================================

// @desc    Get current tenant organization's AI settings & effective defaults
// @route   GET /api/organizations/my-org/ai-settings
// @access  Protected (Org Owner / Manager)
export const getMyAISettings = async (req, res) => {
  try {
    const orgId = req.user?.organizationId || req.organization?._id;
    if (!orgId) {
      return res.status(404).json({
        success: false,
        message: "No organization profile associated with this account.",
      });
    }

    const { Organization } = getMasterModels();
    const org = await Organization.findById(orgId);
    if (!org) {
      return res.status(404).json({
        success: false,
        message: "Organization not found.",
      });
    }

    const defaults = getDefaultAISettings(org.name);
    checkAndResetDailyAiUsage(org);
    if (org.isModified()) {
      await org.save();
    }
    const aiSettings = org.aiSettings || {};

    const effective = {
      geminiApiKey: decryptApiKey(aiSettings.geminiApiKey || ""),
      isGeminiKeyConfigured: Boolean(decryptApiKey(aiSettings.geminiApiKey || "")),
      isAiConfigured: Boolean(
        aiSettings.isAiConfigured !== undefined
          ? aiSettings.isAiConfigured
          : defaults.isAiConfigured,
      ),
      aiSetupCompletedAt:
        aiSettings.aiSetupCompletedAt || defaults.aiSetupCompletedAt || null,
      companyName: aiSettings.companyName || org.name || defaults.companyName,
      businessDescription:
        aiSettings.businessDescription || defaults.businessDescription || "",
      agentPersona: aiSettings.agentPersona || defaults.agentPersona,
      customInstructions:
        aiSettings.customInstructions || defaults.customInstructions,
      services: Array.isArray(aiSettings.services)
        ? aiSettings.services
        : defaults.services,
      qualificationFields: Array.isArray(aiSettings.qualificationFields)
        ? aiSettings.qualificationFields
        : defaults.qualificationFields,
      qdrantCollection:
        aiSettings.qdrantCollection || defaults.qdrantCollection,
      knowledgeDocs: aiSettings.knowledgeDocs || [],
      dailyAiUsage: aiSettings.dailyAiUsage || defaults.dailyAiUsage,
    };

    res.status(200).json({
      success: true,
      data: effective,
      isAiConfigured: effective.isAiConfigured,
      isCustomized: !!(
        org.aiSettings &&
        (org.aiSettings.services?.length > 0 || org.aiSettings.companyName)
      ),
    });
  } catch (error) {
    console.error("Error in getMyAISettings:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get organization services catalog (Mobile app & client friendly)
// @route   GET /api/organization/services or /api/organizations/services
// @access  Protected
export const getOrganizationServices = async (req, res) => {
  try {
    const orgId = req.user?.organizationId || req.organization?._id;
    let services = [];

    if (orgId) {
      const { Organization } = getMasterModels();
      const org = await Organization.findById(orgId);
      if (org) {
        const defaults = getDefaultAISettings(org.name);
        services =
          Array.isArray(org.aiSettings?.services) && org.aiSettings.services.length > 0
            ? org.aiSettings.services
            : defaults.services;
      }
    } else if (req.organization) {
      const defaults = getDefaultAISettings(req.organization.name);
      services =
        Array.isArray(req.organization.aiSettings?.services) &&
        req.organization.aiSettings.services.length > 0
          ? req.organization.aiSettings.services
          : defaults.services;
    }

    res.status(200).json({
      success: true,
      data: services,
    });
  } catch (error) {
    console.error("Error in getOrganizationServices:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get organization settings & profile (Mobile app & client friendly)
// @route   GET /api/organization/settings or /api/organizations/settings
// @access  Protected
export const getOrganizationSettings = getMyOrganization;

// @desc    Update current tenant organization's AI settings
// @route   PUT /api/organizations/my-org/ai-settings
// @access  Protected (Org Owner / Manager)
export const updateMyAISettings = async (req, res) => {
  try {
    const orgId = req.user?.organizationId || req.organization?._id;
    if (!orgId) {
      return res.status(404).json({
        success: false,
        message: "No organization profile associated with this account.",
      });
    }

    const { Organization } = getMasterModels();
    const org = await Organization.findById(orgId);
    if (!org) {
      return res.status(404).json({
        success: false,
        message: "Organization not found.",
      });
    }

    const {
      companyName,
      businessDescription,
      agentPersona,
      customInstructions,
      services,
      qualificationFields,
      qdrantCollection,
      isAiConfigured,
      geminiApiKey,
      dailyQuotaLimit,
    } = req.body;

    if (!org.aiSettings) org.aiSettings = {};

    // If attempting to mark AI as configured / complete, enforce strict business validations
    if (isAiConfigured === true) {
      // 1. Mandatory Gemini API Key (STRICT: NO GLOBAL FALLBACK)
      const existingDecryptedKey = decryptApiKey(org.aiSettings?.geminiApiKey);
      const targetKey =
        geminiApiKey !== undefined ? geminiApiKey.trim() : existingDecryptedKey;

      if (!targetKey) {
        return res.status(400).json({
          success: false,
          message:
            "A valid Google Gemini API Key is mandatory before activating your AI sales assistant.",
        });
      }

      // 2. Mandatory Services
      const targetServices = Array.isArray(services)
        ? services
        : org.aiSettings.services || [];
      const targetFields = Array.isArray(qualificationFields)
        ? qualificationFields
        : org.aiSettings.qualificationFields || [];

      if (!targetServices || targetServices.length === 0) {
        return res.status(400).json({
          success: false,
          message:
            "An organization must configure at least 1 service in its catalog before completing AI setup.",
        });
      }

      const invalidService = targetServices.find(
        (s) => !s.name || !s.name.trim(),
      );
      if (invalidService) {
        return res.status(400).json({
          success: false,
          message: "All services in catalog must have a valid non-empty name.",
        });
      }

      if (!targetFields || targetFields.length === 0) {
        return res.status(400).json({
          success: false,
          message:
            "An organization must define at least 1 lead qualification question in its schema before completing AI setup.",
        });
      }

      const invalidField = targetFields.find(
        (f) => !f.key || !f.key.trim() || !f.label || !f.label.trim(),
      );
      if (invalidField) {
        return res.status(400).json({
          success: false,
          message:
            "All qualification fields must have a valid identifier key and display label.",
        });
      }

      org.aiSettings.isAiConfigured = true;
      org.aiSettings.aiSetupCompletedAt = new Date();
    } else if (isAiConfigured === false) {
      org.aiSettings.isAiConfigured = false;
    }

    if (geminiApiKey !== undefined) {
      const trimmed = geminiApiKey.trim();
      org.aiSettings.geminiApiKey = trimmed ? encryptApiKey(trimmed) : "";
      invalidateVectorStoreForOrg(org);
    }

    if (companyName !== undefined) {
      org.aiSettings.companyName = companyName.trim() || org.name;
    }
    if (businessDescription !== undefined)
      org.aiSettings.businessDescription = businessDescription.trim();
    if (agentPersona !== undefined)
      org.aiSettings.agentPersona = agentPersona.trim();
    if (customInstructions !== undefined)
      org.aiSettings.customInstructions = customInstructions.trim();
    if (Array.isArray(services)) org.aiSettings.services = services;
    if (Array.isArray(qualificationFields))
      org.aiSettings.qualificationFields = qualificationFields;
    if (qdrantCollection !== undefined)
      org.aiSettings.qdrantCollection = qdrantCollection.trim();
    if (dailyQuotaLimit !== undefined) {
      const parsedLimit = parseInt(dailyQuotaLimit, 10);
      if (!isNaN(parsedLimit) && parsedLimit > 0) {
        if (!org.aiSettings.dailyAiUsage) {
          org.aiSettings.dailyAiUsage = {};
        }
        org.aiSettings.dailyAiUsage.dailyQuotaLimit = parsedLimit;
        org.markModified("aiSettings");
      }
    }

    await org.save();

    const responseSettings = org.aiSettings.toObject
      ? org.aiSettings.toObject()
      : { ...org.aiSettings };
    responseSettings.geminiApiKey = decryptApiKey(org.aiSettings.geminiApiKey);
    responseSettings.isGeminiKeyConfigured = Boolean(responseSettings.geminiApiKey);

    const io = getIO();
    if (io) {
      io.to(`org_${org._id}`).emit("ai_settings_updated", responseSettings);
      io.to(`org_${org._id}`).emit("organization_updated", org.toJSON());
    }

    res.status(200).json({
      success: true,
      message: "Organization AI settings updated successfully.",
      data: responseSettings,
      isAiConfigured: org.aiSettings.isAiConfigured,
    });
  } catch (error) {
    console.error("Error in updateMyAISettings:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Validate a Google Gemini API Key live
// @route   POST /api/organizations/my-org/validate-gemini-key
// @access  Protected (Org Owner / Manager)
export const validateGeminiApiKey = async (req, res) => {
  try {
    const orgId = req.user?.organizationId || req.organization?._id;
    let targetKey = req.body?.apiKey ? req.body.apiKey.trim() : null;

    if (!targetKey && orgId) {
      const { Organization } = getMasterModels();
      const org = await Organization.findById(orgId);
      if (org?.aiSettings?.geminiApiKey) {
        targetKey = decryptApiKey(org.aiSettings.geminiApiKey);
      }
    }

    if (!targetKey) {
      return res.status(400).json({
        success: false,
        message: "Please enter a Google Gemini API Key to test.",
      });
    }

    const genAI = new GoogleGenerativeAI(targetKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    await model.countTokens("SalesBuster health check");

    res.status(200).json({
      success: true,
      message: "Google Gemini API Key is valid and active!",
    });
  } catch (error) {
    console.error("[Validate Gemini Key] Error:", error.message);
    const msg =
      error.message?.toLowerCase().includes("api key not valid") ||
      error.message?.includes("API_KEY_INVALID")
        ? "Invalid Google Gemini API Key. Please verify your key in Google AI Studio."
        : error.message || "Failed to validate Gemini API Key.";
    res.status(400).json({
      success: false,
      message: msg,
    });
  }
};

// @desc    Upload & ingest knowledge document to organization Qdrant collection
// @route   POST /api/organizations/my-org/knowledge-base/upload
// @access  Protected (Org Owner / Manager)
export const uploadKnowledgeDoc = async (req, res) => {
  try {
    const orgId = req.user?.organizationId || req.organization?._id;
    if (!orgId) {
      if (req.file?.path && fs.existsSync(req.file.path))
        fs.unlinkSync(req.file.path);
      return res.status(404).json({
        success: false,
        message: "No organization associated with this account.",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload a document file (PDF, DOCX, TXT, MD).",
      });
    }

    const { Organization } = getMasterModels();
    const org = await Organization.findById(orgId);
    if (!org) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(404).json({
        success: false,
        message: "Organization not found.",
      });
    }

    const docRecord = await ingestDocumentForOrg({
      organization: org,
      filePath: req.file.path,
      originalName: req.file.originalname,
      fileSize: req.file.size,
    });

    if (fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanErr) {}
    }

    const io = getIO();
    if (io) {
      io.to(`org_${org._id}`).emit(
        "ai_knowledge_updated",
        org.aiSettings?.knowledgeDocs,
      );
    }

    res.status(201).json({
      success: true,
      message: `Document '${req.file.originalname}' indexed successfully into Qdrant (${docRecord.chunkCount} chunks).`,
      data: docRecord,
    });
  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanErr) {}
    }
    console.error("Error in uploadKnowledgeDoc:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Document indexing failed.",
    });
  }
};

// @desc    Delete a knowledge document from organization Qdrant collection
// @route   DELETE /api/organizations/my-org/knowledge-base/:docId
// @access  Protected (Org Owner / Manager)
export const deleteKnowledgeDoc = async (req, res) => {
  try {
    const orgId = req.user?.organizationId || req.organization?._id;
    const { docId } = req.params;

    const { Organization } = getMasterModels();
    const org = await Organization.findById(orgId);
    if (!org) {
      return res.status(404).json({
        success: false,
        message: "Organization not found.",
      });
    }

    await deleteDocumentForOrg({ organization: org, docId });

    const io = getIO();
    if (io) {
      io.to(`org_${org._id}`).emit(
        "ai_knowledge_updated",
        org.aiSettings?.knowledgeDocs,
      );
    }

    res.status(200).json({
      success: true,
      message: "Document removed from knowledge base.",
      docId,
    });
  } catch (error) {
    console.error("Error in deleteKnowledgeDoc:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==========================================
// SUPER ADMIN AI SETTINGS ENDPOINTS
// ==========================================

export const getOrgAISettings = async (req, res) => {
  try {
    const { id } = req.params;
    const { Organization } = getMasterModels();
    const org = await Organization.findById(id);
    if (!org) {
      return res
        .status(404)
        .json({ success: false, message: "Organization not found." });
    }

    const defaults = getDefaultAISettings(org.name);
    checkAndResetDailyAiUsage(org);
    if (org.isModified()) {
      await org.save();
    }
    const aiSettings = org.aiSettings || {};

    const effective = {
      geminiApiKey: decryptApiKey(aiSettings.geminiApiKey || ""),
      isGeminiKeyConfigured: Boolean(decryptApiKey(aiSettings.geminiApiKey || "")),
      companyName: aiSettings.companyName || org.name || defaults.companyName,
      businessDescription:
        aiSettings.businessDescription || defaults.businessDescription || "",
      agentPersona: aiSettings.agentPersona || defaults.agentPersona,
      customInstructions:
        aiSettings.customInstructions || defaults.customInstructions,
      services: Array.isArray(aiSettings.services)
        ? aiSettings.services
        : defaults.services,
      qualificationFields: Array.isArray(aiSettings.qualificationFields)
        ? aiSettings.qualificationFields
        : defaults.qualificationFields,
      qdrantCollection:
        aiSettings.qdrantCollection || defaults.qdrantCollection,
      knowledgeDocs: aiSettings.knowledgeDocs || [],
      dailyAiUsage: aiSettings.dailyAiUsage || defaults.dailyAiUsage,
    };

    res.status(200).json({ success: true, data: effective });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const updateOrgAISettings = async (req, res) => {
  try {
    const { id } = req.params;
    const { Organization } = getMasterModels();
    const org = await Organization.findById(id);
    if (!org) {
      return res
        .status(404)
        .json({ success: false, message: "Organization not found." });
    }

    const {
      companyName,
      businessDescription,
      agentPersona,
      customInstructions,
      services,
      qualificationFields,
      qdrantCollection,
      geminiApiKey,
      dailyQuotaLimit,
    } = req.body;

    if (!org.aiSettings) org.aiSettings = {};

    if (geminiApiKey !== undefined) {
      const trimmed = geminiApiKey.trim();
      org.aiSettings.geminiApiKey = trimmed ? encryptApiKey(trimmed) : "";
      invalidateVectorStoreForOrg(org);
    }

    if (companyName !== undefined)
      org.aiSettings.companyName = companyName.trim();
    if (businessDescription !== undefined)
      org.aiSettings.businessDescription = businessDescription.trim();
    if (agentPersona !== undefined)
      org.aiSettings.agentPersona = agentPersona.trim();
    if (customInstructions !== undefined)
      org.aiSettings.customInstructions = customInstructions.trim();
    if (Array.isArray(services)) org.aiSettings.services = services;
    if (Array.isArray(qualificationFields))
      org.aiSettings.qualificationFields = qualificationFields;
    if (qdrantCollection !== undefined)
      org.aiSettings.qdrantCollection = qdrantCollection.trim();
    if (dailyQuotaLimit !== undefined) {
      const parsedLimit = parseInt(dailyQuotaLimit, 10);
      if (!isNaN(parsedLimit) && parsedLimit > 0) {
        if (!org.aiSettings.dailyAiUsage) {
          org.aiSettings.dailyAiUsage = {};
        }
        org.aiSettings.dailyAiUsage.dailyQuotaLimit = parsedLimit;
        org.markModified("aiSettings");
      }
    }

    await org.save();

    const io = getIO();
    if (io) {
      io.to(`org_${org._id}`).emit("ai_settings_updated", org.aiSettings);
      io.to(`org_${org._id}`).emit("organization_updated", org.toJSON());
    }

    res.status(200).json({
      success: true,
      message: "Organization AI settings updated successfully.",
      data: org.aiSettings,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const uploadOrgKnowledgeDoc = async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload a document file (PDF, DOCX, TXT, MD).",
      });
    }

    const { Organization } = getMasterModels();
    const org = await Organization.findById(id);
    if (!org) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res
        .status(404)
        .json({ success: false, message: "Organization not found." });
    }

    const docRecord = await ingestDocumentForOrg({
      organization: org,
      filePath: req.file.path,
      originalName: req.file.originalname,
      fileSize: req.file.size,
    });

    if (fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanErr) {}
    }

    res.status(201).json({
      success: true,
      message: `Document '${req.file.originalname}' indexed successfully into Qdrant.`,
      data: docRecord,
    });
  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanErr) {}
    }
    res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteOrgKnowledgeDoc = async (req, res) => {
  try {
    const { id, docId } = req.params;
    const { Organization } = getMasterModels();
    const org = await Organization.findById(id);
    if (!org) {
      return res
        .status(404)
        .json({ success: false, message: "Organization not found." });
    }

    await deleteDocumentForOrg({ organization: org, docId });

    res.status(200).json({
      success: true,
      message: "Document removed from knowledge base.",
      docId,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
