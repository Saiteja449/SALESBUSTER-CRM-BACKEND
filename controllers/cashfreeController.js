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
import {
  createCashfreePgOrder,
  fetchCashfreePgOrder,
  fetchCashfreePgPayments,
  verifyCashfreeWebhookSignature,
} from "../services/cashfreeService.js";

/**
 * Authoritative Server-Side Pricing Catalog (Prevents Client-Side Parameter Tampering)
 */
export const CASHFREE_PRICING_CATALOG = {
  addon: {
    whatsapp_campaigns: {
      amount: 999,
      currency: "INR",
      title: "WhatsApp Campaigns Monthly Addon",
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

/**
 * Validates and resolves the authoritative price server-side
 */
export const resolveAuthoritativePrice = ({ purpose, planId, addonType, clientAmount }) => {
  if (purpose === "addon") {
    const addonConfig = CASHFREE_PRICING_CATALOG.addon[addonType];
    if (!addonConfig) {
      throw new Error(`Invalid or unsupported addon type: '${addonType}'`);
    }
    return {
      amount: addonConfig.amount,
      currency: addonConfig.currency,
      title: addonConfig.title,
    };
  }

  if (purpose === "subscription") {
    const planConfig = CASHFREE_PRICING_CATALOG.subscription[planId];
    if (!planConfig) {
      throw new Error(`Invalid or unsupported subscription plan: '${planId}'`);
    }
    return {
      amount: planConfig.amount,
      currency: planConfig.currency,
      title: planConfig.title,
    };
  }

  if (purpose === "wallet_credits" || purpose === "service") {
    const parsedAmount = Number(clientAmount);
    if (!parsedAmount || isNaN(parsedAmount) || parsedAmount < 100) {
      throw new Error("Wallet recharge requires a minimum amount of ₹100.");
    }
    return {
      amount: Math.round(parsedAmount),
      currency: "INR",
      title: `Wallet Credit Recharge - ₹${Math.round(parsedAmount)}`,
    };
  }

  throw new Error(`Unsupported order purpose: '${purpose}'`);
};

/**
 * Fulfill organization subscription or addon upon successful payment and dispatch confirmation email
 */
export const fulfillOrderBenefits = async (order) => {
  try {
    if (!order) return;

    // Idempotency: skip if already fulfilled and email sent
    if (order.isFulfilled && order.receiptEmailSent) {
      console.log(`[CashfreeFulfillment] Order ${order.orderId} already fulfilled and receipt email sent. Skipping.`);
      return;
    }

    const { Organization, AuthUser } = getMasterModels();
    let org = null;
    let temporaryPassword = null;
    let isNewAccount = false;

    // 1. Resolve existing organization by organizationId or customer email
    if (order.organizationId) {
      org = await Organization.findById(order.organizationId);
    }
    if (!org && order.customerDetails?.customerEmail) {
      org = await Organization.findOne({
        email: order.customerDetails.customerEmail.toLowerCase().trim(),
      });
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
      let seatCount = 5;
      let durationMonths = 1;
      if (order.planId === "yearly" || order.planId === "annual") {
        durationMonths = 12;
        seatCount = 5;
      } else if (order.planId === "quarterly") {
        durationMonths = 3;
        seatCount = 5;
      } else if (order.planId === "enterprise") {
        durationMonths = 1;
        seatCount = 10;
      } else if (order.planId === "growth") {
        durationMonths = 1;
        seatCount = 5;
      } else {
        durationMonths = 1;
        seatCount = 1;
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
      const masterAuthUser = await AuthUser.create({
        email: cleanEmail,
        password: hashedPassword,
        name: `${custName} Admin`,
        role: "sales manager",
        organizationId: org._id,
        tenantDbName,
        isOrgOwner: true,
        status: "active",
      });

      // Initialize tenant database and create Owner inside tenant DB
      const tenantModels = getTenantModels(tenantDbName);
      await tenantModels.User.create({
        _id: masterAuthUser._id,
        name: `${custName} Admin`,
        email: cleanEmail,
        password: hashedPassword,
        role: "sales manager",
        organizationId: org._id,
        isOrgOwner: true,
        phone: cleanPhone,
        status: "active",
      });

      org.ownerId = masterAuthUser._id;
      await org.save();

      order.organizationId = org._id;
      console.log(`[CashfreeFulfillment] Auto-provisioned new tenant organization: ${org._id} (${org.name})`);
    } else {
      // Existing Organization: fulfill addon or subscription
      if (order.purpose === "addon") {
        org.addons = org.addons || {};
        if (order.addonType === "whatsapp_campaigns") {
          org.hasWhatsAppCampaignsAddon = true;
          org.addons.whatsappCampaigns = true;
        } else if (order.addonType === "instagram_automation") {
          org.hasInstagramAddon = true;
        }
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
        }
      }

      await org.save();
      console.log(`[CashfreeFulfillment] Benefits successfully applied for org: ${org._id}`);
    }

    // 3. Dispatch Payment Receipt & Confirmation Email
    const targetEmail = order.customerDetails?.customerEmail || org.email;
    if (targetEmail) {
      try {
        const appLoginUrl =
          process.env.APP_URL ||
          process.env.FRONTEND_URL ||
          "https://salesbuster.ai/beta";

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
          console.warn(`[CashfreeFulfillment] Payment receipt email could not be delivered to ${targetEmail}`);
        }
      } catch (emailErr) {
        console.error("[CashfreeFulfillment] Error dispatching payment receipt email:", emailErr.message);
      }
    }

    order.isFulfilled = true;
    await order.save();
  } catch (err) {
    console.error("[CashfreeFulfillment] Error fulfilling order benefits:", err.message);
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
      // Allow public website checkout by resolving or generating guest organization
      const custEmail = req.body.customerDetails?.customerEmail;
      const { Organization } = getMasterModels();
      if (custEmail && Organization) {
        const existingOrg = await Organization.findOne({ email: custEmail.toLowerCase() }).lean();
        if (existingOrg) {
          organizationId = existingOrg._id;
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
      orderNote = "",
      customerDetails = {},
      returnUrl = "",
      orderAmount: clientAmount,
    } = req.body;

    // 1. Authoritative Server-Side Price Resolution (prevents parameter tampering)
    const priceResolution = resolveAuthoritativePrice({
      purpose,
      planId,
      addonType,
      clientAmount,
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
    if (cfLiveOrder) {
      const prevStatus = localOrder.orderStatus;
      localOrder.orderStatus = cfLiveOrder.orderStatus;
      if (cfLiveOrder.cfOrderId) localOrder.cfOrderId = cfLiveOrder.cfOrderId;

      if (cfPayments.length > 0) {
        const latestPayment = cfPayments[0];
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

      await localOrder.save();

      // Trigger benefit fulfillment if transitioned to PAID
      if (prevStatus !== "PAID" && cfLiveOrder.orderStatus === "PAID") {
        await fulfillOrderBenefits(localOrder);
      }
    }

    return res.status(200).json({
      success: true,
      order: localOrder,
      liveStatus: cfLiveOrder?.orderStatus || localOrder?.orderStatus,
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
      query.orderStatus = status.toUpperCase();
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
              $sum: { $cond: [{ $in: ["$orderStatus", ["FAILED", "EXPIRED", "TERMINATED"]] }, 1, 0] },
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
