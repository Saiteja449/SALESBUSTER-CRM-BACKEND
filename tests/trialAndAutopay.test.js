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

test("enforceTrialLimits('seats') allows 2 salespeople plus owner/manager and blocks 3rd salesperson", async () => {
  const middleware = enforceTrialLimits("seats");
  const tenantUsers = [
    { _id: "u_owner", role: "sales manager", status: "active" },
  ];
  const countMatchingUsers = async (query = {}) =>
    tenantUsers.filter((u) => {
      if (query.role && u.role !== query.role) return false;
      if (query.status?.$ne && u.status === query.status.$ne) return false;
      return true;
    }).length;

  const makeReq = () => ({
    organization: {
      isTrial: true,
      seats: TRIAL_LIMITS.maxSeats,
      trialEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
    tenantModels: {
      User: {
        countDocuments: countMatchingUsers,
      },
    },
  });

  // 1st salesperson (owner + 0 salespeople -> allowed)
  {
    const res = createMockRes();
    let nextCalled = false;
    await middleware(makeReq(), res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    tenantUsers.push({ _id: "u_rep1", role: "sales person", status: "active" });
  }

  // 2nd salesperson (owner + 1 salesperson -> allowed)
  {
    const res = createMockRes();
    let nextCalled = false;
    await middleware(makeReq(), res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    tenantUsers.push({ _id: "u_rep2", role: "sales person", status: "active" });
  }

  // 3rd salesperson (owner + 2 salespeople -> blocked)
  {
    const res = createMockRes();
    let nextCalled = false;
    await middleware(makeReq(), res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, "TRIAL_LIMIT_REACHED");
  }
});
