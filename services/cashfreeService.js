import crypto from "crypto";

/**
 * Returns Cashfree PG base URL based on environment (SANDBOX vs PRODUCTION)
 */
export const getCashfreeBaseUrl = () => {
  const env = (process.env.CASHFREE_ENV || "SANDBOX").toUpperCase();
  return env === "PRODUCTION"
    ? "https://api.cashfree.com/pg"
    : "https://sandbox.cashfree.com/pg";
};

/**
 * Returns Cashfree API version
 */
export const getCashfreeApiVersion = () => {
  return process.env.CASHFREE_API_VERSION || "2023-08-01";
};

/**
 * Retrieves Cashfree credentials
 */
export const getCashfreeCredentials = () => {
  return {
    appId: process.env.CASHFREE_APP_ID || process.env.CASHFREE_CLIENT_ID || "",
    secretKey: process.env.CASHFREE_SECRET_KEY || process.env.CASHFREE_CLIENT_SECRET || "",
  };
};

/**
 * Returns standard request headers for Cashfree Payment Gateway APIs
 */
export const getCashfreeHeaders = () => {
  const { appId, secretKey } = getCashfreeCredentials();
  return {
    "x-client-id": appId,
    "x-client-secret": secretKey,
    "x-api-version": getCashfreeApiVersion(),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
};

/**
 * Step 1: Create an Order Server-Side
 * POST /pg/orders
 */
export const createCashfreePgOrder = async ({
  orderId,
  orderAmount,
  orderCurrency = "INR",
  customerDetails,
  orderMeta,
  orderTags = {},
  orderNote = "",
}) => {
  const { appId, secretKey } = getCashfreeCredentials();
  if (!appId || !secretKey) {
    throw new Error(
      "Cashfree credentials missing. Please configure CASHFREE_APP_ID and CASHFREE_SECRET_KEY."
    );
  }

  const payload = {
    order_id: orderId,
    order_amount: Number(orderAmount),
    order_currency: orderCurrency || "INR",
    customer_details: {
      customer_id: customerDetails.customerId,
      customer_name: customerDetails.customerName || "",
      customer_email: customerDetails.customerEmail || "",
      customer_phone: customerDetails.customerPhone,
    },
    order_meta: {
      return_url: orderMeta?.returnUrl || "",
      notify_url: orderMeta?.notifyUrl || "",
      payment_methods: orderMeta?.paymentMethods || "cc,dc,upi,nb,app,paylater",
    },
    order_tags: orderTags,
    order_note: orderNote || "",
  };

  const url = `${getCashfreeBaseUrl()}/orders`;
  const response = await fetch(url, {
    method: "POST",
    headers: getCashfreeHeaders(),
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    const errorMsg =
      data.message || data.error?.message || `Cashfree Order API failed with status ${response.status}`;
    const err = new Error(errorMsg);
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return {
    orderId: data.order_id,
    cfOrderId: String(data.cf_order_id || ""),
    paymentSessionId: data.payment_session_id,
    orderStatus: data.order_status,
    orderAmount: data.order_amount,
    orderCurrency: data.order_currency,
    rawResponse: data,
  };
};

/**
 * Step 3: Fetch / Verify Order Status Server-Side
 * GET /pg/orders/{order_id}
 */
export const fetchCashfreePgOrder = async (orderId) => {
  if (!orderId) throw new Error("Order ID is required.");

  const url = `${getCashfreeBaseUrl()}/orders/${encodeURIComponent(orderId)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: getCashfreeHeaders(),
  });

  const data = await response.json();
  if (!response.ok) {
    const errorMsg = data.message || `Failed to fetch order ${orderId} (${response.status})`;
    const err = new Error(errorMsg);
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return {
    orderId: data.order_id,
    cfOrderId: String(data.cf_order_id || ""),
    orderStatus: data.order_status, // "PAID", "ACTIVE", "EXPIRED", "TERMINATED"
    orderAmount: data.order_amount,
    orderCurrency: data.order_currency,
    paymentSessionId: data.payment_session_id,
    customerDetails: data.customer_details,
    orderMeta: data.order_meta,
    rawResponse: data,
  };
};

/**
 * Fetch Order Payments Details
 * GET /pg/orders/{order_id}/payments
 */
export const fetchCashfreePgPayments = async (orderId) => {
  if (!orderId) throw new Error("Order ID is required.");

  const url = `${getCashfreeBaseUrl()}/orders/${encodeURIComponent(orderId)}/payments`;
  const response = await fetch(url, {
    method: "GET",
    headers: getCashfreeHeaders(),
  });

  const data = await response.json();
  if (!response.ok) {
    return [];
  }

  return Array.isArray(data) ? data : [];
};

/**
 * Cryptographic Webhook Signature Verification
 * Implements Cashfree HMAC-SHA256 signature verification over raw body buffer:
 *   data = timestamp + rawBody
 *   expectedSignature = base64(hmac_sha256(data, secretKey))
 */
export const verifyCashfreeWebhookSignature = ({
  rawBody,
  timestamp,
  signature,
  secretKey,
  maxAgeMs = 300000, // 5 minutes replay protection window
}) => {
  if (!signature || !timestamp || rawBody === undefined || rawBody === null) {
    return false;
  }

  const secret = secretKey || getCashfreeCredentials().secretKey;
  if (!secret) {
    console.warn("[CashfreeWebhook] Secret key missing for signature verification.");
    return false;
  }

  // 1. Replay attack check
  if (maxAgeMs > 0) {
    let tsNum = Number(timestamp);
    // Handle both seconds (10 digits) and milliseconds (13 digits)
    if (String(timestamp).length === 10) {
      tsNum = tsNum * 1000;
    }
    if (!isNaN(tsNum)) {
      const age = Math.abs(Date.now() - tsNum);
      if (age > maxAgeMs) {
        console.warn(`[CashfreeWebhook] Request rejected: timestamp expired (${age}ms old).`);
        return false;
      }
    }
  }

  // 2. Compute HMAC-SHA256
  const rawBodyStr =
    typeof rawBody === "string" ? rawBody : Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : "";

  const payload = timestamp + rawBodyStr;
  const computedSignature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64");

  // 3. Constant-time comparison
  try {
    const computedBuf = Buffer.from(computedSignature, "base64");
    const receivedBuf = Buffer.from(signature, "base64");

    if (computedBuf.length !== receivedBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(computedBuf, receivedBuf);
  } catch (err) {
    return false;
  }
};
