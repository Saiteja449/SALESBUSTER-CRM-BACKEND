import assert from "node:assert/strict";
import test from "node:test";
import Organization from "../models/Organization.js";
import { enforceTrialLimits, TRIAL_LIMITS } from "../middleware/trialLimitMiddleware.js";

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

test("Organization schema includes 3-day trial fields", () => {
  assert.ok(Organization.schema.path("isTrial"));
  assert.ok(Organization.schema.path("trialEndsAt"));
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
