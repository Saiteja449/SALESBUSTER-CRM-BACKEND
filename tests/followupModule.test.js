import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createFollowupSchema,
  updateFollowupSchema,
  queryFollowupsSchema,
} from "../schemas/followupSchemas.js";
import {
  queryFollowupsService,
  createFollowupService,
  updateFollowupService,
  handleAIFollowupService,
} from "../services/followupService.js";
import { NotFoundError } from "../utils/AppError.js";

describe("Follow-up Module - Zod Validation Schemas", () => {
  it("createFollowupSchema validates correct follow-up payload", () => {
    const valid = createFollowupSchema.safeParse({
      body: {
        leadId: "lead_xyz_123",
        date: "2026-11-25",
        time: "02:30 PM",
        type: "Call",
        priority: "High",
        notes: "Call client to confirm contract",
      },
    });
    assert.equal(valid.success, true);
    assert.equal(valid.data.body.priority, "High");
    assert.equal(valid.data.body.done, false);
  });

  it("createFollowupSchema rejects when leadId or date is missing", () => {
    const missingDate = createFollowupSchema.safeParse({
      body: {
        leadId: "lead_xyz_123",
      },
    });
    assert.equal(missingDate.success, false);

    const missingLead = createFollowupSchema.safeParse({
      body: {
        date: "2026-11-25",
      },
    });
    assert.equal(missingLead.success, false);
  });

  it("updateFollowupSchema accepts partial updates", () => {
    const valid = updateFollowupSchema.safeParse({
      params: { id: "followup_123" },
      body: { done: true, notes: "Client confirmed via call" },
    });
    assert.equal(valid.success, true);
  });
});

describe("Follow-up Module - Business Service Layer", () => {
  it("queryFollowupsService applies role scoping for sales representatives", async () => {
    const mockFollowups = [
      { _id: "f_1", leadId: "lead_rep_1", author: "Sarah", date: "2026-11-24", done: false },
    ];

    const mockTenantModels = {
      Lead: {
        find: () => ({
          select: () => Promise.resolve([{ _id: "lead_rep_1" }]),
        }),
      },
      Followup: {
        find: (filter) => ({
          sort: () => ({
            lean: () => Promise.resolve(mockFollowups),
          }),
        }),
      },
    };

    const results = await queryFollowupsService({
      tenantModels: mockTenantModels,
      user: { _id: "user_rep_1", role: "sales person", name: "Sarah" },
      query: { done: "false" },
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].id, "f_1");
    assert.equal(results[0].leadId, "lead_rep_1");
  });

  it("createFollowupService creates follow-up and dispatches notification", async () => {
    let createdFollowup = null;
    let createdNotification = null;

    const mockTenantModels = {
      Followup: {
        findOne: () => Promise.resolve(null),
        create: async (doc) => {
          createdFollowup = { ...doc, _id: "f_new_99" };
          return createdFollowup;
        },
      },
      Notification: {
        create: async (notif) => {
          createdNotification = notif;
          return notif;
        },
      },
      Lead: {
        findById: () => ({ lean: () => Promise.resolve({ _id: "lead_99", name: "John Doe" }) }),
      },
    };

    const result = await createFollowupService({
      tenantModels: mockTenantModels,
      data: {
        leadId: "lead_99",
        leadName: "John Doe",
        date: "2026-11-26",
        notes: "Follow-up discussion",
      },
      creatorUser: { name: "Agent Alex" },
    });

    assert.ok(result);
    assert.equal(result.leadId, "lead_99");
    assert.ok(createdNotification);
    assert.equal(createdNotification.title, "New Follow-up Scheduled");
  });

  it("updateFollowupService updates existing followup and throws NotFoundError for unknown ID", async () => {
    let saved = false;
    const existingDoc = {
      _id: "f_target",
      done: false,
      save: async function () {
        saved = true;
        return this;
      },
    };

    const mockTenantModels = {
      Followup: {
        findById: async (id) => (id === "f_target" ? existingDoc : null),
      },
    };

    const updated = await updateFollowupService({
      tenantModels: mockTenantModels,
      followupId: "f_target",
      updateData: { done: true },
    });

    assert.equal(updated.done, true);
    assert.equal(saved, true);

    await assert.rejects(
      async () => {
        await updateFollowupService({
          tenantModels: mockTenantModels,
          followupId: "f_missing",
          updateData: { done: true },
        });
      },
      (err) => err instanceof NotFoundError
    );
  });

  it("handleAIFollowupService marks item and duplicates done and emits socket event", async () => {
    let followupDoc = {
      _id: "ai_f_1",
      leadId: "lead_ai_10",
      done: false,
      save: async function () {
        this.done = true;
        return this;
      },
    };
    let updateManyCalled = false;
    const socketEvents = [];

    const mockTenantModels = {
      Followup: {
        findById: async (id) => (id === "ai_f_1" ? followupDoc : null),
        updateMany: async () => {
          updateManyCalled = true;
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

    const res = await handleAIFollowupService({
      tenantModels: mockTenantModels,
      followupId: "ai_f_1",
      handledBy: "Operator Dave",
      organizationId: "org_alpha_1",
      io: mockIo,
    });

    assert.equal(res.done, true);
    assert.equal(followupDoc.done, true);
    assert.equal(updateManyCalled, true);
    assert.ok(socketEvents.some((s) => s.event === "ai_followup_resolved" && s.room === "org_alpha_1"));
  });
});
