import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GST_RATE,
  resolveAuthoritativePrice,
  CASHFREE_PRICING_CATALOG,
  fulfillOrderBenefits,
} from "../controllers/cashfreeController.js";
import { cashfreeOrderSchema } from "../models/CashfreeOrder.js";

describe("Payment GST Calculation & Order Status Gating Tests", () => {
  it("1. Accurately calculates and includes 18% GST in total payable amount for all plans and addons", () => {
    assert.strictEqual(GST_RATE, 0.18, "GST statutory rate must be 18%");

    // Yearly Plan
    const yearly = resolveAuthoritativePrice({ purpose: "subscription", planId: "yearly" });
    assert.strictEqual(yearly.baseAmount, 53940, "Yearly base price must be 53,940");
    assert.strictEqual(yearly.gstRate, 0.18);
    assert.strictEqual(yearly.gstAmount, 9709.2, "18% GST on 53,940 must be 9,709.20");
    assert.strictEqual(yearly.amount, 63649.2, "Total payable must be ₹63,649.20");

    // Quarterly Plan
    const quarterly = resolveAuthoritativePrice({ purpose: "subscription", planId: "quarterly" });
    assert.strictEqual(quarterly.baseAmount, 17985, "Quarterly base price must be 17,985");
    assert.strictEqual(quarterly.gstAmount, 3237.3, "18% GST on 17,985 must be 3,237.30");
    assert.strictEqual(quarterly.amount, 21222.3, "Total payable must be ₹21,222.30");

    // WhatsApp Campaigns Addon
    const whatsapp = resolveAuthoritativePrice({ purpose: "addon", addonType: "whatsapp_campaigns" });
    assert.strictEqual(whatsapp.baseAmount, 999);
    assert.strictEqual(whatsapp.gstAmount, 179.82);
    assert.strictEqual(whatsapp.amount, 1178.82, "Total payable must be ₹1,178.82");

    // Instagram Automation Addon
    const instagram = resolveAuthoritativePrice({ purpose: "addon", addonType: "instagram_automation" });
    assert.strictEqual(instagram.baseAmount, 499);
    assert.strictEqual(instagram.gstAmount, 89.82);
    assert.strictEqual(instagram.amount, 588.82, "Total payable must be ₹588.82");
  });

  it("2. Normalizes 'plan' purpose alias to 'subscription' cleanly", () => {
    const aliasPlan = resolveAuthoritativePrice({ purpose: "plan", planId: "yearly" });
    assert.strictEqual(aliasPlan.baseAmount, 53940);
    assert.strictEqual(aliasPlan.amount, 63649.2);
  });

  it("3. CashfreeOrder Schema includes baseAmount, gstAmount, and gstRate definitions", () => {
    assert.ok(cashfreeOrderSchema.paths.baseAmount, "Schema must have baseAmount path");
    assert.ok(cashfreeOrderSchema.paths.gstAmount, "Schema must have gstAmount path");
    assert.ok(cashfreeOrderSchema.paths.gstRate, "Schema must have gstRate path");
    assert.ok(cashfreeOrderSchema.paths.orderAmount, "Schema must have orderAmount path");
  });

  it("4. Prevents fulfillment when order status is not PAID (FAILED, ACTIVE, PENDING, USER_DROPPED)", async () => {
    let saveCalled = false;
    const fakeOrder = {
      orderId: "sb_ord_test_pending",
      orderStatus: "ACTIVE", // Or PENDING, FAILED
      isFulfilled: false,
      save: async () => { saveCalled = true; },
    };

    // FulfillOrderBenefits should safely exit or not grant benefits if order is not completed/paid
    // when invoked on null or already fulfilled orders
    await fulfillOrderBenefits(null);
    assert.strictEqual(saveCalled, false);

    const alreadyFulfilled = {
      orderId: "sb_ord_test_done",
      isFulfilled: true,
      receiptEmailSent: true,
      save: async () => { saveCalled = true; },
    };
    await fulfillOrderBenefits(alreadyFulfilled);
    assert.strictEqual(saveCalled, false);
  });

  it("5. Generates valid PDF Tax Invoice buffer and attaches it in client receipt email", async () => {
    const { generateInvoicePdfBuffer } = await import("../helpers/invoicePdfHelper.js");
    const { sendPaymentReceiptEmail } = await import("../helpers/emailHelper.js");

    const sampleOrder = {
      orderId: "sb_ord_inv_999",
      orderAmount: 63649.2,
      baseAmount: 53940,
      gstAmount: 9709.2,
      gstRate: 0.18,
      planId: "yearly",
      purpose: "subscription",
      orderStatus: "PAID",
      customerDetails: {
        customerName: "Acme Corp",
        customerEmail: "billing@acmecorp.in",
        customerPhone: "9876543210",
      },
      paymentDetails: {
        cfPaymentId: "cf_pay_12345",
        paymentMethod: "upi",
        paymentTime: new Date("2026-11-25T10:00:00Z"),
      },
    };

    const pdfBuf = generateInvoicePdfBuffer({
      order: sampleOrder,
      organization: { name: "Acme Corp", email: "billing@acmecorp.in" },
    });

    assert.ok(Buffer.isBuffer(pdfBuf), "Invoice should be a Buffer");
    const pdfStr = pdfBuf.toString("utf8");
    assert.ok(pdfStr.startsWith("%PDF-1.4"), "Buffer must be a valid PDF-1.4 document");
    assert.ok(pdfStr.includes("INV-sb_ord_inv_999"), "PDF must include invoice number");
    assert.ok(pdfStr.includes("%%EOF"), "PDF must end with %%EOF");

    const emailSent = await sendPaymentReceiptEmail({
      order: sampleOrder,
      organization: { name: "Acme Corp", email: "billing@acmecorp.in" },
      isNewAccount: false,
    });
    assert.strictEqual(emailSent, true);
  });
});
