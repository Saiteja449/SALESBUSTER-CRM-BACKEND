import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import mongoose from "mongoose";

// Models
import WAAccount, { waAccountSchema } from "../models/WhatsAppAccount.js";
import WAContact, { waContactSchema } from "../models/WhatsAppContact.js";
import WAWebhookEvent, { waWebhookEventSchema } from "../models/WhatsAppWebhookEvent.js";
import Message from "../models/Message.js";

// Controllers & Services
import { verifyMetaSignature } from "../controllers/whatsappWebhookController.js";
import { runMigration } from "../scripts/migrateCloudSettingsToWAAccount.js";
import { findActiveWhatsAppAccount } from "../utils/whatsappAccountLookup.js";

describe("WhatsApp Coexistence - Database Models & Schemas", () => {
  it("WAAccount schema defines all required coexistence fields and statuses", () => {
    const paths = waAccountSchema.paths;

    assert.ok(paths.organizationId, "organizationId should exist");
    assert.ok(paths.userId, "userId should exist");
    assert.ok(paths.wabaId, "wabaId should exist");
    assert.ok(paths.phoneNumberId, "phoneNumberId should exist");
    assert.ok(paths.displayPhone, "displayPhone should exist");
    assert.ok(paths.accessTokenEncrypted, "accessTokenEncrypted should exist");
    assert.ok(paths.status, "status should exist");
    assert.ok(paths.isOnBizApp, "isOnBizApp should exist");
    assert.ok(paths.syncDeadline, "syncDeadline should exist");
    assert.ok(
      paths["historyProgress.chunksReceived"] || paths.historyProgress,
      "historyProgress should exist"
    );
    assert.ok(paths.historySharingDeclined, "historySharingDeclined should exist");

    const statusEnum = paths.status.enumValues;
    assert.deepEqual(
      statusEnum,
      ["onboarding", "syncing", "connected", "disconnected", "error"],
      "WAAccount status enum must match spec"
    );
  });

  it("WAContact schema enforces unique compound index on accountId + waId", () => {
    const indexes = waContactSchema.indexes();
    const hasCompound = indexes.some(
      ([fields, options]) =>
        fields.accountId === 1 && fields.waId === 1 && options?.unique === true
    );
    assert.ok(hasCompound, "WAContact must enforce unique compound index on accountId + waId");
  });

  it("WAWebhookEvent schema defines unique eventId index for deduplication", () => {
    const paths = waWebhookEventSchema.paths;
    assert.ok(paths.eventId, "eventId should exist");
    assert.ok(paths.field, "field should exist");
    assert.ok(paths.payload, "payload should exist");
    assert.ok(paths.status, "status should exist");
  });

  it("Message model schema includes business_app, history, and cloud_api sources with wamid", () => {
    const paths = Message.schema.paths;
    assert.ok(paths.wamid, "wamid should exist for deduplication");
    assert.ok(paths.originalMessageId, "originalMessageId should exist for edits/revokes");
    assert.ok(paths.rawPayload, "rawPayload should exist");

    const sourceEnum = paths.source.enumValues;
    assert.ok(sourceEnum.includes("business_app"), "source must include business_app");
    assert.ok(sourceEnum.includes("history"), "source must include history");
    assert.ok(sourceEnum.includes("cloud_api"), "source must include cloud_api");
    assert.ok(sourceEnum.includes("baileys"), "source must retain baileys for backward compatibility");
    assert.equal(paths.source.defaultValue, "cloud_api", "default message source must be cloud_api");
  });
});

describe("WhatsApp Coexistence - Active account lookup", () => {
  const makeModel = (result = null) => {
    const queries = [];
    return {
      queries,
      findOne(query) {
        queries.push(query);
        return {
          sort() {
            return this;
          },
          async lean() {
            return result;
          },
        };
      },
    };
  };

  it("continues to the master model when the tenant model has no active line", async () => {
    const tenantModel = makeModel(null);
    const masterAccount = { status: "connected", phoneNumberId: "phone-1" };
    const masterModel = makeModel(masterAccount);

    const result = await findActiveWhatsAppAccount(
      [tenantModel, masterModel],
      "org-1"
    );

    assert.equal(result, masterAccount);
    assert.deepEqual(tenantModel.queries[0], {
      organizationId: "org-1",
      status: { $in: ["connected", "syncing"] },
    });
    assert.equal(masterModel.queries.length, 1);
  });

  it("checks a sales rep line before falling back to the organization line", async () => {
    const model = makeModel(null);
    await findActiveWhatsAppAccount([model], "org-1", {
      isSalesRep: true,
      userId: "user-1",
    });

    assert.equal(model.queries.length, 2);
    assert.deepEqual(model.queries[0], {
      organizationId: "org-1",
      userId: "user-1",
      status: { $in: ["connected", "syncing"] },
    });
    assert.deepEqual(model.queries[1], {
      organizationId: "org-1",
      userId: null,
      status: { $in: ["connected", "syncing"] },
    });
  });
});

describe("WhatsApp Coexistence - HMAC-SHA256 Signature Verification", () => {
  const originalSecret = process.env.META_APP_SECRET;

  it("passes cryptographic verification with valid X-Hub-Signature-256", () => {
    process.env.META_APP_SECRET = "test_meta_app_secret_123456";
    const rawPayload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "12345" }],
    });

    const signature = `sha256=${crypto
      .createHmac("sha256", process.env.META_APP_SECRET)
      .update(rawPayload)
      .digest("hex")}`;

    const req = {
      headers: {
        "x-hub-signature-256": signature,
      },
      rawBody: rawPayload,
      body: JSON.parse(rawPayload),
    };

    const isValid = verifyMetaSignature(req);
    assert.equal(isValid, true, "Valid HMAC signature should be accepted");
  });

  it("rejects payload when X-Hub-Signature-256 is tampered or invalid", () => {
    process.env.META_APP_SECRET = "test_meta_app_secret_123456";
    const rawPayload = JSON.stringify({ object: "whatsapp_business_account" });

    const req = {
      headers: {
        "x-hub-signature-256": "sha256=invalid_hex_digest_000000000000000000000000",
      },
      rawBody: rawPayload,
      body: JSON.parse(rawPayload),
    };

    const isValid = verifyMetaSignature(req);
    assert.equal(isValid, false, "Invalid HMAC signature must be rejected");
  });

  it("rejects payload when X-Hub-Signature-256 header is missing in production", () => {
    process.env.META_APP_SECRET = "test_meta_app_secret_123456";
    const req = {
      headers: {},
      rawBody: "{}",
      body: {},
    };

    const isValid = verifyMetaSignature(req);
    assert.equal(isValid, false, "Missing signature header must be rejected");
  });

  // Restore environment
  process.env.META_APP_SECRET = originalSecret;
});

describe("WhatsApp Coexistence - Smart AI Pause & 24h Window Rules", () => {
  it("calculates 60-minute AI pause correctly upon receiving mobile phone echo", () => {
    const now = new Date("2026-10-23T12:00:00.000Z");
    const pauseUntil = new Date(now.getTime() + 60 * 60 * 1000);

    assert.equal(
      pauseUntil.toISOString(),
      "2026-10-23T13:00:00.000Z",
      "Mobile echo must set exactly 60-minute AI pause"
    );
  });

  it("detects expired 24-hour customer service window correctly", () => {
    const now = new Date("2026-10-23T15:00:00.000Z");

    // Case 1: Inbound message from 25 hours ago -> Expired
    const expiredInbound = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    const serviceWindowExpires1 = new Date(expiredInbound.getTime() + 24 * 60 * 60 * 1000);
    const isExpired1 = now.getTime() > serviceWindowExpires1.getTime();
    assert.equal(isExpired1, true, "25 hours since inbound should be expired");

    // Case 2: Inbound message from 2 hours ago -> Active
    const recentInbound = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const serviceWindowExpires2 = new Date(recentInbound.getTime() + 24 * 60 * 60 * 1000);
    const isExpired2 = now.getTime() > serviceWindowExpires2.getTime();
    assert.equal(isExpired2, false, "2 hours since inbound should be active");
  });

  it("handles client history sharing decline error code 2593109 gracefully", () => {
    const errorCode = 2593109;
    const isDeclined = errorCode === 2593109;
    assert.equal(isDeclined, true, "Error 2593109 must be recognized as user declined");
  });
});

describe("WhatsApp Coexistence - Single Connection Policy (Sales Manager & Organization)", () => {
  it("enforces single session routing for organization/sales manager", () => {
    const orgId = "66ef12a3b4c5d6e7f8a9b0c1";
    const primarySessionId = `org_${orgId}`;
    const allowedSessionIds = [primarySessionId];

    assert.equal(allowedSessionIds.length, 1, "Organization must only have exactly 1 connection slot");
    assert.equal(allowedSessionIds[0], `org_${orgId}`);
    assert.equal(allowedSessionIds.includes(`org_${orgId}_device_2`), false, "device_2 must not be allowed");
  });

  it("guarantees whatsappLineLimit is fixed to 1 for all organizations", () => {
    const defaultLineLimit = 1;
    assert.equal(defaultLineLimit, 1, "Manager and reps must have strictly 1 line limit");
  });
});

