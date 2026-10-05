import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { isRepAIAutoReplyEnabled } from "../whatsapp/whatsappService.js";
import { toggleMyAIAutoReply, getGlobalSettings } from "../controllers/whatsappController.js";

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

// 1. UNIT TESTS: isRepAIAutoReplyEnabled
test("isRepAIAutoReplyEnabled: returns true for unassigned lead", async () => {
  const lead = { assignedTo: "Unassigned" };
  const allowed = await isRepAIAutoReplyEnabled(lead, "org_123", {});
  assert.equal(allowed, true, "Unassigned leads should follow global settings");
});

test("isRepAIAutoReplyEnabled: returns false when assigned rep has aiAutoReplyEnabled: false", async () => {
  const repId = new mongoose.Types.ObjectId().toString();
  const lead = { assignedTo: repId };
  const mockModels = {
    User: {
      findById: async () => ({
        _id: repId,
        name: "Alice",
        aiAutoReplyEnabled: false,
      }),
    },
  };

  const allowed = await isRepAIAutoReplyEnabled(lead, "org_123", mockModels);
  assert.equal(allowed, false, "Should block AI auto-reply when rep has disabled it");
});

test("isRepAIAutoReplyEnabled: returns true when assigned rep has aiAutoReplyEnabled: true", async () => {
  const repId = new mongoose.Types.ObjectId().toString();
  const lead = { assignedTo: repId };
  const mockModels = {
    User: {
      findById: async () => ({
        _id: repId,
        name: "Bob",
        aiAutoReplyEnabled: true,
      }),
    },
  };

  const allowed = await isRepAIAutoReplyEnabled(lead, "org_123", mockModels);
  assert.equal(allowed, true, "Should allow AI auto-reply when rep has enabled it");
});

test("isRepAIAutoReplyEnabled: detects rep from session ID and blocks when rep disabled it", async () => {
  const repId = new mongoose.Types.ObjectId().toString();
  const lead = { assignedTo: "Unassigned" };
  const sessionId = `org_123_user_${repId}`;
  const mockModels = {
    User: {
      findById: async () => ({
        _id: repId,
        name: "Charlie",
        aiAutoReplyEnabled: false,
      }),
    },
  };

  const allowed = await isRepAIAutoReplyEnabled(lead, sessionId, mockModels);
  assert.equal(allowed, false, "Should block AI auto-reply when session rep has disabled it");
});

// 2. ENDPOINT TESTS: toggleMyAIAutoReply
test("toggleMyAIAutoReply: sales rep can toggle their own AI setting", async () => {
  const repId = new mongoose.Types.ObjectId().toString();
  let updatedSetting = null;

  const mockUser = {
    _id: repId,
    name: "Alice Rep",
    aiAutoReplyEnabled: true,
    save: async function () {
      updatedSetting = this.aiAutoReplyEnabled;
    },
  };

  const req = {
    user: { _id: repId, role: "sales person" },
    body: { enabled: false },
    tenantModels: {
      User: {
        findById: async () => mockUser,
      },
    },
  };
  const res = createMockRes();

  await toggleMyAIAutoReply(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.data.success, true);
  assert.equal(res.data.data.aiAutoReplyEnabled, false);
  assert.equal(updatedSetting, false, "User record must have aiAutoReplyEnabled set to false");
});

test("toggleMyAIAutoReply: sales rep is blocked (403) from tampering with another rep's setting", async () => {
  const repId1 = new mongoose.Types.ObjectId().toString();
  const repId2 = new mongoose.Types.ObjectId().toString();

  const req = {
    user: { _id: repId1, role: "sales person" },
    body: { repId: repId2, enabled: false },
    tenantModels: {},
  };
  const res = createMockRes();

  await toggleMyAIAutoReply(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.data.success, false);
  assert.match(res.data.message, /only manage your own AI/i);
});

test("toggleMyAIAutoReply: sales manager can toggle a specific rep's setting", async () => {
  const mgrId = new mongoose.Types.ObjectId().toString();
  const repId = new mongoose.Types.ObjectId().toString();
  let updatedSetting = null;

  const mockUser = {
    _id: repId,
    name: "Target Rep",
    aiAutoReplyEnabled: true,
    save: async function () {
      updatedSetting = this.aiAutoReplyEnabled;
    },
  };

  const req = {
    user: { _id: mgrId, role: "sales manager" },
    body: { repId: repId, enabled: false },
    tenantModels: {
      User: {
        findById: async () => mockUser,
      },
    },
  };
  const res = createMockRes();

  await toggleMyAIAutoReply(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.data.data.aiAutoReplyEnabled, false);
  assert.equal(updatedSetting, false);
});
