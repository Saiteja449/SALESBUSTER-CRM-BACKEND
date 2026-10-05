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
    body: { number: "+919876500001" },
    user: { _id: new mongoose.Types.ObjectId().toString(), role: "sales person" },
  };
  const res = createMockRes();

  await handleMissedCall(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.data.success, false);
  assert.match(res.data.message, /Phone number is required/);
});

test("handleMissedCall - Returns 400 if received SIM number ('number') is missing", async () => {
  const req = {
    body: { phone: "+919876543210" },
    user: { _id: new mongoose.Types.ObjectId().toString(), role: "sales person" },
  };
  const res = createMockRes();

  await handleMissedCall(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.data.success, false);
  assert.match(res.data.message, /Received SIM phone number \('number'\) is required/);
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
      number: "+919876500001",
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
  assert.equal(createdLeadData.status, "Missed Call");
  assert.equal(createdLeadData.nextFollowUp, todayStr);
  assert.equal(createdLeadData.source, "Missed Call");
  assert.equal(createdLeadData.assignedTo, repId);

  assert.ok(createdFollowupData, "Followup entry should be created");
  assert.equal(createdFollowupData.date, todayStr);
  assert.equal(createdFollowupData.type, "Call");
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
      number: "+919876500001",
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
  assert.equal(mockExistingLead.status, "Missed Call");
  assert.ok(mockExistingLead.notes.includes("[Missed Call]"));
  assert.equal(savedLead, true);
});

test("handleMissedCall - Same SIM called: does NOT include secondary number notice", async () => {
  const repId = new mongoose.Types.ObjectId().toString();
  const mockLead = {
    _id: new mongoose.Types.ObjectId().toString(),
    name: "John Caller",
    phone: "+919123456789",
    status: "New",
    save: async () => {},
  };

  const req = {
    body: {
      phone: "+919123456789",
      number: "+919876500001", // Called on SIM 1
      name: "John Caller",
      sendWhatsApp: true,
    },
    user: { _id: repId, name: "Rep Alice", role: "sales person" },
    tenantModels: {
      Lead: { findOne: async () => mockLead },
      Followup: { create: async () => ({}) },
      Message: { findOne: async () => null },
      WhatsAppSession: {
        findOne: async () => ({
          sessionId: `user_${repId}`,
          connectedPhone: "919876500001", // Connected on SIM 1
        }),
      },
    },
  };
  const res = createMockRes();

  await handleMissedCall(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.data.data.dispatchedMessageText);
  // Verify standard message is formatted and does NOT contain cross-SIM text
  assert.match(res.data.data.dispatchedMessageText, /We have received your call/);
  assert.ok(!res.data.data.dispatchedMessageText.includes("this is also my number"));
});

test("handleMissedCall - Different SIM called: includes 'You have contacted this number, this is also my number'", async () => {
  const repId = new mongoose.Types.ObjectId().toString();
  const mockLead = {
    _id: new mongoose.Types.ObjectId().toString(),
    name: "John Caller",
    phone: "+919123456789",
    status: "New",
    save: async () => {},
  };

  const req = {
    body: {
      phone: "+919123456789",
      number: "+919876500002", // Called on SIM 2
      name: "John Caller",
      sendWhatsApp: true,
    },
    user: { _id: repId, name: "Rep Alice", role: "sales person" },
    tenantModels: {
      Lead: { findOne: async () => mockLead },
      Followup: { create: async () => ({}) },
      Message: { findOne: async () => null },
      WhatsAppSession: {
        findOne: async () => ({
          sessionId: `user_${repId}`,
          connectedPhone: "919876500001", // Connected on SIM 1
        }),
      },
    },
  };
  const res = createMockRes();

  await handleMissedCall(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.data.data.dispatchedMessageText);
  // Verify different-SIM message informs customer that this is also rep's number
  assert.match(res.data.data.dispatchedMessageText, /You have contacted \+919876500002, this is also my number/);
});

test("handleMissedCall - Disabled in SystemSettings: skips WhatsApp message dispatch", async () => {
  const repId = new mongoose.Types.ObjectId().toString();
  const mockLead = {
    _id: new mongoose.Types.ObjectId().toString(),
    name: "John Caller",
    phone: "+919123456789",
    status: "New",
    save: async () => {},
  };

  const req = {
    body: {
      phone: "+919123456789",
      number: "+919876500002",
      name: "John Caller",
      sendWhatsApp: true,
    },
    user: { _id: repId, name: "Rep Alice", role: "sales person" },
    tenantModels: {
      Lead: { findOne: async () => mockLead },
      Followup: { create: async () => ({}) },
      Message: { findOne: async () => null },
      SystemSettings: {
        findOne: () => ({
          lean: async () => ({ missedCallMessageEnabled: false }),
        }),
      },
    },
  };
  const res = createMockRes();

  await handleMissedCall(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.data.data.dispatchedMessageText, "");
  assert.equal(res.data.data.whatsappSent, false);
});
