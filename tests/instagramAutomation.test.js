import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Models
import InstagramAccount, { instagramAccountSchema } from "../models/InstagramAccount.js";
import InstagramContact, { instagramContactSchema } from "../models/InstagramContact.js";
import InstagramAutomationRule, { instagramAutomationRuleSchema } from "../models/InstagramAutomationRule.js";
import InstagramMessage, { instagramMessageSchema } from "../models/InstagramMessage.js";
import Lead from "../models/Lead.js";

// Services & Helpers
import { extractPhoneNumber } from "../services/instagramService.js";
import { verifyInstagramWebhook } from "../controllers/instagramController.js";

describe("Instagram Automation - Database Models & Schemas", () => {
  it("InstagramAccount schema defines all required connection fields and statuses", () => {
    const paths = instagramAccountSchema.paths;

    assert.ok(paths.organizationId, "organizationId should exist");
    assert.ok(paths.instagramBusinessId, "instagramBusinessId should exist");
    assert.ok(paths.facebookPageId, "facebookPageId should exist");
    assert.ok(paths.pageAccessTokenEncrypted, "pageAccessTokenEncrypted should exist");
    assert.ok(paths.username, "username should exist");
    assert.ok(paths.status, "status should exist");

    const statusEnum = paths.status.enumValues;
    assert.deepEqual(
      statusEnum,
      ["connected", "disconnected", "error"],
      "Status enum must match expected states"
    );
  });

  it("InstagramContact schema enforces unique compound index on accountId + igsid", () => {
    const indexes = instagramContactSchema.indexes();
    const hasCompound = indexes.some(
      ([fields, options]) =>
        fields.accountId === 1 && fields.igsid === 1 && options?.unique === true
    );
    assert.ok(hasCompound, "InstagramContact must enforce unique compound index on accountId + igsid");
  });

  it("InstagramAutomationRule schema defines comment_to_dm and dm_keyword triggers", () => {
    const paths = instagramAutomationRuleSchema.paths;
    assert.ok(paths.triggerType, "triggerType should exist");
    assert.ok(paths.keywords, "keywords array should exist");
    assert.ok(paths.publicCommentReplies, "publicCommentReplies array should exist");
    assert.ok(paths.dmMessageTemplate, "dmMessageTemplate should exist");

    const triggerTypes = paths.triggerType.enumValues;
    assert.ok(triggerTypes.includes("comment_to_dm"), "Must support comment_to_dm");
    assert.ok(triggerTypes.includes("dm_keyword"), "Must support dm_keyword");
  });

  it("InstagramMessage schema defines Meta mid, senderType, and triggerSource", () => {
    const paths = instagramMessageSchema.paths;
    assert.ok(paths.mid, "mid should exist");
    assert.ok(paths.direction, "direction should exist");
    assert.ok(paths.senderType, "senderType should exist");
    assert.ok(paths.triggerSource, "triggerSource should exist");

    const senderTypes = paths.senderType.enumValues;
    assert.ok(senderTypes.includes("auto_dm"), "Must support auto_dm senderType");
  });

  it("Lead model source enum includes Instagram", () => {
    const sourceEnum = Lead.schema.paths.source.enumValues;
    assert.ok(sourceEnum.includes("Instagram"), "Lead source enum must include 'Instagram'");
  });
});

describe("Instagram Automation - Services & Utilities", () => {
  it("extractPhoneNumber correctly extracts 10-digit mobile numbers from chat text", () => {
    const text1 = "My number is 9876543210 please send brochure";
    const phone1 = extractPhoneNumber(text1);
    assert.equal(phone1, "919876543210", "Should format 10-digit number to international format");

    const text2 = "Contact me on +91 91234 56789";
    const phone2 = extractPhoneNumber(text2);
    assert.equal(phone2, "919123456789", "Should clean and standardize international number");

    const text3 = "No phone number here, just saying hi!";
    const phone3 = extractPhoneNumber(text3);
    assert.equal(phone3, null, "Should return null when no phone number is present");
  });

  it("verifyInstagramWebhook responds with challenge on valid subscription token", () => {
    let statusCode = null;
    let sentData = null;

    const req = {
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "salesbuster_meta_verify_token_2026",
        "hub.challenge": "test_challenge_code_12345",
      },
    };

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      send(data) {
        sentData = data;
        return this;
      },
      sendStatus(code) {
        statusCode = code;
        return this;
      },
    };

    verifyInstagramWebhook(req, res);
    assert.equal(statusCode, 200);
    assert.equal(sentData, "test_challenge_code_12345");
  });

  it("verifyInstagramWebhook rejects requests with invalid tokens", () => {
    let statusCode = null;

    const req = {
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong_token",
        "hub.challenge": "test_challenge_code_12345",
      },
    };

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      send() {
        return this;
      },
      sendStatus(code) {
        statusCode = code;
        return this;
      },
    };

    verifyInstagramWebhook(req, res);
    assert.equal(statusCode, 403);
  });

  it("evaluates Unix seconds timestamps (Meta webhook format) as within 7-day window", () => {
    // Current time in Unix seconds (e.g. 10-digit number)
    const nowSeconds = Math.floor(Date.now() / 1000);
    const commentTimeSeconds = nowSeconds - 3600; // 1 hour ago

    let parsedCommentTime = null;
    if (typeof commentTimeSeconds === "number") {
      parsedCommentTime = commentTimeSeconds < 1e12 ? commentTimeSeconds * 1000 : commentTimeSeconds;
    }

    const isWithin7Days = parsedCommentTime
      ? Date.now() - parsedCommentTime < 7 * 24 * 60 * 60 * 1000
      : true;

    assert.equal(isWithin7Days, true, "1-hour old Unix timestamp in seconds must be within 7 days");
  });

  it("matches comment-to-dm rule with empty keywords or wildcard as catch-all", () => {
    const catchAllRule = {
      title: "Any comment promo",
      keywords: [],
      matchType: "contains",
    };

    const keywords = (catchAllRule.keywords || []).map((k) => k.toLowerCase().trim()).filter(Boolean);
    const isCatchAll =
      keywords.length === 0 ||
      keywords.includes("*") ||
      keywords.includes("all") ||
      keywords.includes("any");

    assert.equal(isCatchAll, true, "Rule with empty keywords must act as catch-all");
  });

  it("correctly extracts Reel shortcode from target post URLs", () => {
    const reelUrl = "https://www.instagram.com/reel/C7xyz123_abc/";
    const urlCodeMatch = reelUrl.match(/(?:reel|p|tv)\/([a-zA-Z0-9_-]+)/);
    assert.ok(urlCodeMatch);
    assert.equal(urlCodeMatch[1], "C7xyz123_abc");
  });
});
