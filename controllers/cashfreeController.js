import crypto from "crypto";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { handleSubscriptionWebhookEvent } from "./trialAutopayController.js";
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
} from "../services/cashfreeService.js";

/**
 * Authoritative Server-Side Pricing Catalog (Prevents Client-Side Parameter Tampering)
 */
export const DEFAULT_GST_PERCENT = 18;
export const GST_RATE = 0.18; // Statutory 18% Goods & Services Tax (GST) fallback

export const CASHFREE_PRICING_CATALOG = {
  addon: {
    whatsapp_campaigns: {
      amount: 999,
      currency: "INR",
      title: "WhatsApp Campaigns Monthly Addon",
    },
    target_intelligence: {
      amount: 1499,
      currency: "INR",
      title: "AI Target Intelligence Monthly Addon",
    },
    bi_analyst: {
      amount: 999,
      currency: "INR",
      title: "AI BI Analyst Monthly Addon",
    },
    instagram_automation: {
      amount: 499,
      currency: "INR",
      title: "Instagram Auto DM & Lead Gen Addon",
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
    period: "monthly",
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
    period: "monthly",
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
    period: "monthly",
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
    period: "monthly",
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
  if (sysSettings?.addonCatalogConfigured && Array.isArray(sysSettings.addonCatalog)) {
    return sysSettings.addonCatalog;
  }
  if (Array.isArray(sysSettings?.addonCatalog) && sysSettings.addonCatalog.length > 0) {
    return sysSettings.addonCatalog;
  }
  return DEFAULT_ADDON_CATALOG;
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
      additionalRepsCost = repsToAdd * extraRepPriceQuarterly;
      title = `${repsToAdd} Additional Sales Rep${repsToAdd > 1 ? "s" : ""} (Monthly)`;
    }
    basePlanAmount = 0;
    currency = "INR";
  } else if (normalizedPurpose === "addon") {
    const dynamicMatch = Array.isArray(dynamicAddons)
      ? dynamicAddons.find((a) => a.id === addonType && a.isActive !== false)
      : null;
    const addonConfig = dynamicMatch
      ? { amount: Number(dynamicMatch.price), currency: "INR", title: dynamicMatch.title }
      : CASHFREE_PRICING_CATALOG.addon[addonType];
    if (!addonConfig) {
      throw new Error(`Invalid or unsupported addon type: '${addonType}'`);
    }
    basePlanAmount = addonConfig.amount;
    currency = addonConfig.currency;
    title = addonConfig.title;
  } else if (normalizedPurpose === "subscription") {
    const planConfig = CASHFREE_PRICING_CATALOG.subscription[planId];
    if (!planConfig) {
      throw new Error(`Invalid or unsupported subscription plan: '${planId}'`);
    }
    basePlanAmount = planConfig.amount;
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
  };
};

const _activeOrderFulfillments = new Set();

/**
 * Fulfill organization subscription or addon upon successful payment and dispatch confirmation email
 */
export const fulfillOrderBenefits = async (order) => {
  const lockKey = order?.orderId || (order?._id ? String(order._id) : null);
  try {
    if (!order) return;

    // Idempotency: skip if already fulfilled and email sent
    if (order.isFulfilled && order.receiptEmailSent) {
      console.log(`[CashfreeFulfillment] Order ${order.orderId} already fulfilled and receipt email sent. Skipping.`);
      return;
    }

    if (lockKey && _activeOrderFulfillments.has(lockKey)) {
      console.log(`[CashfreeFulfillment] Order ${lockKey} fulfillment already in progress. Skipping concurrent call.`);
      return;
    }
    if (lockKey) _activeOrderFulfillments.add(lockKey);

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
      await org.save();

      order.organizationId = org._id;
      console.log(`[CashfreeFulfillment] Auto-provisioned new tenant organization: ${org._id} (${org.name})`);
    } else {
      // Existing Organization: fulfill addon, extra_reps, or subscription
      if (order.purpose === "addon") {
        org.addons = org.addons || {};
        if (order.addonType === "whatsapp_campaigns") {
          org.hasWhatsAppCampaignsAddon = true;
          org.addons.whatsappCampaigns = true;
        } else if (order.addonType === "target_intelligence") {
          org.addons.targetIntelligence = true;
        } else if (order.addonType === "bi_analyst") {
          org.addons.biAnalyst = true;
        } else if (order.addonType === "instagram_automation") {
          org.hasInstagramAddon = true;
          org.addons.instagramAutomation = true;
        } else if (order.addonType) {
          org.addons[order.addonType] = true;
        }
        org.markModified("addons");
      } else if (order.purpose === "extra_reps") {
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
            org.subscriptionEndDate && new Date(org.subscriptionEndDate) > new Date()
              ? new Date(org.subscriptionEndDate)
              : new Date();

          const newEnd = new Date(currentEnd);
          newEnd.setMonth(newEnd.getMonth() + extensionMonths);
          org.subscriptionEndDate = newEnd;
          org.amountPaid = (org.amountPaid || 0) + (order.orderAmount || 0);
          if (order.additionalReps) {
            const totalSeats = 5 + (Number(order.additionalReps) || 0);
            org.seats = Math.max(org.seats || 1, totalSeats);
          }
        }
      }

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
      dynamicAddons: getEffectiveAddonCatalog(sysSettings),
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

    // Cashfree Production strictly enforces https:// on returnUrl and notifyUrl
    if (finalReturnUrl.startsWith("http://")) {
      finalReturnUrl = finalReturnUrl.replace(
        /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i,
        "https://salesbuster.ai"
      );
    }
    if (finalNotifyUrl.startsWith("http://")) {
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
    return res.status(error.status || 500).json({
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
    if (String(eventType || "").startsWith("SUBSCRIPTION_")) {
      await handleSubscriptionWebhookEvent(eventType, payload.data || payload);
      return res.status(200).json({ status: "SUBSCRIPTION_PROCESSED" });
    }

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

    return res.status(200).json({
      success: true,
      config: {
        gstRate, // percentage (e.g. 18)
        gstFraction: gstRate / 100,
        extraRepMonthlyPriceYearly,
        extraRepMonthlyPriceQuarterly,
        baseRepsIncluded: 5,
        plans: CASHFREE_PRICING_CATALOG.subscription,
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

    return res.status(200).json({
      success: true,
      settings: {
        gstRate,
        extraRepMonthlyPriceYearly,
        extraRepMonthlyPriceQuarterly,
        addons,
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
    const { id, title, price, period = "monthly", description = "", icon = "Sparkles", features = [], isActive = true } = req.body;
    if (!title || price === undefined || isNaN(Number(price)) || Number(price) < 0) {
      return res.status(400).json({ success: false, message: "Valid title and non-negative price are required." });
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
      price: Number(price),
      period: String(period || "monthly").trim(),
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
    const { title, price, period, description, icon, features, isActive } = req.body;

    const { SystemSettings } = getMasterModels();
    const settings = await loadOrInitAddonSettings(SystemSettings, req.user);

    const target = settings.addonCatalog.find((a) => a.id === addonId);
    if (!target) {
      return res.status(404).json({ success: false, message: `Addon '${addonId}' not found.` });
    }

    if (title !== undefined) target.title = String(title).trim();
    if (price !== undefined && !isNaN(Number(price)) && Number(price) >= 0) {
      target.price = Number(price);
    }
    if (period !== undefined) target.period = String(period).trim();
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
