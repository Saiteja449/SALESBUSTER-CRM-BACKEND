import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  interpretPromptSchema,
  resolveProspectSchema,
  unresolveProspectSchema,
  createTargetListSchema,
} from "../schemas/targetIntelligenceSchemas.js";
import {
  getMonthlyQuotaService,
  resolveProspectCoreService,
  unresolveProspectCoreService,
  createTargetListService,
  updateTargetListService,
} from "../services/targetIntelligenceService.js";
import { NotFoundError } from "../utils/AppError.js";

describe("Target Intelligence Module - Zod Validation Schemas", () => {
  it("interpretPromptSchema requires non-empty prompt", () => {
    const valid = interpretPromptSchema.safeParse({
      body: { prompt: "Find pet clinic directors in Hyderabad" },
    });
    assert.equal(valid.success, true);

    const invalid = interpretPromptSchema.safeParse({
      body: { prompt: "" },
    });
    assert.equal(invalid.success, false);
  });

  it("resolveProspectSchema requires companyName on prospect object", () => {
    const valid = resolveProspectSchema.safeParse({
      body: {
        prospect: { companyName: "Apex Logistics", website: "https://apex.com" },
        notes: "Verified with CEO",
      },
    });
    assert.equal(valid.success, true);

    const invalid = resolveProspectSchema.safeParse({
      body: {
        prospect: { website: "https://apex.com" },
      },
    });
    assert.equal(invalid.success, false);
  });

  it("unresolveProspectSchema requires prospectKey or companyId", () => {
    const validKey = unresolveProspectSchema.safeParse({
      body: { prospectKey: "apex_logistics_apex_com" },
    });
    assert.equal(validKey.success, true);

    const validId = unresolveProspectSchema.safeParse({
      body: { companyId: "comp_123" },
    });
    assert.equal(validId.success, true);

    const invalid = unresolveProspectSchema.safeParse({
      body: {},
    });
    assert.equal(invalid.success, false);
  });

  it("createTargetListSchema requires non-empty name", () => {
    const valid = createTargetListSchema.safeParse({
      body: { name: "High Value Logistics Accounts", companyIds: ["c1", "c2"] },
    });
    assert.equal(valid.success, true);

    const invalid = createTargetListSchema.safeParse({
      body: { name: "" },
    });
    assert.equal(invalid.success, false);
  });
});

describe("Target Intelligence Module - Business Service Layer", () => {
  it("getMonthlyQuotaService calculates current month searches and reset date", async () => {
    const mockTenantModels = {
      TargetSearch: {
        countDocuments: async () => 14,
      },
    };

    const org = {
      _id: "org_alpha_1",
      targetIntelligenceQuota: {
        searchesLimit: 100,
      },
    };

    const quota = await getMonthlyQuotaService({
      tenantModels: mockTenantModels,
      organization: org,
    });

    assert.equal(quota.isConfigured, true);
    assert.equal(quota.searchesLimit, 100);
    assert.equal(quota.searchesUsedThisMonth, 14);
    assert.ok(quota.resetDate);
  });

  it("resolveProspectCoreService marks prospect as resolved with user details", async () => {
    let savedDoc = null;
    let savedResolved = null;

    const mockTenantModels = {
      TargetCompany: {
        findOneAndUpdate: async (_filter, update) => {
          savedDoc = { ...update.$set, _id: "tc_100" };
          return savedDoc;
        },
      },
      ResolvedProspect: {
        findOneAndUpdate: async (_filter, update) => {
          savedResolved = { ...update.$set };
          return savedResolved;
        },
      },
    };

    const result = await resolveProspectCoreService({
      tenantModels: mockTenantModels,
      organizationId: "org_alpha_1",
      prospect: { companyName: "Tech Corp", website: "https://techcorp.io" },
      notes: "Follow up next week",
      user: { name: "Alex Manager" },
    });

    assert.ok(result);
    assert.equal(result.isResolved, true);
    assert.equal(result.resolvedByName, "Alex Manager");
    assert.equal(savedDoc.isResolved, true);
    assert.equal(savedDoc.resolutionNotes, "Follow up next week");
  });

  it("unresolveProspectCoreService unmarks resolved prospect", async () => {
    let unresolveUpdated = false;
    let resolvedDeleted = false;

    const mockTenantModels = {
      TargetCompany: {
        updateOne: async () => {
          unresolveUpdated = true;
        },
      },
      ResolvedProspect: {
        deleteOne: async () => {
          resolvedDeleted = true;
        },
      },
    };

    const result = await unresolveProspectCoreService({
      tenantModels: mockTenantModels,
      organizationId: "org_alpha_1",
      prospectKey: "tech_corp_techcorp_io",
    });

    assert.equal(result.isResolved, false);
    assert.equal(unresolveUpdated, true);
    assert.equal(resolvedDeleted, true);
  });

  it("createTargetListService and updateTargetListService manage list members", async () => {
    let createdList = null;
    const existingListDoc = {
      _id: "list_1",
      name: "Old Name",
      description: "Old Desc",
      companies: ["c_1"],
      save: async function () {
        return this;
      },
    };

    const mockTenantModels = {
      TargetList: {
        create: async (data) => {
          createdList = { ...data, _id: "list_1" };
          return createdList;
        },
        findOne: async (q) => (q._id === "list_1" ? existingListDoc : null),
      },
    };

    const created = await createTargetListService({
      tenantModels: mockTenantModels,
      organizationId: "org_alpha_1",
      user: { id: "u_1" },
      data: { name: "Tier 1 Accounts", companyIds: ["c_1"] },
    });

    assert.ok(created);
    assert.equal(created.name, "Tier 1 Accounts");

    const updated = await updateTargetListService({
      tenantModels: mockTenantModels,
      organizationId: "org_alpha_1",
      listId: "list_1",
      data: { name: "Updated Tier 1", addCompanyId: "c_2" },
    });

    assert.equal(updated.name, "Updated Tier 1");
    assert.ok(updated.companies.includes("c_2"));
  });
});
