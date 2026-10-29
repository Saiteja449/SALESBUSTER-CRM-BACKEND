import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { requireAddon } from "../middleware/addonMiddleware.js";

describe("Organization Add-on Middleware", () => {
  it("allows super_admin role to bypass add-on restrictions", async () => {
    const middleware = requireAddon("whatsappCampaigns");
    const req = {
      user: { role: "super_admin" },
      organization: { addons: { whatsappCampaigns: false } },
    };
    let nextCalled = false;
    const res = {};
    const next = () => {
      nextCalled = true;
    };

    await middleware(req, res, next);
    assert.equal(nextCalled, true);
  });

  it("blocks request with 403 if whatsappCampaigns add-on is disabled", async () => {
    const middleware = requireAddon("whatsappCampaigns");
    let statusCode = null;
    let jsonResponse = null;

    const req = {
      user: { role: "sales manager" },
      organization: {
        name: "Test Org",
        addons: { whatsappCampaigns: false },
      },
    };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonResponse = data;
        return this;
      },
    };
    const next = () => {
      assert.fail("next() should not be called when addon is disabled");
    };

    await middleware(req, res, next);
    assert.equal(statusCode, 403);
    assert.equal(jsonResponse.success, false);
    assert.equal(jsonResponse.addonRequired, "whatsappCampaigns");
    assert.ok(jsonResponse.message.includes("WhatsApp Campaigns"));
  });

  it("allows request when whatsappCampaigns add-on is enabled", async () => {
    const middleware = requireAddon("whatsappCampaigns");
    const req = {
      user: { role: "sales manager" },
      organization: {
        name: "Test Org",
        addons: { whatsappCampaigns: true },
      },
    };
    let nextCalled = false;
    const res = {};
    const next = () => {
      nextCalled = true;
    };

    await middleware(req, res, next);
    assert.equal(nextCalled, true);
  });

  it("blocks request with 403 if biAnalyst add-on is disabled", async () => {
    const middleware = requireAddon("biAnalyst");
    let statusCode = null;
    let jsonResponse = null;

    const req = {
      user: { role: "sales manager" },
      organization: {
        name: "Test Org",
        addons: { biAnalyst: false },
      },
    };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonResponse = data;
        return this;
      },
    };
    const next = () => {
      assert.fail("next() should not be called when addon is disabled");
    };

    await middleware(req, res, next);
    assert.equal(statusCode, 403);
    assert.equal(jsonResponse.success, false);
    assert.equal(jsonResponse.addonRequired, "biAnalyst");
    assert.ok(jsonResponse.message.includes("BI Analyst"));
  });

  it("allows request when biAnalyst add-on is enabled", async () => {
    const middleware = requireAddon("biAnalyst");
    const req = {
      user: { role: "sales manager" },
      organization: {
        name: "Test Org",
        addons: { biAnalyst: true },
      },
    };
    let nextCalled = false;
    const res = {};
    const next = () => {
      nextCalled = true;
    };

    await middleware(req, res, next);
    assert.equal(nextCalled, true);
  });

  /* Target Intelligence feature commented out
  it("blocks request with 403 if targetIntelligence add-on is disabled", async () => {
    const middleware = requireAddon("targetIntelligence");
    let statusCode = null;
    let jsonResponse = null;

    const req = {
      user: { role: "sales manager" },
      organization: {
        name: "Test Org",
        addons: { targetIntelligence: false },
      },
    };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonResponse = data;
        return this;
      },
    };
    const next = () => {
      assert.fail("next() should not be called when addon is disabled");
    };

    await middleware(req, res, next);
    assert.equal(statusCode, 403);
    assert.equal(jsonResponse.success, false);
    assert.equal(jsonResponse.addonRequired, "targetIntelligence");
    assert.ok(jsonResponse.message.includes("AI Target Intelligence"));
  });

  it("allows request when targetIntelligence add-on is enabled", async () => {
    const middleware = requireAddon("targetIntelligence");
    const req = {
      user: { role: "sales manager" },
      organization: {
        name: "Test Org",
        addons: { targetIntelligence: true },
      },
    };
    let nextCalled = false;
    const res = {};
    const next = () => {
      nextCalled = true;
    };

    await middleware(req, res, next);
    assert.equal(nextCalled, true);
  });
  */

  it("blocks request with 403 if organization context cannot be resolved", async () => {
    const middleware = requireAddon("whatsappCampaigns");
    let statusCode = null;
    let jsonResponse = null;

    const req = {
      user: { role: "sales manager" },
      organization: null,
      tenantDbName: null,
      tenantModels: null,
    };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonResponse = data;
        return this;
      },
    };
    const next = () => {
      assert.fail("next() should not be called when org is missing");
    };

    await middleware(req, res, next);
    assert.equal(statusCode, 403);
    assert.equal(jsonResponse.success, false);
    assert.ok(jsonResponse.message.includes("Organization context"));
  });
});
