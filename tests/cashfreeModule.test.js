import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import {
  createCashfreeOrderSchema,
  queryOrdersSchema,
} from "../schemas/cashfreeSchemas.js";
import {
  resolveAuthoritativePrice,
  CASHFREE_PRICING_CATALOG,
} from "../controllers/cashfreeController.js";
import { verifyCashfreeWebhookSignature } from "../services/cashfreeService.js";

describe("Cashfree Module - Zod Schemas & Pricing Catalog", () => {
  it("createCashfreeOrderSchema parses valid order payload", () => {
    const valid = createCashfreeOrderSchema.safeParse({
      body: {
        purpose: "subscription",
        planId: "growth",
        orderNote: "Growth Plan Upgrade",
      },
    });
    assert.equal(valid.success, true);
    assert.equal(valid.data.body.purpose, "subscription");
  });

  it("queryOrdersSchema parses page, limit, and status filters", () => {
    const valid = queryOrdersSchema.safeParse({
      query: {
        page: "1",
        limit: "10",
        status: "paid",
        search: "sb_ord_123",
      },
    });
    assert.equal(valid.success, true);
    assert.equal(valid.data.query.status, "paid");
  });

  it("resolveAuthoritativePrice prevents client-side price tampering", () => {
    // Client attempts to pass 10 rupees for a Growth plan (₹2,999)
    const resolved = resolveAuthoritativePrice({
      purpose: "subscription",
      planId: "growth",
      clientAmount: 10,
    });

    assert.equal(resolved.amount, 2999);
    assert.equal(resolved.currency, "INR");
    assert.equal(resolved.title, CASHFREE_PRICING_CATALOG.subscription.growth.title);

    // Addon price resolution
    const addonResolved = resolveAuthoritativePrice({
      purpose: "addon",
      addonType: "whatsapp_campaigns",
      clientAmount: 1,
    });
    assert.equal(addonResolved.amount, 999);

    // Yearly & Quarterly plan resolutions
    const yearlyResolved = resolveAuthoritativePrice({
      purpose: "subscription",
      planId: "yearly",
      clientAmount: 100,
    });
    assert.equal(yearlyResolved.amount, 53940);

    const quarterlyResolved = resolveAuthoritativePrice({
      purpose: "subscription",
      planId: "quarterly",
      clientAmount: 50,
    });
    assert.equal(quarterlyResolved.amount, 17985);

    // Rejects invalid plan
    assert.throws(() => {
      resolveAuthoritativePrice({
        purpose: "subscription",
        planId: "invalid_plan_id",
      });
    }, /Invalid or unsupported subscription plan/);
  });
});

describe("Cashfree Module - Signature Verification", () => {
  it("verifyCashfreeWebhookSignature validates authentic HMAC signatures", () => {
    const secret = "test_cf_secret_key_12345";
    process.env.CASHFREE_SECRET_KEY = secret;

    const rawBody = JSON.stringify({ event: "PAYMENT_SUCCESS_WEBHOOK", data: { order_id: "sb_ord_test" } });
    const timestamp = Date.now().toString();

    // Replicate Cashfree's signature: HMAC-SHA256(timestamp + rawBody, secret) -> base64
    const signaturePayload = timestamp + rawBody;
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(signaturePayload)
      .digest("base64");

    const isValid = verifyCashfreeWebhookSignature({
      rawBody,
      timestamp,
      signature: expectedSignature,
    });

    assert.equal(isValid, true);

    const isTampered = verifyCashfreeWebhookSignature({
      rawBody: rawBody + "tampered",
      timestamp,
      signature: expectedSignature,
    });

    assert.equal(isTampered, false);
  });
});

describe("Payment Receipt Email Helper", () => {
  it("sendPaymentReceiptEmail formats receipt and dispatches successfully", async () => {
    const { sendPaymentReceiptEmail } = await import("../helpers/emailHelper.js");
    const mockOrder = {
      orderId: "sb_ord_test_123",
      orderAmount: 17985,
      orderCurrency: "INR",
      planId: "quarterly",
      customerDetails: {
        customerName: "Test Customer",
        customerEmail: "testcustomer@example.com",
        customerPhone: "9876543210",
      },
      paymentDetails: {
        cfPaymentId: "cf_pay_test_999",
        paymentMethod: "upi",
        paymentTime: new Date(),
      },
    };
    const mockOrg = {
      name: "Test Customer Workspace",
      email: "testcustomer@example.com",
      subscriptionEndDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    };

    const result = await sendPaymentReceiptEmail({
      order: mockOrder,
      organization: mockOrg,
      temporaryPassword: "TestPassword#123",
      isNewAccount: true,
      loginUrl: "https://salesbuster.ai/beta",
    });

    assert.equal(result, true);
  });
});
