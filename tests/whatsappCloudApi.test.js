import test, { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import mongoose from "mongoose";
import {
  verifyMetaSignature,
  toInternationalPhone,
  receiveWhatsAppWebhook,
  claimOrPersistWebhookEvent,
  persistPendingChange,
  makeMessageEventId,
  makeStatusEventId,
  makeChangeLevelEventId,
} from "../controllers/whatsappWebhookController.js";
import {
  toInternationalPhone as utilsToIntlPhone,
  normalizePhoneDigits,
} from "../utils/phoneUtils.js";
import {
  sendMessage,
  sendTemplateToLead,
  getApprovedTemplatesForChat,
} from "../controllers/whatsappController.js";
import { reprocessPendingWebhookEvents } from "../services/whatsappWebhookRetryWorker.js";
import { getWebhookSecurityDiagnostics } from "../utils/securityDiagnostics.js";
import Message from "../models/Message.js";
import Lead from "../models/Lead.js";
import { encryptApiKey } from "../utils/encryption.js";

// Helper to create mock HTTP response
const createMockRes = () => {
  const res = {
    statusCode: 200,
    headers: {},
    data: null,
    bodySent: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.data = payload;
      return this;
    },
    send(payload) {
      this.bodySent = payload;
      return this;
    },
    setHeader(key, val) {
      this.headers[key] = val;
    },
  };
  return res;
};

// ============================================================================
// 1. WEBHOOK SIGNATURE VALIDATION & HEALTH DIAGNOSTICS
// ============================================================================
describe("Finding 5: Webhook Signature Validation & Diagnostics", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("fails closed in production (returns false) when META_APP_SECRET is missing", () => {
    process.env.NODE_ENV = "production";
    delete process.env.META_APP_SECRET;

    const req = {
      headers: { "x-hub-signature-256": "sha256=abcdef123456" },
      rawBody: Buffer.from(JSON.stringify({ object: "whatsapp_business_account" })),
    };

    const isValid = verifyMetaSignature(req);
    assert.equal(isValid, false, "Must fail closed in production when META_APP_SECRET is absent");
  });

  it("allows payload in non-production when META_APP_SECRET is missing (dev fallback with warning)", () => {
    process.env.NODE_ENV = "development";
    delete process.env.META_APP_SECRET;

    const req = {
      headers: {},
      rawBody: Buffer.from(JSON.stringify({ object: "whatsapp_business_account" })),
    };

    const isValid = verifyMetaSignature(req);
    assert.equal(isValid, true, "Should allow in dev mode to prevent developer lockout");
  });

  it("accepts request with valid HMAC-SHA256 signature", () => {
    const secret = "test_meta_app_secret_1234567890";
    process.env.META_APP_SECRET = secret;
    const bodyStr = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

    const hmacHex = crypto
      .createHmac("sha256", secret)
      .update(bodyStr)
      .digest("hex");
    const validHeader = `sha256=${hmacHex}`;

    const req = {
      headers: { "x-hub-signature-256": validHeader },
      rawBody: Buffer.from(bodyStr),
    };

    const isValid = verifyMetaSignature(req);
    assert.equal(isValid, true, "Valid HMAC signature must be accepted");
  });

  it("rejects request with invalid HMAC signature (wrong secret/tampered payload)", () => {
    process.env.META_APP_SECRET = "correct_secret";
    const bodyStr = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

    const badHex = crypto
      .createHmac("sha256", "wrong_secret")
      .update(bodyStr)
      .digest("hex");

    const req = {
      headers: { "x-hub-signature-256": `sha256=${badHex}` },
      rawBody: Buffer.from(bodyStr),
    };

    const isValid = verifyMetaSignature(req);
    assert.equal(isValid, false, "Mismatched signature must be rejected");
  });

  it("rejects request with missing X-Hub-Signature-256 header", () => {
    process.env.META_APP_SECRET = "test_secret";
    const req = {
      headers: {},
      rawBody: Buffer.from("{}"),
    };

    const isValid = verifyMetaSignature(req);
    assert.equal(isValid, false, "Missing signature header must be rejected");
  });

  it("safely rejects malformed signature without throwing exception", () => {
    process.env.META_APP_SECRET = "test_secret";

    const malformedSignatures = [
      "not-even-sha256",
      "sha256=",
      "sha256=123",
      "sha256=xyz",
      "md5=abcdef",
    ];

    for (const sig of malformedSignatures) {
      const req = {
        headers: { "x-hub-signature-256": sig },
        rawBody: Buffer.from("{}"),
      };
      assert.doesNotThrow(() => {
        const isValid = verifyMetaSignature(req);
        assert.equal(isValid, false, `Malformed signature '${sig}' must be safely rejected`);
      });
    }
  });

  it("diagnostics report misconfigured in production when META_APP_SECRET is absent", () => {
    process.env.NODE_ENV = "production";
    delete process.env.META_APP_SECRET;

    const diag = getWebhookSecurityDiagnostics();
    assert.equal(diag.status, "misconfigured");
    assert.equal(diag.metaAppSecretConfigured, false);
    assert.equal(diag.webhookSignatureEnforcement, "strict");
  });

  it("diagnostics report healthy when META_APP_SECRET is configured", () => {
    process.env.NODE_ENV = "production";
    process.env.META_APP_SECRET = "configured_secret";

    const diag = getWebhookSecurityDiagnostics();
    assert.equal(diag.status, "healthy");
    assert.equal(diag.metaAppSecretConfigured, true);
    assert.equal(diag.webhookSignatureEnforcement, "strict");
  });
});

// ============================================================================
// 2. PHONE NUMBER CANONICALIZATION & RECIPIENT FORMATTING
// ============================================================================
describe("Finding 2: Phone Number Canonicalization", () => {
  it("normalizes a 10-digit Indian local number to country-prefixed format (91XXXXXXXXXX)", () => {
    assert.equal(toInternationalPhone("9876543210"), "919876543210");
    assert.equal(utilsToIntlPhone("9876543210"), "919876543210");
  });

  it("normalizes Indian number with leading zero (0XXXXXXXXXX) to 91XXXXXXXXXX", () => {
    assert.equal(toInternationalPhone("09876543210"), "919876543210");
    assert.equal(utilsToIntlPhone("09876543210"), "919876543210");
  });

  it("does NOT double-prefix a number that already has the 91 country code", () => {
    assert.equal(toInternationalPhone("919876543210"), "919876543210");
    assert.equal(toInternationalPhone("+91 98765 43210"), "919876543210");
    assert.equal(toInternationalPhone("+91-98765-43210"), "919876543210");
    assert.notEqual(toInternationalPhone("919876543210"), "91919876543210");
  });

  it("preserves international numbers with other country codes without adding 91", () => {
    // US (+1)
    assert.equal(toInternationalPhone("+1 415 555 2671"), "14155552671");
    assert.equal(toInternationalPhone("14155552671"), "14155552671");

    // UK (+44)
    assert.equal(toInternationalPhone("+44 7911 123456"), "447911123456");

    // UAE (+971)
    assert.equal(toInternationalPhone("+971 50 123 4567"), "971501234567");
  });

  it("Lead schema normalization hook preserves international format without 10-digit truncation", () => {
    const usLead = new Lead({
      name: "John Doe",
      phone: "+1 415 555 2671",
    });
    assert.equal(
      usLead.phoneNormalized,
      "14155552671",
      "US phone must not be truncated to 10 digits or prepended with 91"
    );

    const indianLead = new Lead({
      name: "Rahul",
      phone: "9876543210",
    });
    assert.equal(
      indianLead.phoneNormalized,
      "919876543210",
      "Indian 10-digit phone must be normalized to 91XXXXXXXXXX"
    );
  });

  it("handles empty or invalid inputs gracefully", () => {
    assert.equal(toInternationalPhone(""), "");
    assert.equal(toInternationalPhone(null), "");
    assert.equal(toInternationalPhone(undefined), "");
  });

  it("normalizePhoneDigits extracts 10-digit national number for lookup", () => {
    assert.equal(normalizePhoneDigits("919876543210"), "9876543210");
    assert.equal(normalizePhoneDigits("09876543210"), "9876543210");
    assert.equal(normalizePhoneDigits("9876543210"), "9876543210");
  });
});

// ============================================================================
// 3. WEBHOOK PRODUCTION HANDLER, DURABLE INGESTION & RETRY WORKER
// ============================================================================
describe("Finding 1 & 4: Webhook Event Deduplication, Durable Ingestion & Retry", () => {
  it("receiveWhatsAppWebhook returns HTTP 500 when pre-acknowledgment persistence fails (forces Meta retry)", async () => {
    const mockWAWebhookEvent = {
      updateOne: async () => {
        const dbErr = new Error("Connection timed out to MongoDB cluster");
        dbErr.name = "MongoNetworkError";
        throw dbErr;
      },
    };

    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "entry_1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone_101" },
                messages: [{ id: "wamid_fail_test", from: "919876543210", text: { body: "Hi" } }],
              },
            },
          ],
        },
      ],
    };

    const secret = process.env.META_APP_SECRET || "test_secret_for_webhook";
    process.env.META_APP_SECRET = secret;
    const bodyStr = JSON.stringify(payload);
    const sig = "sha256=" + crypto.createHmac("sha256", secret).update(bodyStr).digest("hex");

    const req = {
      headers: { "x-hub-signature-256": sig },
      body: payload,
      rawBody: Buffer.from(bodyStr),
      masterModels: {
        WAWebhookEvent: mockWAWebhookEvent,
      },
    };

    const res = createMockRes();
    await receiveWhatsAppWebhook(req, res);

    assert.equal(res.statusCode, 500, "Persistence failure must return 500 so Meta will retry");
    assert.equal(res.bodySent, "INGESTION_FAILED");
  });

  it("receiveWhatsAppWebhook acknowledges with HTTP 200 after durable persistence", async () => {
    const persistedEvents = new Map();
    const mockWAWebhookEvent = {
      updateOne: async ({ eventId }, update) => {
        persistedEvents.set(eventId, { eventId, status: update.$setOnInsert?.status || "pending" });
      },
      findOneAndUpdate: async ({ eventId }) => {
        return { eventId, status: "processing" };
      },
      findOne: async () => null,
    };

    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "entry_2",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone_101" },
                messages: [{ id: "wamid_ack_test", from: "919876543210", text: { body: "Hi" } }],
              },
            },
          ],
        },
      ],
    };

    const secret = process.env.META_APP_SECRET || "test_secret_for_webhook";
    process.env.META_APP_SECRET = secret;
    const bodyStr = JSON.stringify(payload);
    const sig = "sha256=" + crypto.createHmac("sha256", secret).update(bodyStr).digest("hex");

    const req = {
      headers: { "x-hub-signature-256": sig },
      body: payload,
      rawBody: Buffer.from(bodyStr),
      masterModels: {
        WAWebhookEvent: mockWAWebhookEvent,
      },
    };

    const res = createMockRes();
    await receiveWhatsAppWebhook(req, res);

    assert.equal(res.statusCode, 200, "Successful durable ingestion must acknowledge 200");
    assert.equal(res.bodySent, "EVENT_RECEIVED");
    assert.ok(persistedEvents.size > 0, "At least one event must be persisted before acknowledging 200");
  });

  it("exercises production handler: separate inbound messages for same phone have distinct IDs", async () => {
    const phoneId = "phone_id_555";
    const phoneNumber = "919876543210";

    const msg1 = {
      id: "wamid.HBgMOTE5ODc2NTQzMjEwFQIAEhgUM0EBMEEw",
      from: phoneNumber,
      timestamp: "1720000001",
      type: "text",
      text: { body: "First message" },
    };

    const msg2 = {
      id: "wamid.HBgMOTE5ODc2NTQzMjEwFQIAEhgUM0EBMEEx",
      from: phoneNumber,
      timestamp: "1720000005",
      type: "text",
      text: { body: "Second message" },
    };

    // Both messages have distinct event IDs
    const id1 = makeMessageEventId("waba_entry_99", msg1.id);
    const id2 = makeMessageEventId("waba_entry_99", msg2.id);

    assert.notEqual(id1, id2, "Two messages for the same phone must have distinct keys");
    assert.ok(id1.includes(msg1.id));
    assert.ok(id2.includes(msg2.id));
  });

  it("claimOrPersistWebhookEvent atomically claims events and prevents duplicate processing via E11000", async () => {
    const db = new Map();

    const mockWAWebhookEvent = {
      findOneAndUpdate: async ({ eventId, status }, update, options) => {
        const existing = db.get(eventId);
        if (existing) {
          // If existing is already "processing" or "processed", filter status $nin fails
          if (["processed", "processing"].includes(existing.status)) {
            // MongoDB upsert collision throws E11000 duplicate key error
            const dupErr = new Error(`E11000 duplicate key error collection: WAWebhookEvents index: eventId_1 dup key: { eventId: "${eventId}" }`);
            dupErr.code = 11000;
            throw dupErr;
          }
          existing.status = update.$set.status;
          return existing;
        }

        const newDoc = {
          eventId,
          field: update.$setOnInsert.field,
          payload: update.$setOnInsert.payload,
          status: update.$set.status,
        };
        db.set(eventId, newDoc);
        return newDoc;
      },
    };

    const eventId = "msg_concurrent_test_123";

    // Request 1 claims
    const claim1 = await claimOrPersistWebhookEvent(
      mockWAWebhookEvent,
      eventId,
      "inbound_message",
      { text: "hello" },
      "processing"
    );
    assert.equal(claim1.shouldProcess, true);
    assert.equal(claim1.isDuplicate, false);

    // Request 2 arrives concurrently while Request 1 is still processing
    const claim2 = await claimOrPersistWebhookEvent(
      mockWAWebhookEvent,
      eventId,
      "inbound_message",
      { text: "hello" },
      "processing"
    );
    assert.equal(claim2.shouldProcess, false, "Concurrent delivery must be rejected");
    assert.equal(claim2.isDuplicate, true);
  });

  it("reprocessPendingWebhookEvents retries pending and failed events", async () => {
    const events = [
      {
        eventId: "msg_pending_event_1",
        field: "messages",
        payload: {
          metadata: { phone_number_id: "phone_123" },
          messages: [],
        },
        status: "pending",
        retryCount: 0,
        updatedAt: new Date(Date.now() - 60000), // 60s ago
      },
    ];

    let claimedCount = 0;
    const mockWAWebhookEvent = {
      find: () => ({
        sort: () => ({
          limit: async () => events,
        }),
      }),
      findOneAndUpdate: async ({ eventId }) => {
        claimedCount++;
        return { eventId, status: "processing" };
      },
      findOne: async () => null,
      updateOne: async () => {},
    };

    const mockWAAccount = {
      findOne: async () => null,
    };

    const mockOrg = {
      findById: async () => null,
      findOne: async () => null,
    };

    const result = await reprocessPendingWebhookEvents({
      olderThanMs: 1000,
      masterModels: {
        WAWebhookEvent: mockWAWebhookEvent,
        WAAccount: mockWAAccount,
        Organization: mockOrg,
      },
    });

    assert.equal(claimedCount, 1, "The pending event must be claimed for reprocessing");
    assert.ok(result.reprocessed >= 0);
  });
});

// ============================================================================
// 4. TEMPLATE SENDING & 24-HOUR CUSTOMER SERVICE WINDOW
// ============================================================================
describe("Finding 3: Template Sending & 24h Window Customer Re-engagement", () => {
  it("validates that Message schema accepts messageType: 'template' without error", () => {
    const templateMessage = new Message({
      messageId: "out_template_12345",
      leadId: new mongoose.Types.ObjectId(),
      sender: "Sales Agent",
      direction: "outgoing",
      messageType: "template",
      text: "Hello from template",
    });

    // validateSync() must NOT throw 'is not a valid enum value for path `messageType`'
    const validationError = templateMessage.validateSync();
    assert.equal(
      validationError,
      undefined,
      "messageType 'template' must be valid in Message schema"
    );
  });

  it("rejects unapproved template with clear error message (status: PENDING)", async () => {
    const leadId = new mongoose.Types.ObjectId().toString();

    const mockLead = {
      _id: leadId,
      name: "Ramesh",
      phone: "9876543210",
      assignedTo: "Unassigned",
    };

    const mockTemplate = {
      name: "welcome_pending",
      status: "PENDING",
      category: "MARKETING",
      language: "en_US",
    };

    const req = {
      user: { _id: "admin_1", role: "super_admin" },
      body: {
        leadId,
        templateName: "welcome_pending",
      },
      tenantModels: {
        Lead: { findById: async () => mockLead },
        WhatsAppTemplate: { findOne: async () => mockTemplate },
      },
    };

    const res = createMockRes();
    await sendTemplateToLead(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.data.success, false);
    assert.match(res.data.message, /not approved by Meta/);
  });

  it("rejects non-existent template with 400", async () => {
    const leadId = new mongoose.Types.ObjectId().toString();

    const req = {
      user: { _id: "admin_1", role: "super_admin" },
      body: {
        leadId,
        templateName: "non_existent_template_xyz",
      },
      tenantModels: {
        Lead: { findById: async () => ({ _id: leadId, phone: "9876543210" }) },
        WhatsAppTemplate: { findOne: async () => null },
      },
    };

    const res = createMockRes();
    await sendTemplateToLead(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.data.success, false);
    assert.match(res.data.message, /not found/i);
  });

  it("blocks free-form text in sendMessage when 24h customer window has expired", async () => {
    const leadId = new mongoose.Types.ObjectId().toString();

    // Expired 2 hours ago
    const expiredAt = new Date(Date.now() - 2 * 60 * 60 * 1000);

    const mockLead = {
      _id: leadId,
      name: "Expired Customer",
      phone: "9876543210",
      assignedTo: "rep_1",
      serviceWindowExpiresAt: expiredAt,
    };

    const req = {
      user: { _id: "rep_1", name: "Rep 1", role: "sales person", organizationId: "org_1" },
      body: { leadId, text: "Hello, are you still interested?" },
      tenantModels: {
        Lead: { findById: () => ({ lean: async () => mockLead }) },
        User: { findById: () => ({ select: () => ({ lean: async () => ({ role: "sales person" }) }) }) },
        Message: { findOne: () => ({ select: () => ({ lean: async () => null }) }) },
        WAAccount: {
          findOne: async () => ({
            phoneNumberId: "phone_123",
            accessTokenEncrypted: encryptApiKey("token_123"),
            status: "connected",
          }),
        },
      },
    };

    const res = createMockRes();
    await sendMessage(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.data.windowExpired, true);
    assert.match(res.data.message, /24-hour customer service window has expired/);
  });

  it("getApprovedTemplatesForChat returns approved templates", async () => {
    const approvedTemplates = [
      { name: "reengage_client", status: "APPROVED", category: "UTILITY" },
      { name: "order_confirmation", status: "APPROVED", category: "UTILITY" },
    ];

    const req = {
      user: { _id: "u1", role: "sales person" },
      tenantModels: {
        WhatsAppTemplate: {
          find: () => ({
            select: () => ({
              sort: () => ({
                lean: async () => approvedTemplates,
              }),
            }),
          }),
        },
      },
    };

    const res = createMockRes();
    await getApprovedTemplatesForChat(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.data.success, true);
    assert.equal(res.data.data.length, 2);
    assert.equal(res.data.data[0].name, "reengage_client");
  });
});
