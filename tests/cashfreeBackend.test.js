import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import {
  getCashfreeBaseUrl,
  getCashfreeHeaders,
  verifyCashfreeWebhookSignature,
} from "../services/cashfreeService.js";
import { cashfreeOrderSchema } from "../models/CashfreeOrder.js";
import { cashfreeWebhookEventSchema } from "../models/CashfreeWebhookEvent.js";
import {
  CASHFREE_PRICING_CATALOG,
  resolveAuthoritativePrice,
} from "../controllers/cashfreeController.js";

describe("Cashfree Payment Gateway Backend Tests", () => {
  it("should configure Sandbox and Production URLs correctly", () => {
    const originalEnv = process.env.CASHFREE_ENV;
    try {
      process.env.CASHFREE_ENV = "SANDBOX";
      assert.equal(getCashfreeBaseUrl(), "https://sandbox.cashfree.com/pg");

      process.env.CASHFREE_ENV = "PRODUCTION";
      assert.equal(getCashfreeBaseUrl(), "https://api.cashfree.com/pg");
    } finally {
      process.env.CASHFREE_ENV = originalEnv;
    }
  });

  it("should format request headers with API version and client credentials", () => {
    const originalAppId = process.env.CASHFREE_APP_ID;
    const originalSecret = process.env.CASHFREE_SECRET_KEY;
    try {
      process.env.CASHFREE_APP_ID = "test_cf_app_123";
      process.env.CASHFREE_SECRET_KEY = "test_cf_secret_456";

      const headers = getCashfreeHeaders();
      assert.equal(headers["x-client-id"], "test_cf_app_123");
      assert.equal(headers["x-client-secret"], "test_cf_secret_456");
      assert.equal(headers["Content-Type"], "application/json");
      assert.ok(headers["x-api-version"]);
    } finally {
      process.env.CASHFREE_APP_ID = originalAppId;
      process.env.CASHFREE_SECRET_KEY = originalSecret;
    }
  });

  it("should verify valid HMAC-SHA256 webhook signatures", () => {
    const secretKey = "cf_test_secret_key_789";
    const timestamp = String(Date.now());
    const rawBody = JSON.stringify({
      type: "PAYMENT_SUCCESS_WEBHOOK",
      data: {
        order: { order_id: "sb_ord_12345", order_status: "PAID" },
        payment: { cf_payment_id: "cf_pay_999", payment_status: "SUCCESS" },
      },
    });

    const signaturePayload = timestamp + rawBody;
    const validSignature = crypto
      .createHmac("sha256", secretKey)
      .update(signaturePayload)
      .digest("base64");

    const isVerified = verifyCashfreeWebhookSignature({
      rawBody,
      timestamp,
      signature: validSignature,
      secretKey,
    });

    assert.equal(isVerified, true, "Valid signature must pass verification");
  });

  it("should reject tampered raw body or invalid signature", () => {
    const secretKey = "cf_test_secret_key_789";
    const timestamp = String(Date.now());
    const originalBody = JSON.stringify({ order_id: "order_1", amount: 500 });
    const tamperedBody = JSON.stringify({ order_id: "order_1", amount: 1 });

    const validSignature = crypto
      .createHmac("sha256", secretKey)
      .update(timestamp + originalBody)
      .digest("base64");

    const isVerified = verifyCashfreeWebhookSignature({
      rawBody: tamperedBody,
      timestamp,
      signature: validSignature,
      secretKey,
    });

    assert.equal(isVerified, false, "Tampered body must fail verification");
  });

  it("should reject expired webhook requests (replay attack protection)", () => {
    const secretKey = "cf_test_secret_key_789";
    // 10 minutes ago (> 300,000ms max age)
    const oldTimestamp = String(Date.now() - 600000);
    const rawBody = JSON.stringify({ test: true });

    const signature = crypto
      .createHmac("sha256", secretKey)
      .update(oldTimestamp + rawBody)
      .digest("base64");

    const isVerified = verifyCashfreeWebhookSignature({
      rawBody,
      timestamp: oldTimestamp,
      signature,
      secretKey,
      maxAgeMs: 300000,
    });

    assert.equal(isVerified, false, "Old timestamp must be rejected");
  });

  it("should enforce authoritative server-side pricing to prevent parameter tampering", () => {
    // 1. WhatsApp Campaigns Addon should resolve to ₹999 regardless of client input
    const addonPrice = resolveAuthoritativePrice({
      purpose: "addon",
      addonType: "whatsapp_campaigns",
      clientAmount: 1, // Tampered ₹1 input from client
    });
    assert.equal(addonPrice.amount, 999, "Server catalog must override tampered client amount");
    assert.equal(addonPrice.currency, "INR");

    // 2. Growth Subscription Plan should resolve to ₹2999
    const planPrice = resolveAuthoritativePrice({
      purpose: "subscription",
      planId: "growth",
      clientAmount: 50, // Tampered input
    });
    assert.equal(planPrice.amount, 2999, "Server catalog must enforce growth plan price");

    // 3. Reject invalid addon or plan
    assert.throws(() => {
      resolveAuthoritativePrice({ purpose: "addon", addonType: "non_existent_addon" });
    });

    // 4. Wallet recharge enforces minimum threshold
    assert.throws(() => {
      resolveAuthoritativePrice({ purpose: "wallet_credits", clientAmount: 20 });
    });
    const validWallet = resolveAuthoritativePrice({ purpose: "wallet_credits", clientAmount: 500 });
    assert.equal(validWallet.amount, 500);
  });

  it("should have correct schema definitions for CashfreeOrder and CashfreeWebhookEvent", () => {
    assert.ok(cashfreeOrderSchema.paths.orderId);
    assert.ok(cashfreeOrderSchema.paths.paymentSessionId);
    assert.ok(cashfreeOrderSchema.paths.orderStatus);
    assert.ok(cashfreeOrderSchema.paths.organizationId);

    assert.ok(cashfreeWebhookEventSchema.paths.eventId);
    assert.ok(cashfreeWebhookEventSchema.paths.eventType);
    assert.ok(cashfreeWebhookEventSchema.paths.orderId);
  });
});
