import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { handleMissedCall } from "../controllers/leadController.js";

// Helper to create mock response object
const createMockRes = () => {
  const res = {
    statusCode: 200,
    data: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.data = payload;
      return this;
    },
  };
  return res;
};

test("handleMissedCall - Returns 400 if phone is missing", async () => {
  const req = {
    body: {},
    user: { _id: new mongoose.Types.ObjectId().toString(), role: "sales person" },
  };
  const res = createMockRes();

  await handleMissedCall(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.data.success, false);
  assert.match(res.data.message, /Phone number is required/);
});

test("handleMissedCall - Creates new lead in Today's Follow-up when lead doesn't exist", async () => {
  const repId = new mongoose.Types.ObjectId().toString();
  const todayStr = new Date().toISOString().split("T")[0];

  let createdLeadData = null;
  let createdFollowupData = null;

  const mockLeadModel = {
    findOne: async () => null,
    create: async (data) => {
      createdLeadData = { _id: new mongoose.Types.ObjectId().toString(), ...data };
      return createdLeadData;
    },
  };

  const mockFollowupModel = {
    create: async (data) => {
      createdFollowupData = data;
      return data;
    },
  };

  const mockMessageModel = {
    findOne: async () => null,
  };

  const req = {
    body: {
      phone: "9876543210",
      name: "John Caller",
      callTimestamp: Date.now(),
      sendWhatsApp: false, // disable actual socket call in unit test
    },
    user: { _id: repId, name: "Rep Alice", role: "sales person" },
    tenantModels: {
      Lead: mockLeadModel,
      Followup: mockFollowupModel,
      Message: mockMessageModel,
    },
  };
  const res = createMockRes();

  await handleMissedCall(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.data.success, true);
  assert.equal(res.data.data.isNewLead, true);
  assert.equal(createdLeadData.status, "Follow Up");
  assert.equal(createdLeadData.nextFollowUp, todayStr);
  assert.equal(createdLeadData.source, "Call");
  assert.equal(createdLeadData.assignedTo, repId);

  assert.ok(createdFollowupData, "Followup entry should be created");
  assert.equal(createdFollowupData.date, todayStr);
  assert.equal(createdFollowupData.type, "WhatsApp");
});

test("handleMissedCall - Updates existing lead to Today's Follow-up", async () => {
  const repId = new mongoose.Types.ObjectId().toString();
  const existingLeadId = new mongoose.Types.ObjectId().toString();
  const todayStr = new Date().toISOString().split("T")[0];

  let savedLead = false;
  const mockExistingLead = {
    _id: existingLeadId,
    name: "Existing Customer",
    phone: "+919876543210",
    status: "New",
    nextFollowUp: null,
    notes: "Prior interest in product",
    save: async () => {
      savedLead = true;
    },
  };

  const mockLeadModel = {
    findOne: async () => mockExistingLead,
  };

  const mockFollowupModel = {
    create: async () => ({}),
  };

  const mockMessageModel = {
    findOne: async () => null,
  };

  const req = {
    body: {
      phone: "+91 98765 43210",
      sendWhatsApp: false,
    },
    user: { _id: repId, name: "Rep Bob", role: "sales person" },
    tenantModels: {
      Lead: mockLeadModel,
      Followup: mockFollowupModel,
      Message: mockMessageModel,
    },
  };
  const res = createMockRes();

  await handleMissedCall(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.data.success, true);
  assert.equal(res.data.data.isNewLead, false);
  assert.equal(mockExistingLead.status, "Follow Up");
  assert.equal(mockExistingLead.nextFollowUp, todayStr);
  assert.ok(mockExistingLead.notes.includes("[Missed Call]"));
  assert.equal(savedLead, true);
});
