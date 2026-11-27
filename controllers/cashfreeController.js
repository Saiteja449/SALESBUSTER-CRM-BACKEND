import crypto from "crypto";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import {
  getTenantModels,
  getMasterModels,
  generateTenantDbName,
  generateSecurePassword,
} from "../services/tenantManager.js";
import { getDefaultAISettings } from "../models/Organization.js";
import { sendPaymentReceiptEmail } from "../helpers/emailHelper.js";
import { generateInvoicePdfBuffer } from "../helpers/invoicePdfHelper.js";
import {
  createCashfreePgOrder,
  fetchCashfreePgOrder,
  fetchCashfreePgPayments,
  verifyCashfreeWebhookSignature,
  getCashfreeBaseUrl,
} from "../services/cashfreeService.js";

/**
 * Authoritative Server-Side Pricing Catalog (Prevents Client-Side Parameter Tampering)
 */
export const DEFAULT_GST_PERCENT = 18;
export const GST_RATE = 0.18; // Statutory 18% Goods & Services Tax (GST) fallback

export const CASHFREE_PRICING_CATALOG = {
  addon: {
    whatsapp_campaigns: {
      quarterlyAmount: 2997,
      yearlyAmount: 11988,
      currency: "INR",
      title: "WhatsApp Campaigns Add-on",
    },
    target_intelligence: {
      quarterlyAmount: 4497,
      yearlyAmount: 17988,
      currency: "INR",
      title: "AI Target Intelligence Add-on",
    },
    bi_analyst: {
      quarterlyAmount: 2997,
      yearlyAmount: 11988,
      currency: "INR",
      title: "AI BI Analyst Add-on",
    },
    instagram_automation: {
      quarterlyAmount: 1497,
      yearlyAmount: 5988,
      currency: "INR",
      title: "Instagram Auto DM & Lead Gen Add-on",
    },
  },
  subscription: {
    starter: {
      amount: 1499,
      currency: "INR",
      title: "Starter Plan Monthly Subscription",
    },
    growth: {
      amount: 2999,
      currency: "INR",
      title: "Growth Plan Monthly Subscription",
    },
    enterprise: {
      amount: 7999,
      currency: "INR",
      title: "Enterprise Plan Monthly Subscription",
    },
    yearly: {
      amount: 53940,
      currency: "INR",
      title: "Yearly Plan (5 Sales Reps) Annual Subscription",
    },
    quarterly: {
      amount: 17985,
      currency: "INR",
      title: "Quarterly Plan (5 Sales Reps) Subscription",
    },
  },
};

export const DEFAULT_ADDON_CATALOG = [
  {
    id: "whatsapp_campaigns",
    title: "WhatsApp Campaigns",
    price: 999,
    quarterlyPrice: 2997,
    yearlyPrice: 11988,
    period: "quarterly",
    description: "Bulk broadcast marketing, official template creation, and delivery analytics.",
    icon: "Send",
    features: [
      "Bulk Campaign Broadcasts",
      "Template Manager & Variables",
      "Delivery & Read Rate Analytics",
      "Opt-out & Unsubscribe Handlers",
    ],
    isActive: true,
  },
  {
    id: "target_intelligence",
    title: "AI Target Intelligence",
    price: 1499,
    quarterlyPrice: 4497,
    yearlyPrice: 17988,
    period: "quarterly",
    description: "AI-powered web crawling, company dossier research, and executive decision maker mapping.",
    icon: "Brain",
    features: [
      "Domain Dossier Extraction",
      "Executive Decision Maker Finder",
      "Automated Pitch Deck Briefings",
      "Firmographic Enrichment",
    ],
    isActive: true,
  },
  {
    id: "bi_analyst",
    title: "AI BI Analyst",
    price: 999,
    quarterlyPrice: 2997,
    yearlyPrice: 11988,
    period: "quarterly",
    description: "Conversational natural language SQL & revenue intelligence charts on demand.",
    icon: "Bot",
    features: [
      "Natural Language Data Queries",
      "Instant Trend Charts & Exports",
      "Anomaly Detection Alerts",
      "Custom Executive Summaries",
    ],
    isActive: true,
  },
  {
    id: "instagram_automation",
    title: "Instagram Automation",
    price: 499,
    quarterlyPrice: 1497,
    yearlyPrice: 5988,
    period: "quarterly",
    description: "Auto-respond to post comments, DM keyword triggers, and capture high-intent buyers.",
    icon: "Instagram",
    features: [
      "Comment-to-DM Auto Triggers",
      "Story Mention Responder",
      "Lead Capture directly to CRM",
      "Keywords Filter & Safe Limits",
    ],
    isActive: true,
  },
];

export const getEffectiveAddonCatalog = (sysSettings) => {
  const normalize = (addon) => {
    const legacyPrice = Number(addon.price) || 0;
    return {
      ...addon,
      quarterlyPrice: Number.isFinite(Number(addon.quarterlyPrice))
        ? Number(addon.quarterlyPrice)
        : legacyPrice * 3,
      yearlyPrice: Number.isFinite(Number(addon.yearlyPrice))
        ? Number(addon.yearlyPrice)
        : legacyPrice * 12,
      period: "quarterly",
    };
  };
  if (sysSettings?.addonCatalogConfigured && Array.isArray(sysSettings.addonCatalog)) {
    return sysSettings.addonCatalog.map(normalize);
  }
  if (Array.isArray(sysSettings?.addonCatalog) && sysSettings.addonCatalog.length > 0) {
    return sysSettings.addonCatalog.map(normalize);
  }
  return DEFAULT_ADDON_CATALOG.map(normalize);
};

export const DEFAULT_PLAN_CATALOG = [
  {
    id: "yearly",
    title: "Yearly Plan",
    price: 53940,
    period: "year (₹4,495/mo)",
    durationMonths: 12,
    description: "Annual commitment for teams committed to steady sales growth.",
    popular: true,
    saveBadge: "Save 25%",
    features: [
      "Up to 5 Sales Rep Seats Included",
      "Unified WhatsApp & CRM Pipeline",
      "AI Follow-up Scheduling & Tracking",
      "Meta Cloud Broadcast Engine",
      "Priority Onboarding & Tech Support",
    ],
    isActive: true,
  },
  {
    id: "quarterly",
    title: "Quarterly Plan",
    price: 17985,
    period: "quarter (₹5,995/mo)",
    durationMonths: 3,
    description: "Standard flexibility with quarterly billing cycles.",
    popular: false,
    saveBadge: "3-Month Cycle",
    features: [
      "Up to 5 Sales Rep Seats Included",
      "Unified WhatsApp & CRM Pipeline",
      "AI Follow-up Tracking",
      "Flexible 3-Month Renewal Cycle",
    ],
    isActive: true,
  },
];

export const getEffectivePlanCatalog = (sysSettings) => {
  const normalize = (plan) => {
    const id = String(plan.id || "").trim().toLowerCase();
    const durationMonths = Number.isFinite(Number(plan.durationMonths)) && Number(plan.durationMonths) > 0
      ? Number(plan.durationMonths)
      : id === "yearly" || id === "annual"
      ? 12
      : 3;
    const price = Number(plan.price) || 0;
    const monthly = Math.round(price / durationMonths);
    const defaultPeriod = durationMonths === 12
      ? `year (₹${monthly.toLocaleString("en-IN")}/mo)`
      : `quarter (₹${monthly.toLocaleString("en-IN")}/mo)`;
    return {
      ...plan,
      id,
      price,
      durationMonths,
      period: plan.period || defaultPeriod,
      features: Array.isArray(plan.features) ? plan.features : [],
      isActive: plan.isActive !== false,
    };
  };
  if (sysSettings?.planCatalogConfigured && Array.isArray(sysSettings.planCatalog)) {
    return sysSettings.planCatalog.map(normalize);
  }
  if (Array.isArray(sysSettings?.planCatalog) && sysSettings.planCatalog.length > 0) {
    return sysSettings.planCatalog.map(normalize);
  }
  return DEFAULT_PLAN_CATALOG.map(normalize);
};

const normalizeAddonTerm = (term) => {
  if (term === "annual" || term === "annually" || term === "yearly") return "yearly";
  if (term === "quarterly") return "quarterly";
  return "";
};

const addonTermDays = (term) => (term === "yearly" ? 365 : 90);

const getAddonTermPrice = (addon, term) => {
  const normalizedTerm = normalizeAddonTerm(term);
  if (!normalizedTerm) throw new Error("Add-ons are available only on quarterly or yearly terms.");
  const price = Number(addon?.[normalizedTerm === "yearly" ? "yearlyPrice" : "quarterlyPrice"]);
  if (!Number.isFinite(price) || price < 0) throw new Error("This add-on is not priced for the selected term.");
  return price;
};

const getAddonTerm = (planId) => normalizeAddonTerm(planId);

export const calculateAddonQuote = ({ addon, term, startsAt = new Date(), expiresAt, planStart, prorate = false }) => {
  const termPrice = getAddonTermPrice(addon, term);
  const normalizedTerm = normalizeAddonTerm(term);
  let daysCovered = addonTermDays(normalizedTerm);
  let totalTermDays = daysCovered;
  let baseAmount = termPrice;
  let endDate = expiresAt ? new Date(expiresAt) : null;
  const startDate = new Date(startsAt);

  if (prorate) {
    if (!endDate || Number.isNaN(endDate.getTime()) || endDate <= startDate) {
      throw new Error("Your plan has no time remaining for an add-on purchase.");
    }
    const planStartDate = planStart ? new Date(planStart) : null;
    if (!planStartDate || Number.isNaN(planStartDate.getTime()) || planStartDate >= endDate) {
      throw new Error("Your subscription dates are incomplete. Contact support to purchase an add-on.");
    }
    totalTermDays = Math.max(1, Math.ceil((endDate.getTime() - planStartDate.getTime()) / 86400000));
    daysCovered = Math.min(totalTermDays, Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / 86400000)));
    baseAmount = Math.round((termPrice * daysCovered / totalTermDays) * 100) / 100;
  }

  return { term: normalizedTerm, termPrice, baseAmount, daysCovered, totalTermDays, startsAt: startDate, expiresAt: endDate };
};

export const isOrganizationAddonActive = (org, addonId, now = new Date()) => {
  const entitlement = Array.isArray(org?.addonEntitlements)
    ? [...org.addonEntitlements].reverse().find((item) => item.addonId === addonId)
    : null;
  if (entitlement) return (!entitlement.startsAt || new Date(entitlement.startsAt) <= now) && Boolean(entitlement.expiresAt && new Date(entitlement.expiresAt) > now);
  const legacyKey = {
    whatsapp_campaigns: "whatsappCampaigns",
    bi_analyst: "biAnalyst",
    target_intelligence: "targetIntelligence",
    instagram_automation: "instagramAutomation",
  }[addonId] || addonId;
  return Boolean(org?.addons?.[legacyKey] ||
    (addonId === "whatsapp_campaigns" && org?.hasWhatsAppCampaignsAddon) ||
    (addonId === "instagram_automation" && org?.hasInstagramAddon));
};

const setOrganizationAddon = (org, addonId, enabled) => {
  const key = {
    whatsapp_campaigns: "whatsappCampaigns",
    bi_analyst: "biAnalyst",
    target_intelligence: "targetIntelligence",
    instagram_automation: "instagramAutomation",
  }[addonId] || addonId;
  org.addons = org.addons || {};
  org.addons[key] = enabled;
  if (addonId === "whatsapp_campaigns") org.hasWhatsAppCampaignsAddon = enabled;
  if (addonId === "instagram_automation") org.hasInstagramAddon = enabled;
  org.markModified?.("addons");
};

const applyPaidAddonItems = (org, order) => {
  const items = Array.isArray(order.addonItems) ? order.addonItems : [];
  if (!items.length) {
    // Historical orders carried only a boolean entitlement and remain grandfathered.
    if (order.purpose === "addon" && order.addonType) setOrganizationAddon(org, order.addonType, true);
    return;
  }
  org.addonEntitlements = org.addonEntitlements || [];
  for (const item of items) {
    if (!item.addonId || !item.expiresAt) continue;
    const alreadyApplied = org.addonEntitlements.some((entitlement) => entitlement.orderId === order.orderId && entitlement.addonId === item.addonId);
    if (alreadyApplied) continue;
    setOrganizationAddon(org, item.addonId, true);
    org.addonEntitlements.push({
      addonId: item.addonId,
      startsAt: item.startsAt || new Date(),
      expiresAt: item.expiresAt,
      orderId: order.orderId,
      source: "payment",
    });
  }
}

const termPeriod = (term) => (term === "yearly" ? 12 : 3);

const getActivePlanCycle = (org, now = new Date()) => {
  const term = getAddonTerm(org?.subscriptionPlan || org?.plan);
  const end = org?.subscriptionEndDate ? new Date(org.subscriptionEndDate) : null;
  if (!term || !org || org.isTrial || org.status !== "active" || !end || end <= now) {
    throw new Error("An active quarterly or yearly subscription is required to purchase add-ons.");
  }
  const start = new Date(end);
  const endDay = start.getDate();
  start.setDate(1);
  start.setMonth(start.getMonth() - termPeriod(term));
  const lastDay = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  start.setDate(Math.min(endDay, lastDay));
  const recordedStart = org.subscriptionStartDate ? new Date(org.subscriptionStartDate) : null;
  if (recordedStart && recordedStart < end && Math.abs(recordedStart - start) < 4 * 86400000) start.setTime(recordedStart.getTime());
  return { term, startsAt: start, expiresAt: end, organization: org };
};

const buildAddonOrderItems = ({ addonIds, term, catalog, now = new Date(), cycle = null, prorate = false }) => {
  const uniqueIds = [...new Set((addonIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!uniqueIds.length) return [];
  return uniqueIds.map((addonId) => {
    const addon = catalog.find((item) => item.id === addonId && item.isActive !== false);
    if (!addon) throw new Error(`Add-on '${addonId}' is unavailable.`);
    if (cycle && isOrganizationAddonActive(cycle.organization, addonId, now)) {
      throw new Error(`${addon.title} is already active for your organization.`);
    }
    const quote = calculateAddonQuote({
      addon,
      term,
      startsAt: now,
      expiresAt: cycle?.expiresAt,
      planStart: cycle?.startsAt,
      prorate,
    });
    return {
      addonId,
      title: addon.title,
      term: quote.term,
      baseAmount: quote.baseAmount,
      daysCovered: quote.daysCovered,
      totalTermDays: quote.totalTermDays,
      startsAt: quote.startsAt,
      expiresAt: quote.expiresAt,
    };
  });
};

/**
 * Validates and resolves the authoritative price server-side,
 * including configurable GST, addons catalog, and additional sales representatives
 */
export const resolveAuthoritativePrice = ({
  purpose,
  planId,
  addonType,
  clientAmount,
  additionalReps = 0,
  dynamicGstRate,
  extraRepPriceYearly = 899,
  extraRepPriceQuarterly = 1199,
  dynamicAddons = null,
  dynamicPlans = null,
  addonTerm = "",
  addonItems = [],
}) => {
  const normalizedPurpose = purpose === "plan" ? "subscription" : purpose;
  let basePlanAmount = 0;
  let currency = "INR";
  let title = "";

  // Calculate additional sales representatives cost
  let additionalRepsCost = 0;
  const parsedAdditionalReps = Math.max(0, parseInt(additionalReps, 10) || 0);

  if (normalizedPurpose === "extra_reps") {
    const repsToAdd = Math.max(1, parsedAdditionalReps);
    if (planId === "yearly" || planId === "annual") {
      additionalRepsCost = repsToAdd * extraRepPriceYearly * 12;
      title = `${repsToAdd} Additional Sales Rep${repsToAdd > 1 ? "s" : ""} (Annual)`;
    } else if (planId === "quarterly") {
      additionalRepsCost = repsToAdd * extraRepPriceQuarterly * 3;
      title = `${repsToAdd} Additional Sales Rep${repsToAdd > 1 ? "s" : ""} (Quarterly)`;
    } else {
      throw new Error("Extra seats are available only on quarterly or yearly terms.");
    }
    basePlanAmount = 0;
    currency = "INR";
  } else if (normalizedPurpose === "addon") {
    const dynamicMatch = Array.isArray(dynamicAddons)
      ? dynamicAddons.find((a) => a.id === addonType && a.isActive !== false)
      : null;
    const addonConfig = dynamicMatch
      ? dynamicMatch
      : CASHFREE_PRICING_CATALOG.addon[addonType];
    if (!addonConfig) {
      throw new Error(`Invalid or unsupported addon type: '${addonType}'`);
    }
    basePlanAmount = addonItems.length
      ? addonItems.reduce((sum, item) => sum + Number(item.baseAmount || 0), 0)
      : (normalizeAddonTerm(addonTerm) === "yearly" ? (addonConfig.yearlyPrice ?? addonConfig.yearlyAmount) : (addonConfig.quarterlyPrice ?? addonConfig.quarterlyAmount));
    currency = "INR";
    title = addonItems.length > 1 ? `${addonItems.length} Add-ons` : addonConfig.title;
  } else if (normalizedPurpose === "subscription") {
    const normalizedPlanId = String(planId || "").toLowerCase();
    const canonicalPlanId = ["annual", "annually"].includes(normalizedPlanId) ? "yearly" : normalizedPlanId;
    if (!["quarterly", "yearly"].includes(canonicalPlanId)) {
      throw new Error("New subscriptions are available only quarterly or yearly.");
    }
    const dynamicPlan = Array.isArray(dynamicPlans)
      ? dynamicPlans.find((p) => p.id === canonicalPlanId && p.isActive !== false)
      : null;
    const planConfig = dynamicPlan
      ? {
          amount: Number(dynamicPlan.price),
          currency: "INR",
          title: dynamicPlan.title,
        }
      : CASHFREE_PRICING_CATALOG.subscription[canonicalPlanId] || CASHFREE_PRICING_CATALOG.subscription[planId];
    if (!planConfig) {
      throw new Error(`Invalid or unsupported subscription plan: '${planId}'`);
    }
    basePlanAmount = planConfig.amount + addonItems.reduce((sum, item) => sum + Number(item.baseAmount || 0), 0);
    currency = planConfig.currency;
    title = planConfig.title;
  } else if (normalizedPurpose === "wallet_credits" || normalizedPurpose === "service") {
    const parsedAmount = Number(clientAmount);
    if (!parsedAmount || isNaN(parsedAmount) || parsedAmount < 100) {
      throw new Error("Wallet recharge requires a minimum amount of ₹100.");
    }
    basePlanAmount = Math.round(parsedAmount);
    currency = "INR";
    title = `Wallet Credit Recharge - ₹${Math.round(parsedAmount)}`;
  } else {
    throw new Error(`Unsupported order purpose: '${purpose}'`);
  }

  // Calculate additional sales representatives cost for subscription bundles
  if (normalizedPurpose === "subscription" && parsedAdditionalReps > 0) {
    if (planId === "yearly" || planId === "annual") {
      const repYearlyCost = extraRepPriceYearly * 12; // 899 * 12 = 10,788
      additionalRepsCost = parsedAdditionalReps * repYearlyCost;
      title += ` + ${parsedAdditionalReps} Extra Sales Reps`;
    } else if (planId === "quarterly") {
      const repQuarterlyCost = extraRepPriceQuarterly * 3; // 1,199 * 3 = 3,597
      additionalRepsCost = parsedAdditionalReps * repQuarterlyCost;
      title += ` + ${parsedAdditionalReps} Extra Sales Reps`;
    }
  }

  const finalAdditionalReps =
    normalizedPurpose === "extra_reps" ? Math.max(1, parsedAdditionalReps) : parsedAdditionalReps;

  const subtotal = basePlanAmount + additionalRepsCost;

  // Resolve configurable GST rate (support percentage e.g. 18 or decimal e.g. 0.18)
  let gstPercent = DEFAULT_GST_PERCENT;
  if (typeof dynamicGstRate === "number" && !isNaN(dynamicGstRate)) {
    gstPercent = dynamicGstRate <= 1 && dynamicGstRate > 0 ? dynamicGstRate * 100 : dynamicGstRate;
  }
  const gstFraction = gstPercent / 100;

  const gstAmount = Math.round(subtotal * gstFraction * 100) / 100;
  const totalAmount = Math.round((subtotal + gstAmount) * 100) / 100;

  return {
    basePlanAmount,
    additionalReps: finalAdditionalReps,
    additionalRepsCost,
    baseAmount: subtotal,
    gstRate: gstFraction,
    gstPercent,
    gstAmount,
    amount: totalAmount, // Authoritative total payable amount charged via Cashfree
    currency,
    title,
    addonItems,
  };
};

const _activeOrderFulfillments = new Set();
const _activeOrgProvisionKeys = new Set();

/**
 * Fulfill organization subscription or addon upon successful payment and dispatch confirmation email
 */
export const fulfillOrderBenefits = async (order) => {
  const lockKey = order?.orderId || (order?._id ? String(order._id) : null);
  const emailKey = (order?.customerDetails?.customerEmail || "").toLowerCase().trim();
  const phoneKey = String(order?.customerDetails?.customerPhone || "").replace(/\D/g, "").slice(-10);
  const provisionLockKey = emailKey || phoneKey || null;
  try {
    if (!order || order.orderStatus !== "PAID") return;

    // Receipt delivery must never cause paid benefits to be applied twice.
    if (order.isFulfilled) {
      console.log(`[CashfreeFulfillment] Order ${order.orderId} already fulfilled and receipt email sent. Skipping.`);
      return;
    }

    if (lockKey && _activeOrderFulfillments.has(lockKey)) {
      console.log(`[CashfreeFulfillment] Order ${lockKey} fulfillment already in progress. Skipping concurrent call.`);
      return;
    }
    if (provisionLockKey && _activeOrgProvisionKeys.has(provisionLockKey)) {
      console.log(`[CashfreeFulfillment] Provisioning already in progress for ${provisionLockKey}. Skipping concurrent duplicate.`);
      return;
    }
    if (lockKey) _activeOrderFulfillments.add(lockKey);
    if (provisionLockKey) _activeOrgProvisionKeys.add(provisionLockKey);

    const { Organization, AuthUser, CashfreeOrder } = getMasterModels();
    let org = null;
    let temporaryPassword = null;
    let isNewAccount = false;

    // 1. Resolve existing organization by organizationId, email, or mobile
    if (order.organizationId) {
      org = await Organization.findById(order.organizationId);
    }
    const lookupEmail = (order.customerDetails?.customerEmail || "").toLowerCase().trim();
    const lookupDigits = String(order.customerDetails?.customerPhone || "").replace(/\D/g, "").slice(-10);
    if (!org && (lookupEmail || lookupDigits)) {
      const orConds = [];
      if (lookupEmail) orConds.push({ email: lookupEmail });
      if (lookupDigits.length >= 10) orConds.push({ mobile: new RegExp(`${lookupDigits}$`) });
      if (orConds.length > 0) {
        org = await Organization.findOne({ $or: orConds });
      }
    }

    // 2. If organization does not exist in master DB (website checkout for new user) -> Auto-provision
    if (!org) {
      isNewAccount = true;
      const custName = (order.customerDetails?.customerName || "").trim() || "SalesBuster Customer";
      const cleanEmail = (order.customerDetails?.customerEmail || "").toLowerCase().trim();
      const cleanPhone = (order.customerDetails?.customerPhone || "").trim();

      const normalizedPlan =
        order.planId === "yearly" || order.planId === "annual" || order.planId === "annually"
          ? "annual"
          : order.planId === "quarterly"
          ? "quarterly"
          : "monthly";

      const orgDisplayName =
        custName.toLowerCase().includes("workspace") ||
        custName.toLowerCase().includes("ltd") ||
        custName.toLowerCase().includes("pvt")
          ? custName
          : `${custName}'s Workspace`;

      // Determine seats and duration based on plan
      const extraReps = Number(order.additionalReps) || 0;
      let seatCount = 5 + extraReps;
      let durationMonths = 1;
      if (order.planId === "yearly" || order.planId === "annual") {
        durationMonths = 12;
        seatCount = 5 + extraReps;
      } else if (order.planId === "quarterly") {
        durationMonths = 3;
        seatCount = 5 + extraReps;
      } else if (order.planId === "enterprise") {
        durationMonths = 1;
        seatCount = 10 + extraReps;
      } else if (order.planId === "growth") {
        durationMonths = 1;
        seatCount = 5 + extraReps;
      } else {
        durationMonths = 1;
        seatCount = 1 + extraReps;
      }

      const startDate = new Date();
      const endDate = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + durationMonths);

      // Generate unique tenant database name
      let tenantDbName = generateTenantDbName(orgDisplayName);
      let attempts = 0;
      while (await Organization.findOne({ tenantDbName })) {
        tenantDbName = generateTenantDbName(orgDisplayName);
        attempts++;
        if (attempts > 5) break;
      }

      temporaryPassword = generateSecurePassword(custName);
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(temporaryPassword, salt);

      // Create Organization in Master DB
      org = await Organization.create({
        name: orgDisplayName,
        email: cleanEmail,
        mobile: cleanPhone,
        seats: seatCount,
        amountPaid: order.orderAmount,
        pricingPerSeat: Math.round(order.orderAmount / seatCount),
        paymentMethod: order.paymentDetails?.paymentMethod || "Cashfree PG",
        subscriptionPlan: normalizedPlan,
        subscriptionStartDate: startDate,
        subscriptionEndDate: endDate,
        status: "active",
        tenantDbName,
        notes: order.notes || "Subscribed via Cashfree Payment Gateway",
        aiSettings: getDefaultAISettings(orgDisplayName),
      });

      // Register Owner in Master AuthUser registry
      let masterAuthUser = await AuthUser.findOne({ email: cleanEmail });
      if (masterAuthUser) {
        masterAuthUser.password = hashedPassword;
        masterAuthUser.name = masterAuthUser.name || `${custName} Admin`;
        masterAuthUser.role = "sales manager";
        masterAuthUser.organizationId = org._id;
        masterAuthUser.tenantDbName = tenantDbName;
        masterAuthUser.isOrgOwner = true;
        masterAuthUser.status = "active";
        await masterAuthUser.save();
      } else {
        masterAuthUser = await AuthUser.create({
          email: cleanEmail,
          phone: cleanPhone || undefined,
          password: hashedPassword,
          name: `${custName} Admin`,
          role: "sales manager",
          organizationId: org._id,
          tenantDbName,
          isOrgOwner: true,
          status: "active",
        });
      }

      // Initialize tenant database and create Owner inside tenant DB
      const tenantModels = getTenantModels(tenantDbName);
      await tenantModels.User.findOneAndUpdate(
        { email: cleanEmail },
        {
          $set: {
            _id: masterAuthUser._id,
            name: `${custName} Admin`,
            email: cleanEmail,
            password: hashedPassword,
            role: "sales manager",
            organizationId: org._id,
            isOrgOwner: true,
            phone: cleanPhone,
            status: "active",
          },
        },
        { upsert: true, new: true }
      );

      org.ownerId = masterAuthUser._id;
      applyPaidAddonItems(org, order);
      await org.save();

      order.organizationId = org._id;
      console.log(`[CashfreeFulfillment] Auto-provisioned new tenant organization: ${org._id} (${org.name})`);
    } else {
      // Existing Organization: fulfill addon, extra_reps, or subscription
      if (order.purpose === "extra_reps") {
        const repsAdded = Math.max(1, Number(order.additionalReps) || 1);
        org.seats = (Number(org.seats) || 1) + repsAdded;
        org.amountPaid = (org.amountPaid || 0) + (order.orderAmount || 0);
      } else if (order.purpose === "subscription") {
        if (order.planId) {
          const normalizedPlan =
            order.planId === "yearly" || order.planId === "annual" || order.planId === "annually"
              ? "annual"
              : order.planId === "quarterly"
              ? "quarterly"
              : "monthly";
          org.subscriptionPlan = normalizedPlan;
          org.plan = order.planId;
          org.status = "active";

          let extensionMonths = 1;
          if (order.planId === "yearly" || order.planId === "annual") extensionMonths = 12;
          else if (order.planId === "quarterly") extensionMonths = 3;

          const currentEnd =
            !org.isTrial && org.subscriptionEndDate && new Date(org.subscriptionEndDate) > new Date()
              ? new Date(org.subscriptionEndDate)
              : new Date();

          const newEnd = new Date(currentEnd);
          newEnd.setMonth(newEnd.getMonth() + extensionMonths);
          org.subscriptionStartDate = currentEnd;
          org.subscriptionEndDate = newEnd;
          org.isTrial = false;
          org.trialConverted = true;
          org.accountType = "crm";
          org.seats = Math.max(Number(org.seats) || 0, 5 + (Number(order.additionalReps) || 0));
          org.amountPaid = (org.amountPaid || 0) + (order.orderAmount || 0);
          if (order.additionalReps) {
            const totalSeats = 5 + (Number(order.additionalReps) || 0);
            org.seats = Math.max(org.seats || 1, totalSeats);
          }
        }
      }

      applyPaidAddonItems(org, order);
      await org.save();
      console.log(`[CashfreeFulfillment] Benefits successfully applied for org: ${org._id}`);
    }

    // 3. Dispatch Payment Receipt & Confirmation Email
    const targetEmail = order.customerDetails?.customerEmail || org?.email;
    if (targetEmail && !order.receiptEmailSent) {
      try {
        let shouldSend = true;
        if (order._id && typeof CashfreeOrder?.findOneAndUpdate === "function") {
          const claimed = await CashfreeOrder.findOneAndUpdate(
            { _id: order._id, receiptEmailSent: { $ne: true } },
            { $set: { receiptEmailSent: true } },
            { new: true }
          );
          if (!claimed) {
            shouldSend = false;
            console.log(`[CashfreeFulfillment] Receipt email already claimed/sent for ${order.orderId}. Skipping duplicate.`);
          }
        }

        if (shouldSend) {
          const appLoginUrl =
            process.env.CRM_APP_URL ||
            process.env.APP_URL ||
            process.env.FRONTEND_URL ||
            "https://betaapp.salesbuster.ai/";

          const emailResult = await sendPaymentReceiptEmail({
            order,
            organization: org,
            temporaryPassword,
            isNewAccount,
            loginUrl: appLoginUrl,
          });

          if (emailResult) {
            order.receiptEmailSent = true;
            console.log(`[CashfreeFulfillment] Payment receipt email sent to ${targetEmail}`);
          } else {
            if (order._id && typeof CashfreeOrder?.updateOne === "function") {
              await CashfreeOrder.updateOne({ _id: order._id }, { $set: { receiptEmailSent: false } });
            }
            console.warn(`[CashfreeFulfillment] Payment receipt email could not be delivered to ${targetEmail}`);
          }
        }
      } catch (emailErr) {
        if (order._id && typeof CashfreeOrder?.updateOne === "function") {
          await CashfreeOrder.updateOne({ _id: order._id }, { $set: { receiptEmailSent: false } }).catch(() => {});
        }
        console.error("[CashfreeFulfillment] Error dispatching payment receipt email:", emailErr.message);
      }
    }

    order.isFulfilled = true;
    await order.save();
  } catch (err) {
    console.error("[CashfreeFulfillment] Error fulfilling order benefits:", err.message);
  } finally {
    if (lockKey) _activeOrderFulfillments.delete(lockKey);
    if (provisionLockKey) _activeOrgProvisionKeys.delete(provisionLockKey);
  }
};

/**
 * POST /api/payment/cashfree/create-order
 * Initiates Cashfree PG Order with server-side validated pricing
 */
export const createOrderHandler = async (req, res) => {
  try {
    let organizationId = req.user?.organizationId || req.organization?._id;
    if (!organizationId) {
      // Public website checkout: prevent duplicate organizations with same email or mobile
      const custEmail = (req.body.customerDetails?.customerEmail || "").toLowerCase().trim();
      const custDigits = String(req.body.customerDetails?.customerPhone || "").replace(/\D/g, "").slice(-10);
      const { Organization, AuthUser } = getMasterModels();
      const orConds = [];
      if (custEmail) orConds.push({ email: custEmail });
      if (custDigits.length >= 10) orConds.push({ mobile: new RegExp(`${custDigits}$`) });

      if (orConds.length > 0 && Organization) {
        const existingOrg = await Organization.findOne({ $or: orConds }).lean();
        if (existingOrg && existingOrg.accountType !== "guest") {
          return res.status(409).json({
            success: false,
            code: "DUPLICATE_ORGANIZATION",
            message:
              "An organization with this email or mobile number is already registered. Please log in to your CRM to upgrade or renew.",
          });
        }
        if (existingOrg) {
          organizationId = existingOrg._id;
        }
      }
      if (!organizationId && orConds.length > 0 && AuthUser) {
        const authOr = [];
        if (custEmail) authOr.push({ email: custEmail });
        if (custDigits.length >= 10) authOr.push({ phone: new RegExp(`${custDigits}$`) });
        const existingUser = authOr.length > 0 ? await AuthUser.findOne({ $or: authOr }).lean() : null;
        if (existingUser && existingUser.accountType !== "guest") {
          return res.status(409).json({
            success: false,
            code: "DUPLICATE_ACCOUNT",
            message:
              "An account with this email or mobile number already exists. Please log in to your CRM to manage billing.",
          });
        }
      }
      if (!organizationId) {
        organizationId = new mongoose.Types.ObjectId();
      }
    }

    const {
      purpose = "addon",
      planId = "",
      addonType = "",
      addonIds = [],
      addonTerm = "",
      additionalReps = 0,
      orderNote = "",
      customerDetails = {},
      returnUrl = "",
      orderAmount: clientAmount,
    } = req.body;

    // Load dynamic pricing and GST settings from SystemSettings if configured
    const { SystemSettings } = getMasterModels();
    let sysSettings = null;
    if (SystemSettings && typeof SystemSettings.findOne === "function") {
      sysSettings = await SystemSettings.findOne().lean().catch(() => null);
    }
    const dynamicGstRate = typeof sysSettings?.gstRate === "number" ? sysSettings.gstRate : undefined;
    const extraRepPriceYearly = typeof sysSettings?.extraRepMonthlyPriceYearly === "number" ? sysSettings.extraRepMonthlyPriceYearly : 899;
    const extraRepPriceQuarterly = typeof sysSettings?.extraRepMonthlyPriceQuarterly === "number" ? sysSettings.extraRepMonthlyPriceQuarterly : 1199;

    const { Organization } = getMasterModels();
    let billingOrganization = req.organization || null;
    if (!billingOrganization && organizationId && Organization) {
      billingOrganization = await Organization.findById(organizationId).catch(() => null);
    }
    const catalog = getEffectiveAddonCatalog(sysSettings).filter((a) => a.isActive !== false);
    let resolvedAddonTerm = normalizeAddonTerm(addonTerm);
    let addonItems = [];
    let cycle = null;
    if (purpose === "addon") {
      if (!billingOrganization) throw new Error("An active subscription is required to purchase add-ons.");
      cycle = getActivePlanCycle(billingOrganization);
      resolvedAddonTerm = cycle.term;
      addonItems = buildAddonOrderItems({
        addonIds: addonIds.length ? addonIds : [addonType],
        term: cycle.term,
        catalog,
        cycle,
        prorate: true,
      });
    } else if (purpose === "subscription" && Array.isArray(addonIds) && addonIds.length) {
      resolvedAddonTerm = getAddonTerm(planId);
      if (!resolvedAddonTerm) throw new Error("Subscriptions are available only quarterly or yearly.");
      const periodStart = !billingOrganization?.isTrial && billingOrganization?.subscriptionEndDate && new Date(billingOrganization.subscriptionEndDate) > new Date()
        ? new Date(billingOrganization.subscriptionEndDate)
        : new Date();
      const periodEnd = new Date(periodStart);
      periodEnd.setMonth(periodEnd.getMonth() + termPeriod(resolvedAddonTerm));
      addonItems = buildAddonOrderItems({
        addonIds,
        term: resolvedAddonTerm,
        catalog,
        now: periodStart,
        cycle: { startsAt: periodStart, expiresAt: periodEnd },
      });
    }

    const planCatalog = getEffectivePlanCatalog(sysSettings).filter((p) => p.isActive !== false);

    // 1. Authoritative Server-Side Price Resolution (prevents parameter tampering)
    const priceResolution = resolveAuthoritativePrice({
      purpose,
      planId,
      addonType,
      clientAmount,
      additionalReps,
      dynamicGstRate,
      extraRepPriceYearly,
      extraRepPriceQuarterly,
      dynamicAddons: catalog,
      dynamicPlans: planCatalog,
      addonTerm: resolvedAddonTerm,
      addonItems,
    });
    const finalAmount = priceResolution.amount;
    const finalCurrency = priceResolution.currency;

    // 2. Customer attributes
    const customerId =
      customerDetails.customerId ||
      `cust_${String(req.user?._id || organizationId).substring(0, 16)}`;
    const customerName =
      customerDetails.customerName ||
      req.user?.name ||
      req.organization?.name ||
      "SalesBuster Customer";
    const customerEmail =
      customerDetails.customerEmail ||
      req.user?.email ||
      req.organization?.email ||
      "billing@salesbuster.ai";
    const customerPhone =
      customerDetails.customerPhone ||
      req.user?.phone ||
      req.organization?.phone ||
      "9999999999";

    // 3. Generate unique order ID
    const randomHex = crypto.randomBytes(3).toString("hex");
    const orgShort = String(organizationId).slice(-6);
    const orderId = `sb_ord_${orgShort}_${Date.now()}_${randomHex}`;

    // Webhook and redirect return URLs
    const appBaseUrl =
      process.env.APP_URL || process.env.FRONTEND_URL || "https://salesbuster.ai";
    const backendBaseUrl =
      process.env.BACKEND_URL || "https://betaapi.salesbuster.ai";

    let finalReturnUrl =
      returnUrl || `${appBaseUrl}/payment/status?order_id={order_id}`;
    let finalNotifyUrl = `${backendBaseUrl}/api/payment/cashfree/webhook`;

    // Cashfree Production strictly enforces https:// on returnUrl and notifyUrl.
    // For sandbox checkout, keep localhost return URLs so local payment testing
    // returns to the local CRM instead of the production website.
    const isCashfreeSandbox = getCashfreeBaseUrl().includes("sandbox.cashfree.com");
    if (!isCashfreeSandbox && finalReturnUrl.startsWith("http://")) {
      finalReturnUrl = finalReturnUrl.replace(
        /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i,
        "https://salesbuster.ai"
      );
    }
    if (!isCashfreeSandbox && finalNotifyUrl.startsWith("http://")) {
      finalNotifyUrl = finalNotifyUrl.replace(
        /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i,
        "https://betaapi.salesbuster.ai"
      );
    }

    // 4. Call Cashfree PG Order API
    const cfResult = await createCashfreePgOrder({
      orderId,
      orderAmount: finalAmount,
      orderCurrency: finalCurrency,
      customerDetails: {
        customerId,
        customerName,
        customerEmail,
        customerPhone,
      },
      orderMeta: {
        returnUrl: finalReturnUrl,
        notifyUrl: finalNotifyUrl,
      },
      orderTags: {
        organizationId: String(organizationId),
        userId: String(req.user?._id || ""),
        purpose,
        addonType,
      },
      orderNote: orderNote || priceResolution.title,
    });

    // 5. Persist order in Master DB (Ensures cross-tenant webhook indexing and lookup)
    const { CashfreeOrder } = getMasterModels();

    const orderDoc = {
      organizationId,
      userId: req.user?._id || null,
      orderId: cfResult.orderId,
      cfOrderId: cfResult.cfOrderId,
      paymentSessionId: cfResult.paymentSessionId,
      orderAmount: cfResult.orderAmount,
      baseAmount: priceResolution.baseAmount,
      gstAmount: priceResolution.gstAmount,
      gstRate: priceResolution.gstRate,
      additionalReps: priceResolution.additionalReps,
      totalSeats: 5 + priceResolution.additionalReps,
      orderCurrency: cfResult.orderCurrency,
      orderStatus: cfResult.orderStatus || "ACTIVE",
      purpose,
      planId,
      addonType,
      addonTerm: resolvedAddonTerm,
      addonItems: priceResolution.addonItems,
      customerDetails: {
        customerId,
        customerName,
        customerEmail,
        customerPhone,
      },
      orderMeta: {
        returnUrl: finalReturnUrl,
        notifyUrl: finalNotifyUrl,
      },
      notes: orderNote || priceResolution.title,
      rawResponse: cfResult.rawResponse,
    };

    const newOrder = await CashfreeOrder.create(orderDoc);

    // Also persist in tenant-scoped model if tenant connection is active
    try {
      if (req.tenantModels?.CashfreeOrder) {
        await req.tenantModels.CashfreeOrder.create(orderDoc);
      }
    } catch (tenantSaveErr) {
      // Non-blocking fallback
    }

    const responsePayload = {
      orderId: newOrder.orderId,
      cfOrderId: newOrder.cfOrderId,
      paymentSessionId: newOrder.paymentSessionId,
      orderStatus: newOrder.orderStatus,
      orderAmount: newOrder.orderAmount,
      baseAmount: newOrder.baseAmount,
      gstAmount: newOrder.gstAmount,
      gstRate: newOrder.gstRate,
      additionalReps: newOrder.additionalReps || 0,
      totalSeats: newOrder.totalSeats || 5,
      orderCurrency: newOrder.orderCurrency,
      addonItems: newOrder.addonItems || [],
      isDevMock: Boolean(cfResult.isDevMock),
      environment: process.env.CASHFREE_ENV || "SANDBOX",
    };

    return res.status(201).json({
      success: true,
      message: "Cashfree order created successfully.",
      order: responsePayload,
      ...responsePayload,
    });
  } catch (error) {
    console.error("[CashfreeCreateOrder] Error:", error);
    const clientValidationError = /only quarterly or yearly|quarterly.*yearly|yearly.*quarterly|required to purchase add-ons|already active|add-on .* unavailable|no time remaining|subscription dates are incomplete|extra seats are available only|invalid or unsupported (subscription plan|addon type)/i.test(error.message || "");
    return res.status(error.status || (clientValidationError ? 400 : 500)).json({
      success: false,
      message: error.message || "Failed to create Cashfree order.",
      error: error.data || null,
    });
  }
};

/**
 * GET /api/payment/cashfree/order/:orderId
 * Fetches order status, prevents IDOR across organizations, and synchronizes status
 */
export const getOrderStatusHandler = async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!orderId) {
      return res.status(400).json({ success: false, message: "Order ID is required." });
    }

    const organizationId = req.user?.organizationId || req.organization?._id;
    const { CashfreeOrder } = getMasterModels();

    const localOrder = await CashfreeOrder.findOne({ orderId });
    if (!localOrder) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    // IDOR Prevention: Enforce organization isolation if authenticated user
    const isPublicStatus = req.path.includes("/public/") || !req.user;
    if (
      !isPublicStatus &&
      req.user?.role !== "super_admin" &&
      String(localOrder.organizationId) !== String(organizationId)
    ) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You are not authorized to access this order.",
      });
    }

    // Call live Cashfree PG status
    let cfLiveOrder = null;
    let cfPayments = [];
    try {
      cfLiveOrder = await fetchCashfreePgOrder(orderId);
      cfPayments = await fetchCashfreePgPayments(orderId);
    } catch (apiErr) {
      console.warn("[CashfreeStatusSync] Warning calling Cashfree API:", apiErr.message);
    }

    // Synchronize local order status if changed
    let effectiveLiveStatus = cfLiveOrder?.orderStatus || localOrder?.orderStatus;
    if (cfLiveOrder) {
      const prevStatus = localOrder.orderStatus;
      let resolvedStatus = String(cfLiveOrder.orderStatus || "").toUpperCase();

      if (cfPayments.length > 0) {
        const latestPayment = cfPayments[0];
        const latestPayStatus = String(latestPayment.payment_status || "").toUpperCase();
        const hasSuccessPayment = cfPayments.some(
          (p) => String(p.payment_status || "").toUpperCase() === "SUCCESS"
        );

        if (resolvedStatus === "PAID" || hasSuccessPayment) {
          resolvedStatus = "PAID";
        } else if (
          resolvedStatus === "ACTIVE" &&
          ["FAILED", "USER_DROPPED", "CANCELLED", "VOID", "EXPIRED"].includes(latestPayStatus)
        ) {
          resolvedStatus =
            latestPayStatus === "USER_DROPPED" || latestPayStatus === "CANCELLED"
              ? "CANCELLED"
              : latestPayStatus === "EXPIRED"
              ? "EXPIRED"
              : "FAILED";
        } else if (resolvedStatus === "ACTIVE" && latestPayStatus === "PENDING") {
          resolvedStatus = "PENDING";
        }

        localOrder.paymentDetails = {
          cfPaymentId: String(latestPayment.cf_payment_id || ""),
          paymentMethod: latestPayment.payment_group || latestPayment.payment_method || "",
          paymentTime: latestPayment.payment_completion_time
            ? new Date(latestPayment.payment_completion_time)
            : new Date(),
          bankReference: latestPayment.bank_reference || "",
          rawPaymentResponse: latestPayment,
        };
      }

      effectiveLiveStatus = resolvedStatus || cfLiveOrder.orderStatus;
      if (prevStatus !== "PAID") {
        localOrder.orderStatus = effectiveLiveStatus;
      }
      if (cfLiveOrder.cfOrderId) localOrder.cfOrderId = cfLiveOrder.cfOrderId;

      await localOrder.save();

      // Trigger benefit fulfillment strictly when PAID
      if (prevStatus !== "PAID" && effectiveLiveStatus === "PAID") {
        await fulfillOrderBenefits(localOrder);
      }
    }

    return res.status(200).json({
      success: true,
      order: localOrder,
      liveStatus: effectiveLiveStatus || localOrder?.orderStatus,
      payments: cfPayments,
    });
  } catch (error) {
    console.error("[CashfreeOrderStatus] Error:", error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || "Failed to fetch Cashfree order status.",
    });
  }
};

/**
 * POST /api/payment/cashfree/webhook
 * Public Cashfree webhook listener with HMAC-SHA256 verification and master-DB lookup
 */
export const handleCashfreeWebhook = async (req, res) => {
  try {
    const timestamp = req.headers["x-webhook-timestamp"];
    const signature = req.headers["x-webhook-signature"];

    // 1. Cryptographic raw-body signature validation
    const isValid = verifyCashfreeWebhookSignature({
      rawBody: req.rawBody,
      timestamp,
      signature,
    });

    if (!isValid) {
      console.warn("[CashfreeWebhook] Invalid webhook signature detected.");
      return res.status(400).json({ success: false, message: "Invalid webhook signature." });
    }

    const payload = req.body || {};
    const eventType = payload.type || payload.event || "UNKNOWN";
    const data = payload.data || {};
    const orderData = data.order || {};
    const paymentData = data.payment || {};

    const orderId = orderData.order_id || payload.order_id;

    if (!orderId) {
      return res.status(200).json({ status: "IGNORED_NO_ORDER_ID" });
    }

    // 2. Idempotency Check using unique event key
    const eventId =
      payload.event_id ||
      `${orderId}_${paymentData.cf_payment_id || ""}_${eventType}_${timestamp}`;

    const { CashfreeWebhookEvent, CashfreeOrder } = getMasterModels();

    const existingEvent = await CashfreeWebhookEvent.findOne({ eventId });
    if (existingEvent) {
      return res.status(200).json({ status: "ALREADY_PROCESSED" });
    }

    // Record webhook event in Master DB
    await CashfreeWebhookEvent.create({
      eventId,
      eventType,
      orderId,
      rawPayload: payload,
    });

    // 3. Process payment status updates on Master DB order
    const isPaymentSuccess =
      eventType === "PAYMENT_SUCCESS_WEBHOOK" ||
      orderData.order_status === "PAID" ||
      paymentData.payment_status === "SUCCESS";

    if (isPaymentSuccess) {
      const order = await CashfreeOrder.findOne({ orderId });
      if (order) {
        order.orderStatus = "PAID";
        if (paymentData.cf_payment_id) {
          order.paymentDetails = {
            cfPaymentId: String(paymentData.cf_payment_id),
            paymentMethod: paymentData.payment_group || "",
            paymentTime: paymentData.payment_completion_time
              ? new Date(paymentData.payment_completion_time)
              : new Date(),
            bankReference: paymentData.bank_reference || "",
            rawPaymentResponse: paymentData,
          };
        }
        await order.save();
        await fulfillOrderBenefits(order);
      } else {
        console.warn(`[CashfreeWebhook] Order ${orderId} not found in Master DB.`);
      }
    } else if (
      eventType === "PAYMENT_FAILED_WEBHOOK" ||
      paymentData.payment_status === "FAILED"
    ) {
      const order = await CashfreeOrder.findOne({ orderId });
      if (order && order.orderStatus !== "PAID") {
        order.orderStatus = "FAILED";
        await order.save();
      }
    }

    return res.status(200).json({ status: "OK" });
  } catch (error) {
    console.error("[CashfreeWebhook] Internal Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/payment/cashfree/orders (or /history)
 * Organization payment and order history from Master DB
 */
export const getOrderHistoryHandler = async (req, res) => {
  try {
    const organizationId = req.user?.organizationId || req.organization?._id;
    if (!organizationId) {
      return res.status(400).json({ success: false, message: "Organization required." });
    }

    const { page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const { CashfreeOrder } = getMasterModels();

    const [orders, total] = await Promise.all([
      CashfreeOrder.find({ organizationId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      CashfreeOrder.countDocuments({ organizationId }),
    ]);

    return res.status(200).json({
      success: true,
      orders,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error("[CashfreeHistory] Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/payment/cashfree/admin/orders
 * Admin & Management overview of all orders, revenue metrics, and transaction statuses
 */
export const getAdminOrdersHandler = async (req, res) => {
  try {
    const { page = 1, limit = 20, status = "all", search = "", organizationId } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const { CashfreeOrder } = getMasterModels();

    const query = {};
    const userRole = String(req.user?.role || "").toLowerCase();
    const isSuperAdmin = userRole === "super_admin" || userRole === "super admin";

    if (!isSuperAdmin) {
      const userOrgId = req.user?.organizationId || req.organization?._id;
      if (userOrgId) query.organizationId = userOrgId;
    } else if (organizationId) {
      query.organizationId = organizationId;
    }

    if (status && status !== "all") {
      const upperStatus = status.toUpperCase();
      if (upperStatus === "FAILED") {
        query.orderStatus = { $in: ["FAILED", "CANCELLED", "USER_DROPPED", "EXPIRED", "TERMINATED"] };
      } else if (upperStatus === "ACTIVE") {
        query.orderStatus = { $in: ["ACTIVE", "PENDING"] };
      } else {
        query.orderStatus = upperStatus;
      }
    }

    if (search && search.trim()) {
      const rx = new RegExp(search.trim(), "i");
      query.$or = [
        { orderId: rx },
        { cfOrderId: rx },
        { "customerDetails.customerName": rx },
        { "customerDetails.customerEmail": rx },
        { "customerDetails.customerPhone": rx },
        { planId: rx },
        { addonType: rx },
      ];
    }

    const [orders, total, stats] = await Promise.all([
      CashfreeOrder.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      CashfreeOrder.countDocuments(query),
      CashfreeOrder.aggregate([
        { $match: query.organizationId ? { organizationId: query.organizationId } : {} },
        {
          $group: {
            _id: null,
            totalRevenue: {
              $sum: { $cond: [{ $eq: ["$orderStatus", "PAID"] }, "$orderAmount", 0] },
            },
            paidCount: {
              $sum: { $cond: [{ $eq: ["$orderStatus", "PAID"] }, 1, 0] },
            },
            activeCount: {
              $sum: { $cond: [{ $in: ["$orderStatus", ["ACTIVE", "PENDING"]] }, 1, 0] },
            },
            failedCount: {
              $sum: {
                $cond: [
                  { $in: ["$orderStatus", ["FAILED", "CANCELLED", "USER_DROPPED", "EXPIRED", "TERMINATED"]] },
                  1,
                  0,
                ],
              },
            },
            totalOrders: { $sum: 1 },
          },
        },
      ]),
    ]);

    const metrics = stats[0] || {
      totalRevenue: 0,
      paidCount: 0,
      activeCount: 0,
      failedCount: 0,
      totalOrders: 0,
    };

    return res.status(200).json({
      success: true,
      data: {
        orders,
        metrics,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        },
      },
    });
  } catch (error) {
    console.error("[CashfreeAdminOrders] Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Dev-only simulation endpoint to complete payment for local testing
 */
export const devSimulateSuccessHandler = async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ success: false, message: "Order ID is required." });
    }
    const { CashfreeOrder, Organization } = getMasterModels();
    const order = await CashfreeOrder.findOne({ orderId });
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    order.orderStatus = "PAID";
    order.paymentDetails = {
      cfPaymentId: `cf_pay_sim_${Date.now()}`,
      paymentMethod: "upi",
      paymentTime: new Date(),
      bankReference: `UPI_SIM_${Date.now()}`,
    };
    await order.save();

    await fulfillOrderBenefits(order);

    return res.json({
      success: true,
      message: "Order successfully marked as PAID and benefits fulfilled (dev simulation).",
      orderStatus: "PAID",
      order,
    });
  } catch (err) {
    console.error("[devSimulateSuccessHandler] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/payment/cashfree/public/pricing-config
 * Public endpoint to fetch configured GST rate and extra rep rates for web checkout
 */
export const getAddonQuoteHandler = async (req, res) => {
  try {
    const org = req.organization;
    if (!org || org.isTrial) {
      return res.status(400).json({ success: false, message: "Add-ons are available after starting a paid quarterly or yearly plan." });
    }
    const cycle = getActivePlanCycle(org);
    const { SystemSettings } = getMasterModels();
    const settings = SystemSettings ? await SystemSettings.findOne().lean().catch(() => null) : null;
    const catalog = getEffectiveAddonCatalog(settings).filter((item) => item.isActive !== false);
    const addonItems = buildAddonOrderItems({ addonIds: [req.body.addonId], term: cycle.term, catalog, cycle, prorate: true });
    const resolution = resolveAuthoritativePrice({
      purpose: "addon",
      addonType: req.body.addonId,
      addonTerm: cycle.term,
      addonItems,
      dynamicGstRate: settings?.gstRate,
      dynamicAddons: catalog,
    });
    return res.status(200).json({
      success: true,
      quote: {
        ...addonItems[0],
        baseAmount: resolution.baseAmount,
        gstRate: resolution.gstPercent,
        gstAmount: resolution.gstAmount,
        totalAmount: resolution.amount,
        currency: resolution.currency,
      },
    });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message || "Could not calculate add-on price." });
  }
};

export const getPublicPricingConfigHandler = async (req, res) => {
  try {
    const { SystemSettings } = getMasterModels();
    let settings = null;
    if (SystemSettings && typeof SystemSettings.findOne === "function") {
      settings = await SystemSettings.findOne().lean().catch(() => null);
    }
    const gstRate = typeof settings?.gstRate === "number" ? settings.gstRate : DEFAULT_GST_PERCENT;
    const extraRepMonthlyPriceYearly =
      typeof settings?.extraRepMonthlyPriceYearly === "number"
        ? settings.extraRepMonthlyPriceYearly
        : 899;
    const extraRepMonthlyPriceQuarterly =
      typeof settings?.extraRepMonthlyPriceQuarterly === "number"
        ? settings.extraRepMonthlyPriceQuarterly
        : 1199;

    const effectiveAddons = getEffectiveAddonCatalog(settings).filter((a) => a.isActive !== false);
    const effectivePlans = getEffectivePlanCatalog(settings).filter((p) => p.isActive !== false);
    const plansById = Object.fromEntries(
      effectivePlans.map((p) => [
        p.id,
        {
          ...p,
          amount: p.price,
          basePrice: p.price,
          currency: "INR",
        },
      ])
    );

    return res.status(200).json({
      success: true,
      config: {
        gstRate, // percentage (e.g. 18)
        gstFraction: gstRate / 100,
        extraRepMonthlyPriceYearly,
        extraRepMonthlyPriceQuarterly,
        baseRepsIncluded: 5,
        plans: plansById,
        planCatalog: effectivePlans,
        addons: effectiveAddons,
      },
    });
  } catch (error) {
    console.error("[CashfreePricingConfig] Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/payment/cashfree/admin/pricing-settings
 * Admin endpoint to view live pricing, GST & addons catalog settings
 */
export const getAdminPricingSettingsHandler = async (req, res) => {
  try {
    const { SystemSettings } = getMasterModels();
    let settings = null;
    if (SystemSettings && typeof SystemSettings.findOne === "function") {
      settings = await SystemSettings.findOne().lean().catch(() => null);
    }
    const gstRate = typeof settings?.gstRate === "number" ? settings.gstRate : DEFAULT_GST_PERCENT;
    const extraRepMonthlyPriceYearly =
      typeof settings?.extraRepMonthlyPriceYearly === "number"
        ? settings.extraRepMonthlyPriceYearly
        : 899;
    const extraRepMonthlyPriceQuarterly =
      typeof settings?.extraRepMonthlyPriceQuarterly === "number"
        ? settings.extraRepMonthlyPriceQuarterly
        : 1199;
    const addons = getEffectiveAddonCatalog(settings);
    const plans = getEffectivePlanCatalog(settings);

    return res.status(200).json({
      success: true,
      settings: {
        gstRate,
        extraRepMonthlyPriceYearly,
        extraRepMonthlyPriceQuarterly,
        addons,
        plans,
        updatedBy: settings?.updatedBy || "System",
        updatedAt: settings?.updatedAt || null,
      },
    });
  } catch (error) {
    console.error("[CashfreeGetPricingSettings] Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PUT /api/payment/cashfree/admin/pricing-settings
 * Admin updates GST rate and extra sales rep pricing in master SystemSettings
 */
export const updatePricingSettingsHandler = async (req, res) => {
  try {
    const { gstRate, extraRepMonthlyPriceYearly, extraRepMonthlyPriceQuarterly } = req.body;
    const { SystemSettings } = getMasterModels();
    if (!SystemSettings) {
      return res.status(500).json({ success: false, message: "SystemSettings model unavailable." });
    }

    let settings = await SystemSettings.findOne();
    if (!settings) {
      settings = new SystemSettings({});
    }

    if (gstRate !== undefined && !isNaN(Number(gstRate))) {
      const parsedGst = Number(gstRate);
      if (parsedGst < 0 || parsedGst > 100) {
        return res.status(400).json({ success: false, message: "GST Rate must be between 0 and 100%." });
      }
      settings.gstRate = parsedGst;
    }

    if (extraRepMonthlyPriceYearly !== undefined && !isNaN(Number(extraRepMonthlyPriceYearly))) {
      const parsedYearly = Number(extraRepMonthlyPriceYearly);
      if (parsedYearly < 0) {
        return res.status(400).json({ success: false, message: "Yearly extra rep price cannot be negative." });
      }
      settings.extraRepMonthlyPriceYearly = parsedYearly;
    }

    if (extraRepMonthlyPriceQuarterly !== undefined && !isNaN(Number(extraRepMonthlyPriceQuarterly))) {
      const parsedQuarterly = Number(extraRepMonthlyPriceQuarterly);
      if (parsedQuarterly < 0) {
        return res.status(400).json({ success: false, message: "Quarterly extra rep price cannot be negative." });
      }
      settings.extraRepMonthlyPriceQuarterly = parsedQuarterly;
    }

    settings.updatedBy = req.user?.name || req.user?.email || "Admin";
    await settings.save();

    return res.status(200).json({
      success: true,
      message: "Pricing & GST settings saved successfully.",
      settings: {
        gstRate: settings.gstRate,
        extraRepMonthlyPriceYearly: settings.extraRepMonthlyPriceYearly,
        extraRepMonthlyPriceQuarterly: settings.extraRepMonthlyPriceQuarterly,
        addons: getEffectiveAddonCatalog(settings),
        plans: getEffectivePlanCatalog(settings),
        updatedBy: settings.updatedBy,
        updatedAt: settings.updatedAt,
      },
    });
  } catch (error) {
    console.error("[CashfreeUpdatePricingSettings] Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Helper to ensure SystemSettings has an initialized mutable addonCatalog array
 */
const loadOrInitAddonSettings = async (SystemSettings, user) => {
  let settings = await SystemSettings.findOne();
  if (!settings) {
    settings = new SystemSettings({});
  }
  if (!settings.addonCatalogConfigured && (!settings.addonCatalog || settings.addonCatalog.length === 0)) {
    settings.addonCatalog = DEFAULT_ADDON_CATALOG.map((a) => ({ ...a }));
    settings.addonCatalogConfigured = true;
  }
  settings.updatedBy = user?.name || user?.email || "Admin";
  return settings;
};

/**
 * POST /api/payment/cashfree/admin/addons
 * Create a new configurable addon/feature in SystemSettings
 */
export const createAdminAddonHandler = async (req, res) => {
  try {
    const { id, title, price, quarterlyPrice, yearlyPrice, description = "", icon = "Sparkles", features = [], isActive = true } = req.body;
    const legacyMonthlyPrice = Number(price);
    const quarterPrice = quarterlyPrice === undefined ? legacyMonthlyPrice * 3 : Number(quarterlyPrice);
    const annualPrice = yearlyPrice === undefined ? legacyMonthlyPrice * 12 : Number(yearlyPrice);
    if (!title || !Number.isFinite(quarterPrice) || quarterPrice < 0 || !Number.isFinite(annualPrice) || annualPrice < 0) {
      return res.status(400).json({ success: false, message: "Title and valid quarterly and yearly prices are required." });
    }

    const { SystemSettings } = getMasterModels();
    const settings = await loadOrInitAddonSettings(SystemSettings, req.user);

    const normalizedId = String(
      id ||
        title
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "")
    ).trim();

    if (!normalizedId) {
      return res.status(400).json({ success: false, message: "Valid addon ID slug is required." });
    }

    if (settings.addonCatalog.some((a) => a.id === normalizedId)) {
      return res.status(409).json({ success: false, message: `Addon with ID '${normalizedId}' already exists.` });
    }

    const parsedFeatures = Array.isArray(features)
      ? features.map((f) => String(f).trim()).filter(Boolean)
      : String(features || "")
          .split(/[\n,]+/)
          .map((f) => f.trim())
          .filter(Boolean);

    settings.addonCatalog.push({
      id: normalizedId,
      title: String(title).trim(),
      price: Number.isFinite(legacyMonthlyPrice) ? legacyMonthlyPrice : quarterPrice / 3,
      quarterlyPrice: quarterPrice,
      yearlyPrice: annualPrice,
      period: "quarterly",
      description: String(description || "").trim(),
      icon: String(icon || "Sparkles").trim(),
      features: parsedFeatures,
      isActive: Boolean(isActive),
    });

    await settings.save();

    return res.status(201).json({
      success: true,
      message: "Addon/feature created successfully.",
      addons: settings.addonCatalog,
    });
  } catch (error) {
    console.error("[CreateAdminAddon] Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PUT /api/payment/cashfree/admin/addons/:addonId
 * Update an existing addon/feature in SystemSettings
 */
export const updateAdminAddonHandler = async (req, res) => {
  try {
    const { addonId } = req.params;
    const { title, price, quarterlyPrice, yearlyPrice, description, icon, features, isActive } = req.body;

    const { SystemSettings } = getMasterModels();
    const settings = await loadOrInitAddonSettings(SystemSettings, req.user);

    const target = settings.addonCatalog.find((a) => a.id === addonId);
    if (!target) {
      return res.status(404).json({ success: false, message: `Addon '${addonId}' not found.` });
    }

    if (title !== undefined) target.title = String(title).trim();
    if (quarterlyPrice !== undefined && Number.isFinite(Number(quarterlyPrice)) && Number(quarterlyPrice) >= 0) {
      target.quarterlyPrice = Number(quarterlyPrice);
    }
    if (yearlyPrice !== undefined && Number.isFinite(Number(yearlyPrice)) && Number(yearlyPrice) >= 0) {
      target.yearlyPrice = Number(yearlyPrice);
    }
    if (price !== undefined && quarterlyPrice === undefined && yearlyPrice === undefined && Number.isFinite(Number(price)) && Number(price) >= 0) {
      target.price = Number(price);
      target.quarterlyPrice = Number(price) * 3;
      target.yearlyPrice = Number(price) * 12;
    }
    if (target.quarterlyPrice === undefined) target.quarterlyPrice = Number(target.price || 0) * 3;
    if (target.yearlyPrice === undefined) target.yearlyPrice = Number(target.price || 0) * 12;
    target.period = "quarterly";
    if (description !== undefined) target.description = String(description).trim();
    if (icon !== undefined) target.icon = String(icon).trim();
    if (isActive !== undefined) target.isActive = Boolean(isActive);
    if (features !== undefined) {
      target.features = Array.isArray(features)
        ? features.map((f) => String(f).trim()).filter(Boolean)
        : String(features || "")
            .split(/[\n,]+/)
            .map((f) => f.trim())
            .filter(Boolean);
    }

    settings.markModified("addonCatalog");
    await settings.save();

    return res.status(200).json({
      success: true,
      message: "Addon/feature updated successfully.",
      addons: settings.addonCatalog,
    });
  } catch (error) {
    console.error("[UpdateAdminAddon] Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * DELETE /api/payment/cashfree/admin/addons/:addonId
 * Delete an addon/feature from SystemSettings
 */
export const deleteAdminAddonHandler = async (req, res) => {
  try {
    const { addonId } = req.params;
    const { SystemSettings } = getMasterModels();
    const settings = await loadOrInitAddonSettings(SystemSettings, req.user);

    const prevLen = settings.addonCatalog.length;
    settings.addonCatalog = settings.addonCatalog.filter((a) => a.id !== addonId);
    if (settings.addonCatalog.length === prevLen) {
      return res.status(404).json({ success: false, message: `Addon '${addonId}' not found.` });
    }

    settings.addonCatalogConfigured = true;
    settings.markModified("addonCatalog");
    await settings.save();

    return res.status(200).json({
      success: true,
      message: "Addon/feature deleted successfully.",
      addons: settings.addonCatalog,
    });
  } catch (error) {
    console.error("[DeleteAdminAddon] Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const loadOrInitPlanSettings = async (SystemSettings, user) => {
  let settings = await SystemSettings.findOne();
  if (!settings) {
    settings = new SystemSettings({});
  }
  if (!settings.planCatalogConfigured && (!settings.planCatalog || settings.planCatalog.length === 0)) {
    settings.planCatalog = DEFAULT_PLAN_CATALOG.map((p) => ({ ...p }));
    settings.planCatalogConfigured = true;
  }
  settings.updatedBy = user?.name || user?.email || "Admin";
  return settings;
};

const parseFeaturesList = (features) =>
  Array.isArray(features)
    ? features.map((f) => String(f).trim()).filter(Boolean)
    : String(features || "")
        .split(/[\n,]+/)
        .map((f) => f.trim())
        .filter(Boolean);

/**
 * POST /api/payment/cashfree/admin/plans
 * Create a subscription plan in SystemSettings
 */
export const createAdminPlanHandler = async (req, res) => {
  try {
    const {
      id,
      title,
      price,
      period = "",
      durationMonths,
      description = "",
      popular = false,
      saveBadge = "",
      features = [],
      isActive = true,
    } = req.body;
    const numericPrice = Number(price);
    if (!title || !Number.isFinite(numericPrice) || numericPrice < 0) {
      return res.status(400).json({ success: false, message: "Title and valid price are required." });
    }
    const normalizedId = String(
      id || title.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
    ).trim();
    if (!normalizedId) {
      return res.status(400).json({ success: false, message: "Valid plan ID is required." });
    }

    const { SystemSettings } = getMasterModels();
    const settings = await loadOrInitPlanSettings(SystemSettings, req.user);
    if (settings.planCatalog.some((p) => p.id === normalizedId)) {
      return res.status(409).json({ success: false, message: `Plan '${normalizedId}' already exists.` });
    }

    const months = Number.isFinite(Number(durationMonths)) && Number(durationMonths) > 0
      ? Number(durationMonths)
      : normalizedId === "yearly" ? 12 : 3;

    settings.planCatalog.push({
      id: normalizedId,
      title: String(title).trim(),
      price: numericPrice,
      period: String(period || "").trim(),
      durationMonths: months,
      description: String(description || "").trim(),
      popular: Boolean(popular),
      saveBadge: String(saveBadge || "").trim(),
      features: parseFeaturesList(features),
      isActive: Boolean(isActive),
    });
    await settings.save();

    return res.status(201).json({
      success: true,
      message: "Plan created successfully.",
      plans: getEffectivePlanCatalog(settings),
    });
  } catch (error) {
    console.error("[CreateAdminPlan] Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PUT /api/payment/cashfree/admin/plans/:planId
 * Update an existing subscription plan in SystemSettings
 */
export const updateAdminPlanHandler = async (req, res) => {
  try {
    const { planId } = req.params;
    const { title, price, period, durationMonths, description, popular, saveBadge, features, isActive } = req.body;

    const { SystemSettings } = getMasterModels();
    const settings = await loadOrInitPlanSettings(SystemSettings, req.user);
    const target = settings.planCatalog.find((p) => p.id === planId);
    if (!target) {
      return res.status(404).json({ success: false, message: `Plan '${planId}' not found.` });
    }

    if (title !== undefined) target.title = String(title).trim();
    if (price !== undefined && Number.isFinite(Number(price)) && Number(price) >= 0) {
      target.price = Number(price);
    }
    if (period !== undefined) target.period = String(period).trim();
    if (durationMonths !== undefined && Number.isFinite(Number(durationMonths)) && Number(durationMonths) > 0) {
      target.durationMonths = Number(durationMonths);
    }
    if (description !== undefined) target.description = String(description).trim();
    if (popular !== undefined) target.popular = Boolean(popular);
    if (saveBadge !== undefined) target.saveBadge = String(saveBadge).trim();
    if (isActive !== undefined) target.isActive = Boolean(isActive);
    if (features !== undefined) target.features = parseFeaturesList(features);

    settings.markModified("planCatalog");
    await settings.save();

    return res.status(200).json({
      success: true,
      message: "Plan updated successfully.",
      plans: getEffectivePlanCatalog(settings),
    });
  } catch (error) {
    console.error("[UpdateAdminPlan] Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * DELETE /api/payment/cashfree/admin/plans/:planId
 */
export const deleteAdminPlanHandler = async (req, res) => {
  try {
    const { planId } = req.params;
    const { SystemSettings } = getMasterModels();
    const settings = await loadOrInitPlanSettings(SystemSettings, req.user);
    const prevLen = settings.planCatalog.length;
    settings.planCatalog = settings.planCatalog.filter((p) => p.id !== planId);
    if (settings.planCatalog.length === prevLen) {
      return res.status(404).json({ success: false, message: `Plan '${planId}' not found.` });
    }
    settings.planCatalogConfigured = true;
    settings.markModified("planCatalog");
    await settings.save();

    return res.status(200).json({
      success: true,
      message: "Plan deleted successfully.",
      plans: getEffectivePlanCatalog(settings),
    });
  } catch (error) {
    console.error("[DeleteAdminPlan] Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/payment/cashfree/order/:orderId/invoice
 * GET /api/payment/cashfree/public/order/:orderId/invoice
 * Streams a generated PDF Tax Invoice for a PAID order
 */
export const downloadInvoiceHandler = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { CashfreeOrder, Organization } = getMasterModels();
    const order = await CashfreeOrder.findOne({ orderId }).lean();
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }
    if (String(order.orderStatus || "").toUpperCase() !== "PAID") {
      return res.status(400).json({ success: false, message: "Invoice is available only for PAID orders." });
    }

    const org = order.organizationId
      ? await Organization.findById(order.organizationId).lean().catch(() => null)
      : null;

    const pdfBuffer = generateInvoicePdfBuffer({ order, organization: org || {} });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="INV-${order.orderId}.pdf"`);
    return res.status(200).send(pdfBuffer);
  } catch (error) {
    console.error("[CashfreeDownloadInvoice] Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/payment/cashfree/admin/orders/:orderId/resend-invoice
 * Admin endpoint to generate & send the Tax Invoice PDF to the client's email
 */
export const resendInvoiceHandler = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { CashfreeOrder, Organization } = getMasterModels();
    const order = await CashfreeOrder.findOne({ orderId });
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }
    if (String(order.orderStatus || "").toUpperCase() !== "PAID") {
      return res.status(400).json({ success: false, message: "Tax Invoice can only be sent for PAID orders." });
    }

    const org = order.organizationId
      ? await Organization.findById(order.organizationId).lean().catch(() => null)
      : null;

    const targetEmail = order.customerDetails?.customerEmail || org?.email;
    if (!targetEmail) {
      return res.status(400).json({ success: false, message: "No customer email found on this order." });
    }

    const sent = await sendPaymentReceiptEmail({
      order,
      organization: org || {},
      isNewAccount: false,
      loginUrl: process.env.APP_URL || process.env.FRONTEND_URL || "https://salesbuster.ai/beta",
    });

    if (!sent) {
      return res.status(500).json({ success: false, message: `Failed to deliver invoice email to ${targetEmail}.` });
    }

    order.receiptEmailSent = true;
    await order.save();

    return res.status(200).json({
      success: true,
      message: `Tax Invoice (INV-${order.orderId}.pdf) sent to ${targetEmail}.`,
    });
  } catch (error) {
    console.error("[CashfreeResendInvoice] Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
