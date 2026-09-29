import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import {
  getAIFollowups,
  handleAIFollowup,
} from "../controllers/followupController.js";

const createMockRes = () => {
  const res = {
    statusCode: 200,
    data: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.data = data;
      return this;
    },
  };
  return res;
};

test("AI Followups: getAIFollowups restricts sales reps strictly to assigned leads", async () => {
  const repId = new mongoose.Types.ObjectId().toString();
  const repName = "Bob Rep";

  const lead1Id = new mongoose.Types.ObjectId().toString();
  const lead2Id = new mongoose.Types.ObjectId().toString();

  // Mock leads: lead1 is assigned to Bob, lead2 is assigned to Alice
  let capturedLeadQuery = null;
  const mockLeadModel = {
    find: (query) => {
      capturedLeadQuery = query;
      return {
        lean: async () => [
          {
            _id: lead1Id,
            name: "John Doe",
            phone: "+919876543210",
            service: "Solar Panel",
            assignedTo: repId,
          },
        ],
      };
    },
  };

  const mockFollowups = [
    {
      _id: "fu_1",
      leadId: lead1Id,
      author: "AI Agent",
      done: false,
      notes: "Customer asked for quote",
      priority: "High",
      createdAt: new Date(),
    },
  ];

  const mockFollowupModel = {
    find: (query) => ({
      sort: () => ({
        lean: async () => mockFollowups,
      }),
    }),
  };

  const req = {
    user: {
      _id: repId,
      name: repName,
      role: "sales person",
    },
    tenantModels: {
      Lead: mockLeadModel,
      Followup: mockFollowupModel,
    },
  };

  const res = createMockRes();
  await getAIFollowups(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.data.success, true);
  assert.equal(res.data.count, 1);
  assert.equal(res.data.data[0].lead.id, lead1Id);
  assert.ok(capturedLeadQuery.assignedTo, "Leads must be filtered by assignedTo for sales reps");
});

test("AI Followups: getAIFollowups allows sales managers to see all org leads with rep names", async () => {
  const lead1Id = new mongoose.Types.ObjectId().toString();
  const lead2Id = new mongoose.Types.ObjectId().toString();
  const rep1Id = new mongoose.Types.ObjectId().toString();

  let capturedLeadQuery = null;
  const mockLeadModel = {
    find: (query) => {
      capturedLeadQuery = query;
      return {
        lean: async () => [
          {
            _id: lead1Id,
            name: "Lead One",
            phone: "+919876543210",
            service: "Commercial Solar",
            assignedTo: rep1Id,
          },
          {
            _id: lead2Id,
            name: "Lead Two",
            phone: "+919876543211",
            service: "Residential Solar",
            assignedTo: "Unassigned",
          },
        ],
      };
    },
  };

  const mockFollowupModel = {
    find: (query) => ({
      sort: () => ({
        lean: async () => [
          {
            _id: "fu_1",
            leadId: lead1Id,
            author: "AI Agent",
            done: false,
            notes: "Lead One follow-up",
            priority: "High",
            createdAt: new Date(),
          },
          {
            _id: "fu_2",
            leadId: lead2Id,
            author: "AI Agent",
            done: false,
            notes: "Lead Two follow-up",
            priority: "Medium",
            createdAt: new Date(),
          },
        ],
      }),
    }),
  };

  const mockUserModel = {
    find: () => ({
      select: () => ({
        lean: async () => [{ _id: rep1Id, name: "Alice Rep" }],
      }),
    }),
  };

  const req = {
    user: {
      _id: "mgr_1",
      name: "Manager Mike",
      role: "sales manager",
    },
    tenantModels: {
      Lead: mockLeadModel,
      Followup: mockFollowupModel,
      User: mockUserModel,
    },
  };

  const res = createMockRes();
  await getAIFollowups(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.data.success, true);
  assert.equal(res.data.count, 2);
  assert.deepEqual(capturedLeadQuery, {}, "Manager query must not be restricted by assignedTo");
  assert.equal(res.data.data[0].lead.assignedRepName, "Alice Rep");
});

test("AI Followups: handleAIFollowup blocks sales rep from resolving unassigned lead (403)", async () => {
  const repId = "rep_alice";
  const foreignRepId = "rep_bob";
  const foreignLeadId = new mongoose.Types.ObjectId().toString();

  const mockLead = {
    _id: foreignLeadId,
    assignedTo: foreignRepId,
  };

  const mockFollowup = {
    _id: "fu_123",
    leadId: foreignLeadId,
    author: "AI Agent",
    done: false,
  };

  const req = {
    user: {
      _id: repId,
      name: "Alice Rep",
      role: "sales person",
    },
    params: { id: "fu_123" },
    tenantModels: {
      Followup: {
        findById: async () => mockFollowup,
      },
      Lead: {
        findById: async () => mockLead,
      },
    },
  };

  const res = createMockRes();
  await handleAIFollowup(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.data.success, false);
});

test("AI Followups: handleAIFollowup marks followup done and resolves pending AI items for the lead", async () => {
  const repId = "rep_alice";
  const leadId = new mongoose.Types.ObjectId().toString();

  let saved = false;
  let updateManyFilter = null;
  const mockFollowup = {
    _id: "fu_123",
    leadId,
    author: "AI Agent",
    done: false,
    save: async function () {
      saved = true;
      this.done = true;
      return this;
    },
  };

  const mockLead = {
    _id: leadId,
    assignedTo: repId,
  };

  const req = {
    user: {
      _id: repId,
      name: "Alice Rep",
      role: "sales person",
    },
    params: { id: "fu_123" },
    tenantModels: {
      Followup: {
        findById: async () => mockFollowup,
        updateMany: async (filter, update) => {
          updateManyFilter = filter;
        },
      },
      Lead: {
        findById: async () => mockLead,
      },
    },
  };

  const res = createMockRes();
  await handleAIFollowup(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.data.success, true);
  assert.equal(saved, true);
  assert.equal(mockFollowup.done, true);
  assert.equal(updateManyFilter.leadId, leadId);
  assert.equal(updateManyFilter.author, "AI Agent");
});
