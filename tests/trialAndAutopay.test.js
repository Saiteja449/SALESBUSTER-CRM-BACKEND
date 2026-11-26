import assert from "node:assert/strict";
import test from "node:test";
import Organization from "../models/Organization.js";
import { enforceTrialLimits, TRIAL_LIMITS } from "../middleware/trialLimitMiddleware.js";
import { handleSubscriptionWebhookEvent } from "../controllers/trialAutopayController.js";
import { setMasterModelsMock } from "../services/tenantManager.js";

const createMockRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
};

test("Organization schema includes 3-day trial and autopay fields", () => {
  assert.ok(Organization.schema.path("isTrial"));
  assert.ok(Organization.schema.path("trialEndsAt"));
  assert.ok(Organization.schema.path("autopayEnabled"));
  assert.ok(Organization.schema.path("cashfreeSubscriptionId"));
  assert.ok(Organization.schema.path("autopayStatus"));
});

test("enforceTrialLimits blocks expired 3-day trial with 403 TRIAL_EXPIRED", async () => {
  const middleware = enforceTrialLimits("leads");
  const req = {
    organization: {
      isTrial: true,
      trialEndsAt: new Date(Date.now() - 60 * 1000),
    },
  };
  const res = createMockRes();
  let nextCalled = false;

  await middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "TRIAL_EXPIRED");
});

test("enforceTrialLimits blocks leads beyond 50 during active trial", async () => {
  const middleware = enforceTrialLimits("leads");
  const req = {
    organization: {
      isTrial: true,
      trialEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
    tenantModels: {
      Lead: {
        countDocuments: async () => TRIAL_LIMITS.maxLeads,
      },
    },
  };
  const res = createMockRes();
  let nextCalled = false;

  await middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "TRIAL_LIMIT_REACHED");
});

test("handleSubscriptionWebhookEvent converts trial and activates autopay on SUBSCRIPTION_PAYMENT_SUCCESS", async () => {
  const subDoc = {
    subscriptionId: "sb_sub_123",
    organizationId: "org_123",
    planId: "monthly",
    status: "INITIALIZED",
    async save() {
      return this;
    },
  };
  let updatedOrg = null;

  setMasterModelsMock(() => ({
    CashfreeSubscription: {
      findOne: async () => subDoc,
    },
    Organization: {
      findByIdAndUpdate: async (_id, update) => {
        updatedOrg = update.$set;
        return updatedOrg;
      },
    },
  }));

  const handled = await handleSubscriptionWebhookEvent("SUBSCRIPTION_PAYMENT_SUCCESS", {
    subscription_id: "sb_sub_123",
  });

  assert.equal(handled, true);
  assert.equal(subDoc.status, "ACTIVE");
  assert.equal(updatedOrg.isTrial, false);
  assert.equal(updatedOrg.trialConverted, true);
  assert.equal(updatedOrg.autopayEnabled, true);
  assert.equal(updatedOrg.autopayStatus, "active");

  setMasterModelsMock(null);
});
