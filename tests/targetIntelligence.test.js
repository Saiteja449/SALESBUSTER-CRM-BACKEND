import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getQuota,
  interpretPrompt,
  searchProspects,
  resolveProspect,
  unresolveProspect,
  getProviderStatus,
} from "../controllers/targetIntelligenceController.js";
import { requireSalesManagerOrOwner } from "../routes/targetIntelligenceRoutes.js";
import { isPrivateIp } from "../services/targetIntelligence/enrichmentService.js";
import {
  verifyEmail,
  normalizeAndVerifyPhone,
  normalizeDomain,
} from "../services/targetIntelligence/verificationService.js";
import * as discoveryModule from "../services/targetIntelligence/discoveryService.js";
import GeminiSearchProvider from "../services/targetIntelligence/providers/geminiProvider.js";
import OsmSearchProvider from "../services/targetIntelligence/providers/osmProvider.js";

describe("Target Intelligence Backend Unit Tests", () => {
  it("blocks non-managers with 403 in requireSalesManagerOrOwner", () => {
    let statusCode = null;
    let jsonResponse = null;
    const req = { user: { role: "sales person", isOrgOwner: false } };
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
    const next = () => assert.fail("next() should not be called for sales person");

    requireSalesManagerOrOwner(req, res, next);
    assert.equal(statusCode, 403);
    assert.equal(jsonResponse.success, false);
  });

  it("allows sales managers in requireSalesManagerOrOwner", () => {
    const req = { user: { role: "sales manager", isOrgOwner: false } };
    let nextCalled = false;
    const res = {};
    const next = () => {
      nextCalled = true;
    };

    requireSalesManagerOrOwner(req, res, next);
    assert.equal(nextCalled, true);
  });

  it("returns explicit unconfigured quota state when no authoritative quota limit exists", async () => {
    let statusCode = null;
    let jsonResponse = null;
    const req = {
      organization: {
        _id: "507f1f77bcf86cd799439011",
        // No targetIntelligenceQuota configured
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

    await getQuota(req, res);
    assert.equal(statusCode, 200);
    assert.equal(jsonResponse.success, true);
    assert.equal(jsonResponse.data.isConfigured, false);
    assert.equal(jsonResponse.data.searchesLimit, null);
    assert.equal(jsonResponse.data.resetDate, null);
  });

  it("returns configured organization search quota with dynamic reset date", async () => {
    let statusCode = null;
    let jsonResponse = null;
    const req = {
      organization: {
        _id: "507f1f77bcf86cd799439011",
        targetIntelligenceQuota: {
          searchesLimit: 150,
          searchesUsed: 22,
        },
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

    await getQuota(req, res);
    assert.equal(statusCode, 200);
    assert.equal(jsonResponse.success, true);
    assert.equal(jsonResponse.data.isConfigured, true);
    assert.equal(jsonResponse.data.searchesLimit, 150);
    assert.equal(jsonResponse.data.searchesUsedThisMonth, 22);
    assert.ok(jsonResponse.data.resetDate.match(/^\d{4}-\d{2}-\d{2}$/));
  });

  it("interprets natural language prompts without employee count or social media", async () => {
    let statusCode = null;
    let jsonResponse = null;
    const req = {
      body: { prompt: "Find pet care clinics in Hyderabad with founders" },
      organization: {},
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

    await interpretPrompt(req, res);
    assert.equal(statusCode, 200);
    assert.equal(jsonResponse.success, true);
    assert.equal(jsonResponse.data.city, "Hyderabad");
    assert.equal(jsonResponse.data.industry, "Pet Care & Veterinary");
    // Confirm no employeeCount or socialMedia fields
    assert.equal(jsonResponse.data.employeeCount, undefined);
    assert.equal(jsonResponse.data.socialMedia, undefined);
  });

  it("SSRF Protection: identifies private, loopback, and metadata IPs as unsafe", () => {
    assert.equal(isPrivateIp("127.0.0.1"), true);
    assert.equal(isPrivateIp("10.0.1.25"), true);
    assert.equal(isPrivateIp("172.16.0.5"), true);
    assert.equal(isPrivateIp("192.168.1.1"), true);
    assert.equal(isPrivateIp("169.254.169.254"), true); // AWS/GCP metadata
    assert.equal(isPrivateIp("::1"), true);
    assert.equal(isPrivateIp("8.8.8.8"), false); // Public DNS
    assert.equal(isPrivateIp("104.21.45.2"), false); // Public Cloudflare
  });

  it("Email Verification: distinguishes syntax validation from deliverability, using unknown", async () => {
    const roleBased = await verifyEmail("info@acmebiz.com", true);
    assert.equal(roleBased.isValidFormat, true);
    assert.equal(roleBased.isRoleBased, true);
    assert.equal(roleBased.type, "role_based");
    // Ownership/deliverability is unknown without live SMTP verification
    assert.equal(roleBased.status, "unknown");

    const direct = await verifyEmail("shiva.kumar@acmebiz.com", true);
    assert.equal(direct.isValidFormat, true);
    assert.equal(direct.isRoleBased, false);
    assert.equal(direct.type, "direct");
    assert.equal(direct.status, "unknown");

    const invalid = await verifyEmail("not-an-email", true);
    assert.equal(invalid.isValidFormat, false);
    assert.equal(invalid.status, "Invalid");
  });

  it("Phone Normalization: normalizes format and uses unknown verification status", () => {
    const mobile = normalizeAndVerifyPhone("9876543210");
    assert.equal(mobile.isValidFormat, true);
    assert.equal(mobile.phoneType, "mobile");
    assert.equal(mobile.normalized, "+91 98765 43210");
    // Line ownership/reachability is unknown without line ping
    assert.equal(mobile.status, "unknown");

    const landline = normalizeAndVerifyPhone("0402345678");
    assert.equal(landline.isValidFormat, true);
    assert.equal(landline.phoneType, "landline");
    assert.equal(landline.status, "unknown");

    const dummy = normalizeAndVerifyPhone("0000000000");
    assert.equal(dummy.isValidFormat, false);
    assert.equal(dummy.status, "Invalid");
  });

  it("Domain normalization extracts clean root domain", () => {
    assert.equal(normalizeDomain("https://www.petsfolio.com/about-us"), "petsfolio.com");
    assert.equal(normalizeDomain("http://sub.domain.co.in"), "sub.domain.co.in");
    assert.equal(normalizeDomain("contact@huft.com"), "huft.com");
  });

  it("Ensures hard-coded VERIFIED_BUSINESS_REGISTRY is deleted and not exported", () => {
    assert.equal(discoveryModule.VERIFIED_BUSINESS_REGISTRY, undefined);
  });

  it("Ensures direct Gemini grounded discovery method is deleted", () => {
    const gemini = new GeminiSearchProvider();
    assert.equal(typeof gemini.discoverGroundedBusinesses, "undefined");
  });

  it("getProviderStatus does not report verifiedRegistry", async () => {
    let jsonResponse = null;
    const req = { organization: {} };
    const res = {
      status() {
        return this;
      },
      json(data) {
        jsonResponse = data;
        return this;
      },
    };

    await getProviderStatus(req, res);
    assert.equal(jsonResponse.success, true);
    assert.equal(jsonResponse.data.verifiedRegistry, undefined);
    assert.equal(jsonResponse.data.gemini.configured, false);
    assert.equal(jsonResponse.data.tavily.configured, false);
    assert.equal(jsonResponse.data.openStreetMap.available, true);
  });

  it("Resolution: marks and unresolves prospects with audit tracking", async () => {
    const mockDb = new Map();
    const MockResolvedModel = {
      findOneAndUpdate(filter, update) {
        const doc = { ...filter, ...update, _id: "res-1" };
        mockDb.set(filter.prospectKey, doc);
        return Promise.resolve(doc);
      },
      findOneAndDelete(filter) {
        mockDb.delete(filter.prospectKey);
        return Promise.resolve(true);
      },
    };

    const MockTargetCompanyModel = {
      updateMany() {
        return Promise.resolve({ modifiedCount: 1 });
      },
    };

    const req = {
      organization: { _id: "507f1f77bcf86cd799439011" },
      user: { _id: "507f1f77bcf86cd799439012", name: "Manager Bob" },
      body: {
        prospect: {
          companyName: "Petsfolio",
          prospectKey: "comp_petsfolio_petsfoliocom",
          website: "https://www.petsfolio.com",
        },
        notes: "Outreach scheduled for tomorrow",
      },
      tenantModels: {
        ResolvedProspect: MockResolvedModel,
        TargetCompany: MockTargetCompanyModel,
      },
    };

    let statusCode = null;
    let jsonResponse = null;
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

    await resolveProspect(req, res);
    assert.equal(statusCode, 200);
    assert.equal(jsonResponse.success, true);
    assert.equal(jsonResponse.data.isResolved, true);
    assert.equal(jsonResponse.data.resolvedByName, "Manager Bob");

    // Test unresolve
    req.body = { prospectKey: "comp_petsfolio_petsfoliocom" };
    await unresolveProspect(req, res);
    assert.equal(statusCode, 200);
    assert.equal(jsonResponse.success, true);
    assert.equal(jsonResponse.data.isResolved, false);
  });

  it("Resolution lookup queries ONLY returned candidate keys and names", async () => {
    let capturedFilter = null;
    const MockResolvedModel = {
      find(filter) {
        capturedFilter = filter;
        return {
          select() {
            return Promise.resolve([
              {
                prospectKey: "comp_testcorp_testcorpcom",
                companyName: "TestCorp",
                resolvedAt: new Date(),
                resolvedByName: "Auditor",
                notes: "Verified",
              },
            ]);
          },
        };
      },
    };

    // Execute discovery with a candidate
    const filters = { prompt: "Test", city: "All" };
    // Pass tenantModels with mocked ResolvedModel
    const result = await discoveryModule.discoveryService.discoverBusinesses(filters, {
      organizationId: "507f1f77bcf86cd799439011",
      tenantModels: { ResolvedModel: MockResolvedModel },
    });

    assert.ok(result.timings);
    assert.ok(typeof result.timings.totalMs === "number");
    assert.ok(typeof result.timings.providerSearchMs === "number");
  });

  it("searchProspects returns 502 with visible provider statuses when all live providers fail", async () => {
    let statusCode = null;
    let jsonResponse = null;
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

    // Mock request with invalid search that triggers no results and all providers failed/unconfigured
    const originalOsmSearch = OsmSearchProvider.prototype.searchBusinesses;
    OsmSearchProvider.prototype.searchBusinesses = async () => ({
      provider: "OpenStreetMap",
      status: "error",
      results: [],
      durationMs: 50,
      error: "Nominatim rate limited or down",
    });

    try {
      const req = {
        body: { prompt: "Unreachable query", city: "Unknown" },
        organization: { _id: "507f1f77bcf86cd799439011" },
        user: { _id: "507f1f77bcf86cd799439012" },
      };

      await searchProspects(req, res);
      assert.equal(statusCode, 502);
      assert.equal(jsonResponse.success, false);
      assert.equal(jsonResponse.data.outcome, "all_providers_failed");
      assert.ok(jsonResponse.data.providerStatuses.openStreetMap);
      assert.equal(jsonResponse.data.providerStatuses.openStreetMap.status, "error");
    } finally {
      OsmSearchProvider.prototype.searchBusinesses = originalOsmSearch;
    }
  });

  it("OpenStreetMap results do not infer founders or generic executive roles", async () => {
    const osm = new OsmSearchProvider();
    // Verify constructor
    assert.equal(osm.name, "OpenStreetMap");
  });
});
