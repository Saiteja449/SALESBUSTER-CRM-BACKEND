import crypto from "crypto";
import { getTenantModels, getMasterModels } from "../services/tenantManager.js";
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
 * Fulfill organization subscription or addon upon successful payment
 */
const fulfillOrderBenefits = async (order) => {
  try {
    const { Organization } = getMasterModels();
    const org = await Organization.findById(order.organizationId);
    if (!org) {
      console.warn(`[CashfreeFulfillment] Organization not found for ID: ${order.organizationId}`);
      return;
    }

    if (order.purpose === "addon") {
      if (order.addonType === "whatsapp_campaigns") {
        org.hasWhatsAppCampaignsAddon = true;
      } else if (order.addonType === "instagram_automation") {
        org.hasInstagramAddon = true;
      }
    } else if (order.purpose === "subscription") {
      if (order.planId) {
        org.plan = order.planId;
        org.status = "active";
        // Extend subscription by 30 days
        const currentEnd = org.subscriptionEndDate && new Date(org.subscriptionEndDate) > new Date()
          ? new Date(org.subscriptionEndDate)
          : new Date();
        org.subscriptionEndDate = new Date(currentEnd.getTime() + 30 * 24 * 60 * 60 * 1000);
      }
    }

    await org.save();
    console.log(`[CashfreeFulfillment] Benefits successfully applied for org: ${org._id}`);
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
    const organizationId = req.user?.organizationId || req.organization?._id;
    if (!organizationId) {
      return res.status(400).json({ success: false, message: "Organization is required." });
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
      process.env.APP_URL || process.env.FRONTEND_URL || "https://crm.salesbuster.ai";
    const backendBaseUrl =
      process.env.BACKEND_URL || "https://api.salesbuster.ai";

    const finalReturnUrl =
      returnUrl || `${appBaseUrl}/payment/status?order_id={order_id}`;
    const finalNotifyUrl = `${backendBaseUrl}/api/payment/cashfree/webhook`;

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

    return res.status(201).json({
      success: true,
      message: "Cashfree order created successfully.",
      orderId: newOrder.orderId,
      cfOrderId: newOrder.cfOrderId,
      paymentSessionId: newOrder.paymentSessionId,
      orderStatus: newOrder.orderStatus,
      orderAmount: newOrder.orderAmount,
      orderCurrency: newOrder.orderCurrency,
      environment: process.env.CASHFREE_ENV || "SANDBOX",
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

    // IDOR Prevention: Enforce organization isolation
    if (
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
