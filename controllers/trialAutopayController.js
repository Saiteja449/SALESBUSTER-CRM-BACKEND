import crypto from "crypto";
import bcrypt from "bcryptjs";
import {
  getMasterModels,
  getTenantModels,
  generateTenantDbName,
  generateSecurePassword,
} from "../services/tenantManager.js";
import { getDefaultAISettings } from "../models/Organization.js";
import { sendTenantWelcomeEmail } from "../helpers/emailHelper.js";
import { TRIAL_LIMITS } from "../middleware/trialLimitMiddleware.js";

const getCashfreeBaseUrl = () =>
  String(process.env.CASHFREE_ENV || "").toUpperCase() === "PRODUCTION"
    ? "https://api.cashfree.com/pg"
    : "https://sandbox.cashfree.com/pg";

const getCashfreeHeaders = () => ({
  "Content-Type": "application/json",
  "x-client-id": process.env.CASHFREE_APP_ID || process.env.CASHFREE_CLIENT_ID || "",
  "x-client-secret": process.env.CASHFREE_SECRET_KEY || process.env.CASHFREE_CLIENT_SECRET || "",
  "x-api-version": "2023-08-01",
});

const PLAN_PRICING = {
  monthly: { baseAmount: 5995, intervalType: "MONTH", durationDays: 30 },
  quarterly: { baseAmount: 17985, intervalType: "QUARTER", durationDays: 90 },
  yearly: { baseAmount: 53940, intervalType: "YEAR", durationDays: 365 },
  annual: { baseAmount: 53940, intervalType: "YEAR", durationDays: 365 },
};

/**
 * POST /api/payment/cashfree/trial/start
 * Activates a 3-day free trial with limited features for the authenticated organization.
 */
export const startFreeTrialHandler = async (req, res) => {
  try {
    const orgId = req.organization?._id || req.user?.organizationId;
    if (!orgId) {
      return res.status(400).json({
        success: false,
        message: "Organization context is required to start a free trial.",
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

    if (org.trialStartDate) {
      return res.status(400).json({
        success: false,
        code: "TRIAL_ALREADY_USED",
        message: "This organization has already used its 3-day free trial.",
      });
    }

    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + TRIAL_LIMITS.durationDays * 24 * 60 * 60 * 1000);

    org.isTrial = true;
    org.trialStartDate = now;
    org.trialEndsAt = trialEndsAt;
    org.trialConverted = false;
    org.accountType = "crm";
    org.seats = TRIAL_LIMITS.maxSeats;
    org.subscriptionStartDate = now;
    org.subscriptionEndDate = trialEndsAt;
    org.status = "active";
    await org.save();

    return res.status(200).json({
      success: true,
      message: "3-day free trial activated with limited features.",
      data: {
        isTrial: true,
        trialStartDate: now,
        trialEndsAt,
        seats: org.seats,
        limits: TRIAL_LIMITS,
      },
    });
  } catch (error) {
    console.error("[Trial] startFreeTrialHandler error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to activate 3-day free trial.",
    });
  }
};

/**
 * POST /api/payment/cashfree/public/trial/start
 * Public website signup for a new organization 3-day free trial with limited features.
 */
export const startPublicFreeTrialHandler = async (req, res) => {
  try {
    const {
      customerName = "",
      companyName = "",
      customerEmail = "",
      customerPhone = "",
    } = req.body || {};

    const cleanName = String(customerName).trim();
    const cleanCompany = String(companyName).trim();
    const cleanEmail = String(customerEmail).trim().toLowerCase();
    const cleanPhone = String(customerPhone).replace(/\D/g, "").slice(-10);

    if (!cleanName || !cleanEmail || !/^[6-9]\d{9}$/.test(cleanPhone)) {
      return res.status(400).json({
        success: false,
        message: "Full name, valid work email, and a 10-digit mobile number starting with 6-9 are required.",
      });
    }

    const { Organization, AuthUser } = getMasterModels();
    const mobileRegex = new RegExp(`${cleanPhone}$`);

    const [existingOrg, existingUser] = await Promise.all([
      Organization.findOne({ $or: [{ email: cleanEmail }, { mobile: mobileRegex }] }).lean(),
      AuthUser.findOne({ $or: [{ email: cleanEmail }, { phone: mobileRegex }] }).lean(),
    ]);

    if (existingOrg || existingUser) {
      return res.status(409).json({
        success: false,
        code: "DUPLICATE_ORGANIZATION",
        message: "An organization with this email or mobile number already exists. Please log in to your CRM.",
      });
    }

    const orgDisplayName = cleanCompany || `${cleanName}'s Workspace`;
    let tenantDbName = generateTenantDbName(orgDisplayName);
    let attempts = 0;
    while (await Organization.findOne({ tenantDbName })) {
      tenantDbName = generateTenantDbName(orgDisplayName);
      attempts += 1;
      if (attempts > 5) break;
    }

    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + TRIAL_LIMITS.durationDays * 24 * 60 * 60 * 1000);
    const temporaryPassword = generateSecurePassword(cleanName);
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(temporaryPassword, salt);

    const org = await Organization.create({
      name: orgDisplayName,
      email: cleanEmail,
      mobile: cleanPhone,
      seats: TRIAL_LIMITS.maxSeats,
      amountPaid: 0,
      pricingPerSeat: 0,
      paymentMethod: "Free Trial",
      subscriptionPlan: "monthly",
      subscriptionStartDate: now,
      subscriptionEndDate: trialEndsAt,
      isTrial: true,
      trialStartDate: now,
      trialEndsAt,
      trialConverted: false,
      accountType: "crm",
      status: "active",
      tenantDbName,
      notes: "3-Day Free Trial provisioned via Website",
      aiSettings: getDefaultAISettings(orgDisplayName),
    });

    const masterAuthUser = await AuthUser.create({
      email: cleanEmail,
      phone: cleanPhone,
      password: hashedPassword,
      name: `${cleanName} Admin`,
      role: "sales manager",
      accountType: "crm",
      organizationId: org._id,
      tenantDbName,
      isOrgOwner: true,
      status: "active",
    });

    const tenantModels = getTenantModels(tenantDbName);
    await tenantModels.User.create({
      _id: masterAuthUser._id,
      name: `${cleanName} Admin`,
      email: cleanEmail,
      phone: cleanPhone,
      password: hashedPassword,
      role: "sales manager",
      organizationId: org._id,
      isOrgOwner: true,
      status: "active",
    });

    org.ownerId = masterAuthUser._id;
    await org.save();

    const appLoginUrl =
      process.env.CRM_APP_URL ||
      process.env.APP_URL ||
      process.env.FRONTEND_URL ||
      "https://betaapp.salesbuster.ai/";

    sendTenantWelcomeEmail({
      organizationName: org.name,
      ownerName: cleanName,
      ownerEmail: cleanEmail,
      temporaryPassword,
      loginUrl: appLoginUrl,
      subscriptionPlan: "3-Day Free Trial",
      seats: TRIAL_LIMITS.maxSeats,
    }).catch((err) => {
      console.warn("[PublicTrial] Welcome email warning:", err.message);
    });

    return res.status(201).json({
      success: true,
      message: "Your 3-day free trial workspace is ready!",
      data: {
        organizationId: org._id,
        organizationName: org.name,
        email: cleanEmail,
        trialEndsAt,
        seats: TRIAL_LIMITS.maxSeats,
        limits: TRIAL_LIMITS,
        loginUrl: appLoginUrl,
      },
    });
  } catch (error) {
    console.error("[PublicTrial] startPublicFreeTrialHandler error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to provision 3-day free trial workspace.",
    });
  }
};

/**
 * POST /api/payment/cashfree/autopay/create
 * Creates a Cashfree Subscriptions Autopay mandate (optionally starting after 3-day free trial).
 */
export const createAutopaySubscriptionHandler = async (req, res) => {
  try {
    const orgId = req.organization?._id || req.user?.organizationId || null;
    const {
      planId = "monthly",
      withTrial = false,
      customerName,
      customerEmail,
      customerPhone,
    } = req.body || {};

    const normalizedPlan = String(planId).toLowerCase();
    const plan = PLAN_PRICING[normalizedPlan] || PLAN_PRICING.monthly;
    const gstAmount = Math.round(plan.baseAmount * 0.18 * 100) / 100;
    const totalAmount = Math.round((plan.baseAmount + gstAmount) * 100) / 100;

    const email = customerEmail || req.organization?.email || req.user?.email;
    const phone = String(customerPhone || req.organization?.mobile || req.user?.phone || "9999999999")
      .replace(/\D/g, "")
      .slice(-10);
    const name = customerName || req.organization?.name || req.user?.name || "SalesBuster Customer";

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Customer email is required to set up Autopay.",
      });
    }

    const subscriptionId = `sb_sub_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const now = new Date();
    const trialEndsAt = withTrial
      ? new Date(now.getTime() + TRIAL_LIMITS.durationDays * 24 * 60 * 60 * 1000)
      : null;

    const frontendBaseUrl = (process.env.FRONTEND_URL || "https://app.salesbuster.ai").replace(/\/+$/, "");
    const cfPayload = {
      subscription_id: subscriptionId,
      customer_details: {
        customer_name: name,
        customer_email: email,
        customer_phone: phone || "9999999999",
      },
      plan_details: {
        plan_name: `SalesBuster ${normalizedPlan.toUpperCase()} Autopay`,
        plan_type: "PERIODIC",
        plan_currency: "INR",
        plan_amount: totalAmount,
        plan_max_amount: totalAmount,
        plan_intervals: 1,
        plan_interval_type: plan.intervalType,
      },
      authorization_details: {
        authorization_amount: 1,
        authorization_amount_refund: true,
        return_url: `${frontendBaseUrl}/dashboard?autopay_sub_id=${subscriptionId}`,
      },
      ...(withTrial && trialEndsAt
        ? { subscription_first_charge_time: trialEndsAt.toISOString() }
        : {}),
    };

    let cfResponseData = {};
    try {
      const cfRes = await fetch(`${getCashfreeBaseUrl()}/subscriptions`, {
        method: "POST",
        headers: getCashfreeHeaders(),
        body: JSON.stringify(cfPayload),
      });
      cfResponseData = await cfRes.json().catch(() => ({}));
      if (!cfRes.ok) {
        throw new Error(cfResponseData?.message || `HTTP ${cfRes.status}`);
      }
    } catch (cfErr) {
      const errMsg = cfErr?.message || "Cashfree request failed";
      console.error("[CashfreeAutopay] Create subscription error:", errMsg);
      return res.status(502).json({
        success: false,
        message: `Cashfree Autopay setup failed: ${errMsg}`,
      });
    }

    const { CashfreeSubscription, Organization } = getMasterModels();
    const subRecord = await CashfreeSubscription.create({
      subscriptionId,
      cfSubscriptionId: cfResponseData.cf_subscription_id || null,
      organizationId: orgId,
      planId: normalizedPlan,
      amount: plan.baseAmount,
      gstAmount,
      totalAmount,
      intervalType: plan.intervalType,
      withTrial: Boolean(withTrial),
      trialEndsAt,
      status: cfResponseData.subscription_status || "INITIALIZED",
      subscriptionSessionId: cfResponseData.subscription_session_id || null,
      authLink: cfResponseData.authorization_details?.authorization_url || null,
      nextChargeAt: trialEndsAt || now,
      customerEmail: email,
      customerPhone: phone,
      customerName: name,
    });

    if (orgId) {
      await Organization.findByIdAndUpdate(orgId, {
        $set: {
          cashfreeSubscriptionId: subscriptionId,
          autopayStatus: "initialized",
          ...(withTrial && trialEndsAt
            ? {
                isTrial: true,
                trialStartDate: now,
                trialEndsAt,
                accountType: "crm",
                seats: TRIAL_LIMITS.maxSeats,
                subscriptionEndDate: trialEndsAt,
              }
            : {}),
        },
      });
    }

    return res.status(201).json({
      success: true,
      message: withTrial
        ? "Autopay mandate initialized with 3-day free trial."
        : "Autopay mandate initialized.",
      data: {
        subscriptionId: subRecord.subscriptionId,
        cfSubscriptionId: subRecord.cfSubscriptionId,
        subscriptionSessionId: subRecord.subscriptionSessionId,
        authLink: subRecord.authLink,
        withTrial: subRecord.withTrial,
        trialEndsAt: subRecord.trialEndsAt,
        totalAmount: subRecord.totalAmount,
      },
    });
  } catch (error) {
    console.error("[CashfreeAutopay] Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to initialize Cashfree Autopay.",
    });
  }
};

/**
 * GET /api/payment/cashfree/autopay/status
 */
export const getAutopayStatusHandler = async (req, res) => {
  try {
    const orgId = req.organization?._id || req.user?.organizationId;
    if (!orgId) {
      return res.status(400).json({ success: false, message: "Organization context required." });
    }

    const { Organization, CashfreeSubscription } = getMasterModels();
    const org = await Organization.findById(orgId).lean();
    if (!org) {
      return res.status(404).json({ success: false, message: "Organization not found." });
    }

    const subscription = org.cashfreeSubscriptionId
      ? await CashfreeSubscription.findOne({ subscriptionId: org.cashfreeSubscriptionId }).lean()
      : null;

    return res.status(200).json({
      success: true,
      data: {
        isTrial: !!org.isTrial,
        trialStartDate: org.trialStartDate || null,
        trialEndsAt: org.trialEndsAt || null,
        autopayEnabled: !!org.autopayEnabled,
        autopayStatus: org.autopayStatus || "none",
        cashfreeSubscriptionId: org.cashfreeSubscriptionId || null,
        nextBillingDate: org.nextBillingDate || null,
        subscription,
      },
    });
  } catch (error) {
    console.error("[CashfreeAutopay] getAutopayStatusHandler error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch Autopay status." });
  }
};

/**
 * POST /api/payment/cashfree/autopay/cancel
 */
export const cancelAutopaySubscriptionHandler = async (req, res) => {
  try {
    const orgId = req.organization?._id || req.user?.organizationId;
    if (!orgId) {
      return res.status(400).json({ success: false, message: "Organization context required." });
    }

    const { Organization, CashfreeSubscription } = getMasterModels();
    const org = await Organization.findById(orgId);
    if (!org || !org.cashfreeSubscriptionId) {
      return res.status(404).json({ success: false, message: "No active Autopay subscription found." });
    }

    try {
      await fetch(
        `${getCashfreeBaseUrl()}/subscriptions/${org.cashfreeSubscriptionId}/manage`,
        {
          method: "POST",
          headers: getCashfreeHeaders(),
          body: JSON.stringify({
            subscription_id: org.cashfreeSubscriptionId,
            action: "CANCEL",
          }),
        }
      );
    } catch (cfErr) {
      console.warn("[CashfreeAutopay] Remote cancel warning:", cfErr?.message);
    }

    await CashfreeSubscription.updateOne(
      { subscriptionId: org.cashfreeSubscriptionId },
      { $set: { status: "CANCELLED" } }
    );

    org.autopayEnabled = false;
    org.autopayStatus = "cancelled";
    await org.save();

    return res.status(200).json({
      success: true,
      message: "Autopay subscription cancelled.",
    });
  } catch (error) {
    console.error("[CashfreeAutopay] cancelAutopaySubscriptionHandler error:", error);
    return res.status(500).json({ success: false, message: "Failed to cancel Autopay." });
  }
};

/**
 * Handles Cashfree Subscription webhook events (SUBSCRIPTION_STATUS_CHANGED, SUBSCRIPTION_PAYMENT_SUCCESS, SUBSCRIPTION_PAYMENT_FAILED).
 */
export const handleSubscriptionWebhookEvent = async (eventType, data) => {
  const { CashfreeSubscription, Organization } = getMasterModels();
  const subId = data?.subscription_id || data?.subscription?.subscription_id;
  if (!subId) return false;

  const sub = await CashfreeSubscription.findOne({ subscriptionId: subId });
  if (!sub) return false;

  if (eventType === "SUBSCRIPTION_STATUS_CHANGED") {
    const newStatus = data?.subscription_status || data?.status;
    if (newStatus) sub.status = newStatus;
    await sub.save();

    if (sub.organizationId) {
      const isActive = newStatus === "ACTIVE";
      await Organization.findByIdAndUpdate(sub.organizationId, {
        $set: {
          autopayEnabled: isActive,
          autopayStatus: String(newStatus || "initialized").toLowerCase(),
        },
      });
    }
    return true;
  }

  if (eventType === "SUBSCRIPTION_PAYMENT_SUCCESS") {
    const plan = PLAN_PRICING[sub.planId] || PLAN_PRICING.monthly;
    const now = new Date();
    const nextEnd = new Date(now.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);

    sub.status = "ACTIVE";
    sub.lastPaymentStatus = "SUCCESS";
    sub.lastPaymentAt = now;
    sub.nextChargeAt = nextEnd;
    await sub.save();

    if (sub.organizationId) {
      await Organization.findByIdAndUpdate(sub.organizationId, {
        $set: {
          isTrial: false,
          trialConverted: true,
          autopayEnabled: true,
          autopayStatus: "active",
          subscriptionPlan: sub.planId,
          subscriptionEndDate: nextEnd,
          nextBillingDate: nextEnd,
          status: "active",
        },
      });
    }
    return true;
  }

  if (eventType === "SUBSCRIPTION_PAYMENT_FAILED") {
    sub.lastPaymentStatus = "FAILED";
    sub.lastPaymentAt = new Date();
    await sub.save();
    return true;
  }

  return false;
};
