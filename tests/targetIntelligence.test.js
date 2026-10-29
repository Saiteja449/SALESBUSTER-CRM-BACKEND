/* Target Intelligence feature commented out
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getQuota,
  interpretPrompt,
  searchProspects,
  importToCrm,
} from "../controllers/targetIntelligenceController.js";
import { requireSalesManagerOrOwner } from "../routes/targetIntelligenceRoutes.js";

describe("Target Intelligence Backend API Unit Tests", () => {
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

  it("returns organization search and import quota via getQuota", async () => {
    let statusCode = null;
    let jsonResponse = null;
    const req = {
      organization: {
        targetIntelligenceQuota: {
          searchesLimit: 200,
          searchesUsed: 25,
          leadsImportLimit: 1000,
          leadsImported: 110,
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
    assert.equal(jsonResponse.data.searchesLimit, 200);
    assert.equal(jsonResponse.data.searchesUsedThisMonth, 25);
  });

  it("dynamically interprets natural language prompts via interpretPrompt", async () => {
    let statusCode = null;
    let jsonResponse = null;
    const req = {
      body: { prompt: "Find manufacturing companies in Hyderabad that may need ERP software" },
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
    assert.equal(jsonResponse.data.industry, "Manufacturing");
    assert.ok(jsonResponse.data.need.includes("ERP"));
  });

  it("discovers, filters, and scores prospects dynamically via searchProspects", async () => {
    let statusCode = null;
    let jsonResponse = null;
    const req = {
      body: {
        prompt: "Textile manufacturing companies in Surat",
        city: "Surat",
        industry: "Textile & Garment Manufacturing",
        need: "Yarn Inventory Automation",
      },
      organization: {},
      tenantModels: {
        Lead: {
          find: () => ({
            select: async () => [],
          }),
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

    await searchProspects(req, res);
    assert.equal(statusCode, 200);
    assert.equal(jsonResponse.success, true);
    assert.ok(jsonResponse.data.prospects.length > 0);
    assert.equal(jsonResponse.data.prospects[0].city, "Surat");
    assert.equal(jsonResponse.data.prospects[0].industry, "Textile & Garment Manufacturing");
    assert.ok(jsonResponse.data.prospects[0].matchScore >= 80);
  });

  it("importToCrm rejects missing phone, skips duplicates, and creates valid leads", async () => {
    let savedLeads = [];
    const mockLeadModel = function (doc) {
      this._id = "lead_mock_123";
      Object.assign(this, doc);
      this.save = async () => {
        savedLeads.push(this);
        return this;
      };
    };
    mockLeadModel.findOne = async (query) => {
      // simulate existing duplicate for company "Existing Corp"
      if (query.$or?.some((c) => c.phone === "+91 40 2712 9999")) {
        return {
          _id: "lead_existing_999",
          name: "Existing Contact",
          company: "Existing Corp",
          status: "Follow Up",
          tags: ["Old Tag"],
          notes: "Initial note",
          save: async () => {},
        };
      }
      return null;
    };

    const mockUserModel = {
      findById: async (id) => (id === "user_rep_1" ? { _id: id, name: "Alice Rep" } : null),
      findOne: async () => null,
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

    const req = {
      body: {
        prospects: [
          // 1. Invalid/missing phone -> must fail
          {
            id: "p1",
            companyName: "No Phone Corp",
            decisionMaker: { name: "John Doe", phone: "XXXXX", email: "john@nophone.com" },
          },
          // 2. Duplicate prospect with skip policy -> must skip
          {
            id: "p2",
            companyName: "Existing Corp",
            decisionMaker: { name: "Existing Contact", phone: "+91 40 2712 9999", email: "dup@corp.com" },
          },
          // 3. Valid prospect -> must create
          {
            id: "p3",
            companyName: "Fresh Prospect Pvt Ltd",
            city: "Hyderabad",
            industry: "Manufacturing",
            decisionMaker: { name: "Bob New", phone: "+91 40 2712 4321", email: "bob@fresh.com" },
            matchScore: 92,
            source: "Verified MCA Directory",
          },
        ],
        assignedUserId: "user_rep_1",
        pipelineStage: "Follow-up", // tests normalization to "Follow Up"
        duplicateAction: "skip",
      },
      organization: { _id: "org_test_1" },
      tenantModels: {
        Lead: mockLeadModel,
        User: mockUserModel,
      },
    };

    await importToCrm(req, res);
    assert.equal(statusCode, 200);
    assert.equal(jsonResponse.success, true);
    assert.equal(jsonResponse.createdCount, 1);
    assert.equal(jsonResponse.skippedCount, 1);
    assert.equal(jsonResponse.failedCount, 1);

    const failed = jsonResponse.results.find((r) => r.prospectId === "p1");
    assert.equal(failed.status, "failed");
    assert.ok(failed.reason.includes("phone number"));

    const skipped = jsonResponse.results.find((r) => r.prospectId === "p2");
    assert.equal(skipped.status, "skipped");

    const created = jsonResponse.results.find((r) => r.prospectId === "p3");
    assert.equal(created.status, "created");
    assert.equal(created.assignedTo, "Alice Rep");

    assert.equal(savedLeads.length, 1);
    assert.equal(savedLeads[0].status, "Follow Up"); // normalized
    assert.equal(savedLeads[0].assignedTo, "Alice Rep");
    assert.equal(savedLeads[0].source, "Target Intelligence");
  });
});


*/
