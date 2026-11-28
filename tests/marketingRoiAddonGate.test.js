import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { requireAddon } from "../middleware/addonMiddleware.js";
import { isAddonActive } from "../services/addonEntitlementService.js";
import marketingRoiRoutes from "../routes/marketingRoiRoutes.js";

const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

const createMockRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, val) {
      this.headers[name] = val;
    },
    getHeader(name) {
      return this.headers[name];
    },
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

test("isAddonActive evaluates marketing_roi entitlements and expiry dates", () => {
  assert.equal(
    isAddonActive({
      addons: { marketingRoi: false },
      addonEntitlements: [{ addonId: "marketing_roi", startsAt: pastDate, expiresAt: futureDate }],
    }, "marketingRoi"),
    true
  );

  assert.equal(
    isAddonActive({
      addons: { marketingRoi: true },
      addonEntitlements: [{ addonId: "marketing_roi", startsAt: pastDate, expiresAt: pastDate }],
    }, "marketingRoi"),
    false
  );

  assert.equal(
    isAddonActive({
      addons: { marketingRoi: false },
      addonEntitlements: [],
    }, "marketingRoi"),
    false
  );
});

test("requireAddon('marketingRoi') allows active entitlement and blocks disabled or expired", async () => {
  const mw = requireAddon("marketingRoi");

  // Enabled
  {
    const req = {
      user: { role: "sales manager" },
      organization: {
        addonEntitlements: [{ addonId: "marketing_roi", startsAt: pastDate, expiresAt: futureDate }],
      },
    };
    const res = createMockRes();
    let nextCalled = false;
    await mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  }

  // Disabled
  {
    const req = {
      user: { role: "sales manager" },
      organization: { addons: { marketingRoi: false }, addonEntitlements: [] },
    };
    const res = createMockRes();
    let nextCalled = false;
    await mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.addonRequired, "marketingRoi");
  }

  // Expired
  {
    const req = {
      user: { role: "sales manager" },
      organization: {
        addons: { marketingRoi: true },
        addonEntitlements: [{ addonId: "marketing_roi", startsAt: pastDate, expiresAt: pastDate }],
      },
    };
    const res = createMockRes();
    let nextCalled = false;
    await mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.addonRequired, "marketingRoi");
  }
});

test("every /api/marketing-roi endpoint is protected by requireAddon('marketingRoi')", async () => {
  // Verify router mounts all 7 endpoints behind protect, requireCrmAccount, requireAddon
  const routeLayers = marketingRoiRoutes.stack.filter((layer) => layer.route);
  const paths = routeLayers.map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
  assert.deepEqual(paths, [
    "GET /dashboard",
    "GET /campaigns",
    "POST /campaign",
    "PUT /campaign/:id",
    "DELETE /campaign/:id",
    "POST /sync",
    "GET /export",
  ]);

  const middlewareNames = marketingRoiRoutes.stack
    .filter((layer) => !layer.route)
    .map((layer) => layer.name);
  assert.ok(middlewareNames.includes("protect"));
  assert.ok(middlewareNames.includes("requireCrmAccount"));

  // Dispatch all 7 /api/marketing-roi routes in-memory through requireAddon('marketingRoi')
  const app = express();
  app.use((req, _res, next) => {
    req.user = { _id: "u1", role: "sales manager", organizationId: "org_1" };
    req.organization = {
      _id: "org_1",
      accountType: "crm",
      addons: { marketingRoi: false },
      addonEntitlements: [],
    };
    next();
  });
  app.use("/api/marketing-roi", requireAddon("marketingRoi"));
  app.use("/api/marketing-roi", marketingRoiRoutes);

  for (const [method, url] of [
    ["GET", "/api/marketing-roi/dashboard"],
    ["GET", "/api/marketing-roi/campaigns"],
    ["POST", "/api/marketing-roi/campaign"],
    ["PUT", "/api/marketing-roi/campaign/123"],
    ["DELETE", "/api/marketing-roi/campaign/123"],
    ["POST", "/api/marketing-roi/sync"],
    ["GET", "/api/marketing-roi/export"],
  ]) {
    const res = createMockRes();
    await new Promise((resolve) => {
      const origJson = res.json.bind(res);
      res.json = (payload) => {
        origJson(payload);
        resolve();
        return res;
      };
      const fakeReq = {
        method,
        url,
        originalUrl: url,
        headers: {},
        body: {},
        query: {},
        params: {},
      };
      app.handle(fakeReq, res, resolve);
    });
    assert.equal(res.statusCode, 403, `Expected 403 for ${method} ${url}`);
    assert.equal(res.body.addonRequired, "marketingRoi");
  }
});
