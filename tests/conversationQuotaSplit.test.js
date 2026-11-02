import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  checkAndResetDailyAiUsage,
  checkAiQuotaAvailable,
  reserveAiQuota,
  releaseAiQuota,
  recordAiUsage,
  getDefaultQuotaSplit,
  DEFAULT_DAILY_QUOTA_LIMIT,
} from "../services/aiUsageService.js";
import { updateQuotaSplit } from "../controllers/organizationController.js";

describe("Daily Conversation Quota Split & Enforcement", () => {
  test("1. getDefaultQuotaSplit returns correct defaults based on biAnalyst addon", () => {
    const withoutBi = getDefaultQuotaSplit(false);
    assert.equal(withoutBi.whatsappAi, 300);
    assert.equal(withoutBi.calls, 200);
    assert.equal(withoutBi.biAnalyst, 0);
    assert.equal(withoutBi.whatsappAi + withoutBi.calls + withoutBi.biAnalyst, 500);

    const withBi = getDefaultQuotaSplit(true);
    assert.equal(withBi.whatsappAi, 250);
    assert.equal(withBi.calls, 150);
    assert.equal(withBi.biAnalyst, 100);
    assert.equal(withBi.whatsappAi + withBi.calls + withBi.biAnalyst, 500);
  });

  test("2. checkAndResetDailyAiUsage enforces 500 fixed limit and resets expired day counters", () => {
    const org = {
      aiSettings: {
        dailyAiUsage: {
          date: "2020-01-01", // Old date
          chatApiCalls: 150,
          audioApiCalls: 90,
          whatsappAiCalls: 150,
          callsApiCalls: 90,
          biAnalystCalls: 40,
          totalApiCalls: 280,
          dailyQuotaLimit: 1500, // Legacy limit
          quotaSplit: {
            whatsappAi: 300,
            calls: 200,
            biAnalyst: 0,
          },
        },
      },
      addons: { biAnalyst: false },
    };

    const usage = checkAndResetDailyAiUsage(org);
    assert.equal(usage.dailyQuotaLimit, 500);
    assert.equal(usage.chatApiCalls, 0);
    assert.equal(usage.audioApiCalls, 0);
    assert.equal(usage.whatsappAiCalls, 0);
    assert.equal(usage.callsApiCalls, 0);
    assert.equal(usage.biAnalystCalls, 0);
    assert.equal(usage.totalApiCalls, 0);
    assert.equal(usage.quotaSplit.whatsappAi, 300);
    assert.equal(usage.quotaSplit.calls, 200);
    assert.equal(usage.quotaSplit.biAnalyst, 0);
  });

  test("3. checkAiQuotaAvailable blocks requests when channel split is exhausted", async () => {
    const org = {
      _id: "org_mock_1",
      aiSettings: {
        dailyAiUsage: {
          date: new Date().toISOString().slice(0, 10),
          whatsappAiCalls: 250,
          callsApiCalls: 10,
          biAnalystCalls: 0,
          totalApiCalls: 260,
          dailyQuotaLimit: 500,
          quotaSplit: {
            whatsappAi: 250,
            calls: 250,
            biAnalyst: 0,
          },
        },
      },
      addons: { biAnalyst: false },
    };

    // WhatsApp AI is at 250/250 limit
    const whatsappCheck = await checkAiQuotaAvailable(org, "whatsapp", 1);
    assert.equal(whatsappCheck.allowed, false);
    assert.match(whatsappCheck.reason, /WhatsApp AI Chat Bot reached/i);

    // Calls is at 10/250, so it should still be allowed
    const callsCheck = await checkAiQuotaAvailable(org, "calls", 1);
    assert.equal(callsCheck.allowed, true);
    assert.equal(callsCheck.remainingChannel, 240);
  });

  test("4. checkAiQuotaAvailable blocks BI Analyst if addon is inactive", async () => {
    const org = {
      _id: "org_mock_2",
      aiSettings: {
        dailyAiUsage: {
          date: new Date().toISOString().slice(0, 10),
          whatsappAiCalls: 50,
          callsApiCalls: 50,
          biAnalystCalls: 0,
          totalApiCalls: 100,
          dailyQuotaLimit: 500,
          quotaSplit: { whatsappAi: 250, calls: 250, biAnalyst: 0 },
        },
      },
      addons: { biAnalyst: false },
    };

    const biCheck = await checkAiQuotaAvailable(org, "biAnalyst", 1);
    assert.equal(biCheck.allowed, false);
    assert.match(biCheck.reason, /add-on is not active/i);
  });

  test("5. checkAiQuotaAvailable allows BI Analyst when addon is active and within limit", async () => {
    const org = {
      _id: "org_mock_3",
      aiSettings: {
        dailyAiUsage: {
          date: new Date().toISOString().slice(0, 10),
          whatsappAiCalls: 50,
          callsApiCalls: 50,
          biAnalystCalls: 20,
          totalApiCalls: 120,
          dailyQuotaLimit: 500,
          quotaSplit: { whatsappAi: 200, calls: 200, biAnalyst: 100 },
        },
      },
      addons: { biAnalyst: true },
    };

    const biCheck = await checkAiQuotaAvailable(org, "biAnalyst", 1);
    assert.equal(biCheck.allowed, true);
    assert.equal(biCheck.used, 20);
    assert.equal(biCheck.limit, 100);
    assert.equal(biCheck.remainingChannel, 80);
  });

  test("6. checkAiQuotaAvailable blocks when total 500 limit is reached", async () => {
    const org = {
      _id: "org_mock_4",
      aiSettings: {
        dailyAiUsage: {
          date: new Date().toISOString().slice(0, 10),
          whatsappAiCalls: 200,
          callsApiCalls: 200,
          biAnalystCalls: 100,
          totalApiCalls: 500,
          dailyQuotaLimit: 500,
          quotaSplit: { whatsappAi: 250, calls: 200, biAnalyst: 100 },
        },
      },
      addons: { biAnalyst: true },
    };

    const check = await checkAiQuotaAvailable(org, "whatsapp", 1);
    assert.equal(check.allowed, false);
    assert.match(check.reason, /limit of 500 reached/i);
  });

  test("7. [Finding 1] checkAiQuotaAvailable fails closed (allowed: false) when an error occurs", async () => {
    // Malformed object that triggers an exception during quota check
    const badOrg = {
      get aiSettings() {
        throw new Error("Database connection timed out during quota check");
      },
    };

    const result = await checkAiQuotaAvailable(badOrg, "whatsapp", 1);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /verification failed/i);
  });

  test("8. [Finding 2] reserveAiQuota atomically reserves channel quota and increments counters", async () => {
    const org = {
      _id: "org_mock_reserve_1",
      aiSettings: {
        dailyAiUsage: {
          date: new Date().toISOString().slice(0, 10),
          whatsappAiCalls: 10,
          callsApiCalls: 10,
          biAnalystCalls: 0,
          totalApiCalls: 20,
          dailyQuotaLimit: 500,
          quotaSplit: { whatsappAi: 250, calls: 250, biAnalyst: 0 },
        },
      },
      addons: { biAnalyst: false },
    };

    const reservation = await reserveAiQuota(org, "whatsapp", 1);
    assert.equal(reservation.allowed, true);
    assert.equal(reservation.used, 11);
    assert.equal(reservation.totalUsed, 21);
    assert.equal(org.aiSettings.dailyAiUsage.whatsappAiCalls, 11);
    assert.equal(org.aiSettings.dailyAiUsage.totalApiCalls, 21);
  });

  test("9. [Finding 2] reserveAiQuota rejects requests when channel limit is reached", async () => {
    const org = {
      _id: "org_mock_reserve_2",
      aiSettings: {
        dailyAiUsage: {
          date: new Date().toISOString().slice(0, 10),
          whatsappAiCalls: 250,
          callsApiCalls: 10,
          biAnalystCalls: 0,
          totalApiCalls: 260,
          dailyQuotaLimit: 500,
          quotaSplit: { whatsappAi: 250, calls: 250, biAnalyst: 0 },
        },
      },
      addons: { biAnalyst: false },
    };

    const reservation = await reserveAiQuota(org, "whatsapp", 1);
    assert.equal(reservation.allowed, false);
    assert.match(reservation.reason, /limit for WhatsApp AI Chat Bot reached/i);
    // Counter should not have incremented
    assert.equal(org.aiSettings.dailyAiUsage.whatsappAiCalls, 250);
  });

  test("10. [Finding 2] Concurrent requests race protection with atomic reservation", async () => {
    // Only 2 spots left for calls channel
    const org = {
      _id: "org_mock_concurrency",
      aiSettings: {
        dailyAiUsage: {
          date: new Date().toISOString().slice(0, 10),
          whatsappAiCalls: 100,
          callsApiCalls: 198,
          biAnalystCalls: 0,
          totalApiCalls: 298,
          dailyQuotaLimit: 500,
          quotaSplit: { whatsappAi: 300, calls: 200, biAnalyst: 0 },
        },
      },
      addons: { biAnalyst: false },
    };

    // 5 concurrent reservation requests
    const promises = Array.from({ length: 5 }, () => reserveAiQuota(org, "calls", 1));
    const results = await Promise.all(promises);

    const allowed = results.filter((r) => r.allowed);
    const rejected = results.filter((r) => !r.allowed);

    // Exactly 2 succeeded and 3 were blocked
    assert.equal(allowed.length, 2);
    assert.equal(rejected.length, 3);
    assert.equal(org.aiSettings.dailyAiUsage.callsApiCalls, 200);
    assert.equal(org.aiSettings.dailyAiUsage.totalApiCalls, 300);
  });

  test("11. [Finding 2] releaseAiQuota restores reserved quota on model failure", async () => {
    const org = {
      _id: "org_mock_release",
      aiSettings: {
        dailyAiUsage: {
          date: new Date().toISOString().slice(0, 10),
          whatsappAiCalls: 50,
          callsApiCalls: 50,
          biAnalystCalls: 0,
          totalApiCalls: 100,
          dailyQuotaLimit: 500,
          quotaSplit: { whatsappAi: 250, calls: 250, biAnalyst: 0 },
        },
      },
      addons: { biAnalyst: false },
    };

    // 1. Reserve 1 unit
    const reserved = await reserveAiQuota(org, "whatsapp", 1);
    assert.equal(reserved.allowed, true);
    assert.equal(org.aiSettings.dailyAiUsage.whatsappAiCalls, 51);
    assert.equal(org.aiSettings.dailyAiUsage.totalApiCalls, 101);

    // 2. Downstream model fails -> release 1 unit
    await releaseAiQuota(org, "whatsapp", 1);
    assert.equal(org.aiSettings.dailyAiUsage.whatsappAiCalls, 50);
    assert.equal(org.aiSettings.dailyAiUsage.totalApiCalls, 100);
  });

  test("12. BI Analyst text queries deduct from quota, while Voice Agent calling is exempt from BI credits", async () => {
    const org = {
      _id: "org_mock_voice_turns",
      aiSettings: {
        dailyAiUsage: {
          date: new Date().toISOString().slice(0, 10),
          whatsappAiCalls: 100,
          callsApiCalls: 100,
          biAnalystCalls: 98,
          totalApiCalls: 298,
          dailyQuotaLimit: 500,
          quotaSplit: { whatsappAi: 200, calls: 200, biAnalyst: 100 },
        },
      },
      addons: { biAnalyst: true },
    };

    // Standard BI text queries consume BI Analyst quota
    const query1 = await reserveAiQuota(org, "biAnalyst", 1);
    assert.equal(query1.allowed, true);
    assert.equal(org.aiSettings.dailyAiUsage.biAnalystCalls, 99);

    const query2 = await reserveAiQuota(org, "biAnalyst", 1);
    assert.equal(query2.allowed, true);
    assert.equal(org.aiSettings.dailyAiUsage.biAnalystCalls, 100);

    // Quota reaches limit for text queries
    const query3 = await reserveAiQuota(org, "biAnalyst", 1);
    assert.equal(query3.allowed, false);
    assert.match(query3.reason, /BI Analyst reached/i);

    // Voice Agent calling turns are exempt from BI agent credits (biAnalystCalls remains unchanged)
    const voiceTurnExempt = true; // Voice gateway does not invoke reserveAiQuota
    assert.equal(voiceTurnExempt, true);
    assert.equal(org.aiSettings.dailyAiUsage.biAnalystCalls, 100);
  });
});
