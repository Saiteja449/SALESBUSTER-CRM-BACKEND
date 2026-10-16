import test from "node:test";
import assert from "node:assert/strict";
import { updateStatusByWebhook } from "../controllers/leadController.js";
import { receiveWebsiteLead } from "../controllers/websiteController.js";

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

// ============================================================================
// 1. LEAD STATUS WEBHOOK: AUTHENTICATION TESTS
// ============================================================================
test("Webhook: Missing secret is REJECTED with 401 Unauthorized", async () => {
  process.env.LEAD_WEBHOOK_SECRET = "production-secret-999";

  const req = {
    headers: {},
    body: { phone: "9876543210", status: "Converted" },
  };
  const res = createMockRes();
  await updateStatusByWebhook(req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.data.success, false);
  assert.match(res.data.message, /Invalid or missing webhook secret/);
});

test("Webhook: Incorrect secret is REJECTED with 401 Unauthorized", async () => {
  process.env.LEAD_WEBHOOK_SECRET = "production-secret-999";

  const req = {
    headers: { "x-webhook-secret": "wrong-secret-token" },
    body: { phone: "9876543210", status: "Converted" },
  };
  const res = createMockRes();
  await updateStatusByWebhook(req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.data.success, false);
  assert.match(res.data.message, /Invalid or missing webhook secret/);
});

test("Webhook: Authenticates successfully using Organization webhookKey", async () => {
  const mockOrg = {
    _id: "org_alpha_123",
    name: "Alpha Corp",
    tenantDbName: "tenant_alpha",
    webhookKey: "sb_whk_valid_org_token_777",
  };

  const mockLead = {
    _id: "lead_001",
    name: "John Doe",
    phone: "9876543210",
    status: "New",
    save: async () => {},
  };

  const req = {
    headers: { "x-webhook-secret": "sb_whk_valid_org_token_777" },
    organization: mockOrg,
    body: { phone: "9876543210", status: "Converted" },
    tenantModels: {
      Lead: { findOne: async () => mockLead },
      Notification: { create: async () => {} },
    },
  };
  const res = createMockRes();
  await updateStatusByWebhook(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.data.success, true);
  assert.equal(mockLead.status, "Converted");
});

// ============================================================================
// 2. LEAD STATUS WEBHOOK: PHONE NUMBER LOOKUP & VALIDATION TESTS
// ============================================================================
test("Webhook: Missing phone number returns 400 Bad Request", async () => {
  const req = {
    headers: { "x-webhook-secret": "test-secret" },
    body: { status: "Converted" },
    organization: { webhookKey: "test-secret" },
  };
  const res = createMockRes();
  await updateStatusByWebhook(req, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.data.message, /Phone number is required/);
});

test("Webhook: Invalid status value is REJECTED with 400 Bad Request", async () => {
  const req = {
    headers: { "x-webhook-secret": "test-secret" },
    organization: { webhookKey: "test-secret" },
    body: { phone: "9876543210", status: "NonExistentStatus" },
  };
  const res = createMockRes();
  await updateStatusByWebhook(req, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.data.message, /Invalid status/);
});

test("Webhook: Non-existent phone returns 404 Lead Not Found", async () => {
  const req = {
    headers: { "x-webhook-secret": "test-secret" },
    organization: { webhookKey: "test-secret" },
    body: { phone: "9999999999", status: "Converted" },
    tenantModels: {
      Lead: { findOne: async () => null },
    },
  };
  const res = createMockRes();
  await updateStatusByWebhook(req, res);

  assert.equal(res.statusCode, 404);
  assert.match(res.data.message, /Lead not found/);
});

// ============================================================================
// 3. STRICT FIELD PROTECTION TEST: ONLY STATUS CAN BE UPDATED!
// ============================================================================
test("Webhook: STRICT SECURITY GUARD - Only status is updated; all other fields are protected", async () => {
  const mockLead = {
    _id: "lead_strict_101",
    name: "Original Name",
    phone: "9876543210",
    email: "original@company.com",
    assignedTo: "sales_rep_1",
    notes: "Original critical business notes",
    dealValue: 50000,
    source: "Manual Entry",
    status: "New",
    save: async () => {},
  };

  const req = {
    headers: { "x-webhook-secret": "test-secret" },
    organization: { webhookKey: "test-secret", _id: "org_1" },
    body: {
      phone: "9876543210",
      status: "Follow Up",
      // Attacking / tampering payload attempting to overwrite other fields:
      name: "MALICIOUS OVERWRITE",
      email: "hacked@evil.com",
      assignedTo: "hacker_user",
      notes: "WIPED NOTES",
      dealValue: 0,
      source: "Hacked Source",
    },
    tenantModels: {
      Lead: { findOne: async () => mockLead },
      Notification: { create: async () => {} },
    },
  };
  const res = createMockRes();
  await updateStatusByWebhook(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.data.success, true);

  // Status must be updated
  assert.equal(mockLead.status, "Follow Up");

  // All other fields MUST REMAIN COMPLETELY UNCHANGED:
  assert.equal(mockLead.name, "Original Name");
  assert.equal(mockLead.email, "original@company.com");
  assert.equal(mockLead.assignedTo, "sales_rep_1");
  assert.equal(mockLead.notes, "Original critical business notes");
  assert.equal(mockLead.dealValue, 50000);
  assert.equal(mockLead.source, "Manual Entry");
});

test("Webhook: Idempotent - returns 200 when lead is already at target status", async () => {
  const mockLead = {
    _id: "lead_idem_102",
    name: "Existing Converted Lead",
    phone: "9876543210",
    status: "Converted",
    save: async () => {
      throw new Error("Save should not be called when status is identical");
    },
  };

  const req = {
    headers: { "x-webhook-secret": "test-secret" },
    organization: { webhookKey: "test-secret" },
    body: { phone: "9876543210", status: "Converted" },
    tenantModels: {
      Lead: { findOne: async () => mockLead },
    },
  };
  const res = createMockRes();
  await updateStatusByWebhook(req, res);

  assert.equal(res.statusCode, 200);
  assert.match(res.data.message, /already at status/);
});

// ============================================================================
// 4. WEBSITE LEAD INGESTION TESTS
// ============================================================================
test("Website Lead: Missing full name or mobile returns 400 Bad Request", async () => {
  const req = {
    body: { name: "", mobile: "" },
  };
  const res = createMockRes();
  await receiveWebsiteLead(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.data.success, false);
});

test("Website Lead: Successfully ingests lead into organization tenant DB", async () => {
  let createdLead = null;
  const mockLeadModel = {
    findOne: async () => null,
    create: async (data) => {
      createdLead = { ...data, _id: "new_lead_999" };
      return createdLead;
    },
  };

  const mockReps = [
    { _id: "rep_alpha", name: "Alice", role: "sales person" },
    { _id: "rep_beta", name: "Bob", role: "sales person" },
  ];

  let assignmentState = { key: "leadAssignment", lastAssignedIndex: 0, save: async () => {} };

  const req = {
    organization: {
      _id: "org_web_1",
      name: "Acme Web",
      tenantDbName: "tenant_acme",
      aiSettings: { services: [{ name: "Cloud Migration", keywords: ["migration", "cloud"] }] },
    },
    body: {
      fullName: "Michael Scott",
      mobile: "9123456780",
      email: "michael@dundermifflin.com",
      service: "cloud migration",
      message: "Need consultation for 50 workstations",
    },
    tenantModels: {
      Lead: mockLeadModel,
      User: {
        find: () => ({ sort: async () => mockReps }),
      },
      AssignmentState: {
        findOne: async () => assignmentState,
      },
      Notification: {
        create: async () => {},
      },
    },
  };

  const res = createMockRes();
  await receiveWebsiteLead(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.data.success, true);
  assert.ok(createdLead);
  assert.equal(createdLead.name, "Michael Scott");
  assert.equal(createdLead.phone, "9123456780");
  assert.equal(createdLead.email, "michael@dundermifflin.com");
  assert.equal(createdLead.service, "Cloud Migration");
  assert.equal(createdLead.source, "Website Form");
  assert.equal(createdLead.status, "New");
  assert.equal(createdLead.assignedTo, "rep_beta");
});

test("Website Lead: Duplicate phone submission appends inquiry note without failing", async () => {
  const existingLead = {
    _id: "lead_dup_1",
    name: "Jim Halpert",
    phone: "9876543210",
    notes: "Prior inquiry",
    status: "Follow Up",
    save: async () => {},
  };

  const req = {
    organization: { _id: "org_web_1" },
    body: {
      name: "Jim Halpert",
      mobile: "9876543210",
      message: "Following up on my previous query",
    },
    tenantModels: {
      Lead: { findOne: async () => existingLead },
    },
  };

  const res = createMockRes();
  await receiveWebsiteLead(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.data.success, true);
  assert.equal(res.data.isExisting, true);
  assert.match(existingLead.notes, /Following up on my previous query/);
});
