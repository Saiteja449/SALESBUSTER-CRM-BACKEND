import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getTenantScope } from "../utils/tenantScope.js";
import { sendSuccess, sendPaginated } from "../utils/responseHandler.js";
import {
  checkDuplicateLead,
  resolveLeadAssignment,
  createLeadCoreService,
} from "../services/leadService.js";
import { createLeadSchema, updateLeadSchema } from "../schemas/leadSchemas.js";
import { ConflictError, ForbiddenError } from "../utils/AppError.js";

describe("Module Architecture - Tenant Scope & Response Handlers", () => {
  it("getTenantScope extracts models, user role flags and org ID accurately", () => {
    const mockReq = {
      organization: { _id: "org_alpha_123", tenantDbName: "sb_tenant_alpha_123" },
      user: { _id: "user_sales_1", role: "sales person", name: "David" },
      userTokenData: { organizationId: "org_alpha_123", role: "sales person" },
    };

    const scope = getTenantScope(mockReq);
    assert.equal(scope.organizationId, "org_alpha_123");
    assert.equal(scope.tenantDbName, "sb_tenant_alpha_123");
    assert.equal(scope.userId, "user_sales_1");
    assert.equal(scope.isSalesPerson, true);
    assert.equal(scope.isManager, false);
    assert.equal(scope.isSuperAdmin, false);
    assert.ok(scope.tenantModels);
  });

  it("sendSuccess and sendPaginated output standardized response envelopes", () => {
    let successStatus = null;
    let successBody = null;
    const res1 = {
      status(code) {
        successStatus = code;
        return this;
      },
      json(data) {
        successBody = data;
      },
    };

    sendSuccess(res1, { statusCode: 201, data: { leadId: "123" }, message: "Lead created" });
    assert.equal(successStatus, 201);
    assert.equal(successBody.success, true);
    assert.equal(successBody.data.leadId, "123");
    assert.equal(successBody.message, "Lead created");

    let paginatedStatus = null;
    let paginatedBody = null;
    const res2 = {
      status(code) {
        paginatedStatus = code;
        return this;
      },
      json(data) {
        paginatedBody = data;
      },
    };

    sendPaginated(res2, {
      data: [{ id: 1 }, { id: 2 }],
      total: 25,
      page: 2,
      limit: 10,
    });

    assert.equal(paginatedStatus, 200);
    assert.equal(paginatedBody.success, true);
    assert.equal(paginatedBody.data.length, 2);
    assert.equal(paginatedBody.pagination.total, 25);
    assert.equal(paginatedBody.pagination.page, 2);
    assert.equal(paginatedBody.pagination.totalPages, 3);
    assert.equal(paginatedBody.pagination.hasNext, true);
    assert.equal(paginatedBody.pagination.hasPrev, true);
  });
});

describe("Module Architecture - Lead Service & Validation Schemas", () => {
  it("createLeadSchema accepts valid lead and enforces at least 10 digit phone", () => {
    const valid = createLeadSchema.safeParse({
      body: {
        name: "Acme Corp",
        phone: "9876543210",
        service: "Enterprise Demo",
      },
    });
    assert.equal(valid.success, true);

    const invalid = createLeadSchema.safeParse({
      body: {
        name: "Acme Corp",
        phone: "12345", // too short
      },
    });
    assert.equal(invalid.success, false);
  });

  it("checkDuplicateLead detects matching phone numbers and formatted emails", async () => {
    const existing = { _id: "lead_100", name: "Existing Lead", phone: "9876543210", email: "test@example.com" };

    const mockLeadModel = {
      findOne: (query) => {
        const matches = query.$or.some(
          (c) =>
            c.phone === "9876543210" ||
            c.phoneNormalized === "919876543210" ||
            c.email === "test@example.com"
        );
        return {
          lean: () => Promise.resolve(matches ? existing : null),
        };
      },
    };

    const dupResult = await checkDuplicateLead({
      LeadModel: mockLeadModel,
      phone: "9876543210",
    });

    assert.equal(dupResult.isDuplicate, true);
    assert.equal(dupResult.duplicateLead._id, "lead_100");

    const nonDup = await checkDuplicateLead({
      LeadModel: mockLeadModel,
      phone: "9111111111",
      email: "clean@domain.com",
    });
    assert.equal(nonDup.isDuplicate, false);
  });

  it("resolveLeadAssignment auto-assigns to creator if creator is sales person", async () => {
    const creatorUser = { _id: "rep_john", role: "sales person", name: "John Rep" };
    const result = await resolveLeadAssignment({
      UserModel: {},
      AssignmentStateModel: {},
      requestedAssignedTo: "Unassigned",
      creatorUser,
    });

    assert.equal(result.assignedTo, "rep_john");
    assert.equal(result.assignedRepName, "John Rep");
  });

  it("createLeadCoreService creates lead, dispatches notification and emits socket event", async () => {
    let createdLead = null;
    let createdNotification = null;
    const socketEvents = [];

    const mockReps = [{ _id: "rep_101", name: "Emma", role: "sales person" }];
    let state = { key: "leadAssignment", lastAssignedIndex: -1, save: async () => {} };

    const mockTenantModels = {
      Lead: {
        findOne: () => ({ lean: () => Promise.resolve(null) }),
        create: async (data) => {
          createdLead = { ...data, _id: "lead_gen_99" };
          return createdLead;
        },
      },
      User: {
        find: () => ({ sort: () => Promise.resolve(mockReps) }),
      },
      AssignmentState: {
        findOne: async () => state,
        create: async (data) => {
          state = { ...data, save: async () => {} };
          return state;
        },
      },
      Notification: {
        create: async (notif) => {
          createdNotification = notif;
          return notif;
        },
      },
    };

    const mockIo = {
      to: (room) => ({
        emit: (event, payload) => {
          socketEvents.push({ room, event, payload });
        },
      }),
    };

    const { lead, assignedRepName } = await createLeadCoreService({
      tenantModels: mockTenantModels,
      leadData: {
        name: "Test Prospect",
        phone: "9988776655",
        service: "Premium Plan",
      },
      creatorUser: { role: "admin", organizationId: "org_beta_1" },
      organization: { _id: "org_beta_1" },
      io: mockIo,
      checkDuplicate: false,
    });

    assert.ok(lead);
    assert.equal(lead.name, "Test Prospect");
    assert.equal(assignedRepName, "Emma");
    assert.equal(lead.assignedTo, "rep_101");

    assert.ok(createdNotification);
    assert.deepEqual(createdNotification.targetUsers, ["rep_101"]);

    assert.ok(socketEvents.some((s) => s.event === "new_lead" && s.room === "org_org_beta_1"));
    assert.ok(socketEvents.some((s) => s.event === "whatsapp_new_lead" && s.room === "org_org_beta_1"));
  });

  it("createLeadCoreService throws ForbiddenError when organization subscription has expired", async () => {
    const expiredOrg = {
      _id: "org_expired",
      subscriptionEndDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    };

    await assert.rejects(
      async () => {
        await createLeadCoreService({
          tenantModels: {},
          leadData: { phone: "9876543210" },
          organization: expiredOrg,
        });
      },
      (err) => err instanceof ForbiddenError
    );
  });
});

describe("Background Task Manager & Worker Lifecycle", () => {
  it("getBackgroundWorkersStatus reports correct initial and worker registry shape", async () => {
    const { getBackgroundWorkersStatus } = await import("../services/backgroundTaskManager.js");
    const status = getBackgroundWorkersStatus();

    assert.ok(typeof status.enabled === "boolean");
    assert.ok(typeof status.isRunning === "boolean");
    assert.ok(typeof status.workers === "object");
    assert.ok("whatsappConnections" in status.workers);
    assert.ok("campaignScheduler" in status.workers);
    assert.ok("webhookRetry" in status.workers);
    assert.ok("instagramWatcher" in status.workers);
  });
});

describe("Instagram Auto-Assignment Integration", () => {
  it("autoAssignLead seamlessly assigns round-robin reps from tenant User model", async () => {
    const { autoAssignLead } = await import("../services/instagramService.js");

    const mockReps = [
      { _id: "rep_a", name: "Alice", role: "sales person" },
      { _id: "rep_b", name: "Bob", role: "sales person" },
    ];
    let state = { key: "leadAssignment", lastAssignedIndex: -1, save: async () => {} };

    const mockTenantModels = {
      User: {
        find: () => ({ sort: () => Promise.resolve(mockReps) }),
      },
      AssignmentState: {
        findOne: async () => state,
        create: async (data) => {
          state = { ...data, save: async () => {} };
          return state;
        },
      },
    };

    const first = await autoAssignLead({ tenantModels: mockTenantModels });
    assert.equal(first.assignedTo, "rep_a");
    assert.equal(first.assignedRepName, "Alice");

    const second = await autoAssignLead({ tenantModels: mockTenantModels });
    assert.equal(second.assignedTo, "rep_b");
    assert.equal(second.assignedRepName, "Bob");
  });
});
