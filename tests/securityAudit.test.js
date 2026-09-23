import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";

// Middleware imports
import { protect, verifySuperAdmin, requireSuperAdmin } from "../middleware/authMiddleware.js";
import { tenantMiddleware, checkSubscriptionActive } from "../middleware/tenantMiddleware.js";

// Controller imports
import {
  getLeads,
  getPaginatedLeads,
  createLead,
  updateLead,
  deleteLead,
  updateStatusByWebhook,
  uploadRecordingForLead,
  analyzeRecording,
  importExcelLeads,
} from "../controllers/leadController.js";
import {
  getFollowups,
  createFollowup,
  updateFollowup,
} from "../controllers/followupController.js";
import {
  logCall,
  getAnalyticsBySalesperson,
  getTodayAnalyticsForAll,
  refreshAILimits,
} from "../controllers/analyticsController.js";
import {
  addSalesPerson,
  deleteSalesPerson,
} from "../controllers/userController.js";
import {
  getMyAISettings,
  updateMyAISettings,
  validateGeminiApiKey,
  uploadKnowledgeDoc,
  deleteKnowledgeDoc,
} from "../controllers/organizationController.js";
import {
  testAI,
  getTestAIHistory,
  toggleAI,
  updateGlobalSettings,
} from "../controllers/whatsappController.js";
import { getCloudStatus } from "../controllers/whatsappCloudController.js";
import {
  getCampaigns,
  createCampaign,
} from "../controllers/whatsappCampaignController.js";
import { sendMessageFromCRM } from "../whatsapp/whatsappService.js";

const JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-xyz";
process.env.JWT_SECRET = JWT_SECRET;

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

// ============================================================================
// 1. DEFAULT SUPER ADMIN KEY REMOVAL & AUTH MIDDLEWARE TESTS
// ============================================================================
test("Auth: Old hardcoded literal key 'salesbuster_super_admin_secret_key_2026' is REJECTED", async () => {
  const origKey = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = "strictly_configured_different_key_999";
  try {
    const req = {
      headers: { "x-admin-key": "salesbuster_super_admin_secret_key_2026" },
    };
    const res = createMockRes();
    let nextCalled = false;

    await verifySuperAdmin(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false, "Old hardcoded key must not grant super admin access");
    assert.equal(res.statusCode, 401, "Must return 401 Unauthorized");
  } finally {
    if (origKey !== undefined) process.env.ADMIN_API_KEY = origKey;
    else delete process.env.ADMIN_API_KEY;
  }
});

test("Auth: Unconfigured ADMIN_API_KEY rejects any x-admin-key attempt", async () => {
  const origKey = process.env.ADMIN_API_KEY;
  delete process.env.ADMIN_API_KEY;

  try {
    const req = {
      headers: { "x-admin-key": "some-random-key" },
    };
    const res = createMockRes();
    let nextCalled = false;

    await verifySuperAdmin(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false, "Must reject when ADMIN_API_KEY is not configured");
    assert.equal(res.statusCode, 401);
  } finally {
    if (origKey !== undefined) process.env.ADMIN_API_KEY = origKey;
  }
});

test("Auth: Explicitly configured ADMIN_API_KEY is accepted", async () => {
  const origKey = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = "super-secure-production-key-999";

  try {
    const req = {
      headers: { "x-admin-key": "super-secure-production-key-999" },
    };
    const res = createMockRes();
    let nextCalled = false;

    await verifySuperAdmin(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true, "Valid configured ADMIN_API_KEY must be accepted");
    assert.equal(req.user?.role, "super_admin");
  } finally {
    if (origKey !== undefined) {
      process.env.ADMIN_API_KEY = origKey;
    } else {
      delete process.env.ADMIN_API_KEY;
    }
  }
});

test("Auth: protect rejects missing token with 401", async () => {
  const req = { headers: {} };
  const res = createMockRes();
  let nextCalled = false;

  await protect(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.match(res.data.message, /no token/i);
});

test("Auth: protect rejects invalid token with 401", async () => {
  const req = { headers: { authorization: "Bearer completely-bogus-token" } };
  const res = createMockRes();
  let nextCalled = false;

  await protect(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.match(res.data.message, /token invalid/i);
});

// ============================================================================
// 2. TENANT RESOLUTION & HEADER TAMPERING ISOLATION
// ============================================================================
test("Tenant Middleware: Verified token cannot be overridden by unauthenticated x-tenant-db header", async () => {
  const tokenPayload = {
    id: "user_alpha",
    role: "sales person",
    tenantDbName: "tenant_alpha_db",
    organizationId: "org_alpha",
  };
  const token = jwt.sign(tokenPayload, JWT_SECRET);

  const req = {
    headers: {
      authorization: `Bearer ${token}`,
      "x-tenant-db": "tenant_attacker_override_db",
    },
    query: {
      tenantDb: "tenant_attacker_query_override_db",
    },
  };
  const res = createMockRes();
  let nextCalled = false;

  await tenantMiddleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(
    req.tenantDbName,
    "tenant_alpha_db",
    "Tenant scope must come strictly from verified token, ignoring header/query overrides"
  );
});

test("Subscription: checkSubscriptionActive strictly rejects old literal key", () => {
  const origKey = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = "strictly_configured_different_key_999";
  try {
    const req = {
      headers: { "x-admin-key": "salesbuster_super_admin_secret_key_2026" },
      path: "/api/leads",
      organization: { status: "active" },
    };
    const res = createMockRes();
    let nextCalled = false;

    checkSubscriptionActive(req, res, () => {
      nextCalled = true;
    });

    assert.equal(
      nextCalled,
      true,
      "Active organization passes subscription check without admin key bypass"
    );
    // Now test with suspended org and old key
    const reqSuspended = {
      headers: { "x-admin-key": "salesbuster_super_admin_secret_key_2026" },
      path: "/api/leads",
      organization: { status: "suspended" },
    };
    const resSuspended = createMockRes();
    let nextSuspendedCalled = false;

    checkSubscriptionActive(reqSuspended, resSuspended, () => {
      nextSuspendedCalled = true;
    });

    assert.equal(
      nextSuspendedCalled,
      false,
      "Old literal admin key must not bypass suspended check"
    );
    assert.equal(resSuspended.statusCode, 403);
  } finally {
    if (origKey !== undefined) process.env.ADMIN_API_KEY = origKey;
    else delete process.env.ADMIN_API_KEY;
  }
});

// ============================================================================
// 3. LEAD CONTROLLER ROLE & ASSIGNMENT PERMISSIONS
// ============================================================================
test("Leads: getLeads restricts sales reps strictly to assigned leads", async () => {
  let capturedQuery = null;
  const mockLeadModel = {
    find: async (query) => {
      capturedQuery = query;
      return [];
    },
  };

  const req = {
    user: {
      _id: "rep_id_101",
      name: "Alice Rep",
      role: "sales person",
    },
    tenantModels: { Lead: mockLeadModel },
  };
  const res = createMockRes();

  await getLeads(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(capturedQuery.assignedTo, "Rep query must filter by assignedTo");
  assert.ok(
    capturedQuery.assignedTo.$in.includes("rep_id_101"),
    "Rep query must include rep ID"
  );
});

test("Leads: getPaginatedLeads ignores client query parameter tampering for sales reps", async () => {
  let capturedQuery = null;
  const mockLeadModel = {
    find: (q) => {
      capturedQuery = q;
      return {
        sort: () => ({
          skip: () => ({
            limit: async () => [],
          }),
        }),
      };
    },
    countDocuments: async () => 0,
    aggregate: async () => [
      {
        OldLeads: [],
        New: [],
        TodayFollowup: [],
        UpcomingFollowup: [],
        Converted: [],
        NotAttended: [],
        Lost: [],
      },
    ],
  };

  const req = {
    user: {
      _id: "rep_id_101",
      name: "Alice Rep",
      role: "sales person",
    },
    query: {
      currentUserRole: "sales manager", // Tamper attempt
      currentUserId: "rep_id_VICTIM", // Tamper attempt
      currentUserName: "Bob Rep", // Tamper attempt
      salespersonId: "rep_id_VICTIM", // Tamper attempt
      salesperson: "Bob Rep", // Tamper attempt
    },
    tenantModels: { Lead: mockLeadModel },
  };
  const res = createMockRes();

  await getPaginatedLeads(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(capturedQuery.assignedTo, "Rep query must filter by assignedTo");
  assert.equal(req.user.role, "sales person");
});

test("Leads: updateLead blocks sales rep from updating lead assigned to another rep (403)", async () => {
  const mockLead = {
    _id: "lead_456",
    name: "Customer X",
    assignedTo: "rep_id_OTHER",
    set() {},
    save: async () => {},
  };

  const mockLeadModel = {
    findById: async () => mockLead,
  };

  const req = {
    user: {
      _id: "rep_id_101",
      name: "Alice Rep",
      role: "sales person",
    },
    params: { id: "lead_456" },
    body: { status: "Converted" },
    tenantModels: { Lead: mockLeadModel },
  };
  const res = createMockRes();

  await updateLead(req, res);

  assert.equal(res.statusCode, 403, "Must return 403 Forbidden for unassigned lead");
  assert.match(res.data.message, /only update leads assigned to you/i);
});

test("Leads: updateLead strips assignedTo tampering when rep updates their own lead", async () => {
  let updatedFields = null;
  const mockLead = {
    _id: "lead_456",
    name: "Customer X",
    assignedTo: "rep_id_101",
    set(data) {
      updatedFields = data;
    },
    save: async () => {},
  };

  const mockLeadModel = {
    findById: async () => mockLead,
  };

  const req = {
    user: {
      _id: "rep_id_101",
      name: "Alice Rep",
      role: "sales person",
    },
    params: { id: "lead_456" },
    body: {
      status: "Converted",
      assignedTo: "rep_id_NEW_REPRESENTATIVE", // Attempted reassignment
    },
    tenantModels: {
      Lead: mockLeadModel,
      Notification: { create: async () => {} },
      Followup: { updateMany: async () => {} },
    },
  };
  const res = createMockRes();

  await updateLead(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(
    updatedFields.assignedTo,
    undefined,
    "Rep must not be able to reassign lead"
  );
});

test("Leads: deleteLead blocks sales reps with 403", async () => {
  const req = {
    user: {
      _id: "rep_id_101",
      name: "Alice Rep",
      role: "sales person",
    },
    params: { id: "lead_456" },
    tenantModels: { Lead: {} },
  };
  const res = createMockRes();

  await deleteLead(req, res);

  assert.equal(res.statusCode, 403);
  assert.match(res.data.message, /Only sales managers and administrators/i);
});

test("Leads: importExcelLeads blocks sales reps with 403", async () => {
  const req = {
    user: {
      _id: "rep_id_101",
      name: "Alice Rep",
      role: "sales person",
    },
    body: {},
    tenantModels: {},
  };
  const res = createMockRes();

  await importExcelLeads(req, res);

  assert.equal(res.statusCode, 403);
  assert.match(res.data.message, /Only sales managers and administrators/i);
});

test("Leads: uploadRecordingForLead and analyzeRecording block unassigned reps with 403", async () => {
  const mockLead = {
    _id: "lead_789",
    assignedTo: "rep_id_DIFFERENT",
  };
  const mockLeadModel = {
    findById: async () => mockLead,
  };

  const req = {
    user: {
      _id: "rep_id_101",
      name: "Alice Rep",
      role: "sales person",
    },
    params: { id: "lead_789", recordingId: "rec_1" },
    tenantModels: { Lead: mockLeadModel },
  };

  // Upload recording
  const resUpload = createMockRes();
  await uploadRecordingForLead(req, resUpload);
  assert.equal(resUpload.statusCode, 403);

  // Analyze recording
  const resAnalyze = createMockRes();
  await analyzeRecording(req, resAnalyze);
  assert.equal(resAnalyze.statusCode, 403);
});

// ============================================================================
// 4. LEAD STATUS WEBHOOK VERIFICATION
// ============================================================================
test("Webhook: Missing or invalid secret is REJECTED with 401", async () => {
  process.env.LEAD_WEBHOOK_SECRET = "production-lead-secret-12345";

  // Test 1: No secret provided
  const reqNoSecret = {
    headers: {},
    body: { phone: "9876543210", event: "converted" },
  };
  const resNoSecret = createMockRes();
  await updateStatusByWebhook(reqNoSecret, resNoSecret);
  assert.equal(resNoSecret.statusCode, 401);
  assert.match(resNoSecret.data.message, /Invalid or missing webhook secret/);

  // Test 2: Invalid secret provided
  const reqBadSecret = {
    headers: { "x-webhook-secret": "wrong-secret-token" },
    body: { phone: "9876543210", event: "converted" },
  };
  const resBadSecret = createMockRes();
  await updateStatusByWebhook(reqBadSecret, resBadSecret);
  assert.equal(resBadSecret.statusCode, 401);
  assert.match(resBadSecret.data.message, /Invalid or missing webhook secret/);

  // Test 3: Valid secret provided
  const mockLead = {
    _id: "lead_123",
    name: "Customer Webhook",
    status: "New",
    save: async () => {},
  };
  const mockLeadModel = {
    findOne: async () => mockLead,
  };
  const mockNotifModel = {
    create: async () => {},
  };

  const reqValidSecret = {
    headers: { "x-webhook-secret": "production-lead-secret-12345" },
    body: { phone: "9876543210", event: "converted" },
    tenantModels: { Lead: mockLeadModel, Notification: mockNotifModel },
  };
  const resValidSecret = createMockRes();
  await updateStatusByWebhook(reqValidSecret, resValidSecret);
  assert.equal(resValidSecret.statusCode, 200);
});

// ============================================================================
// 5. FOLLOW-UP AND ANALYTICS CONTROLLER AUTHORIZATION
// ============================================================================
test("Followups: getFollowups restricts sales reps strictly to assigned leads", async () => {
  let capturedFilter = null;
  const mockFollowupModel = {
    find: (filter) => {
      capturedFilter = filter;
      return { sort: () => [] };
    },
  };
  const mockLeadModel = {
    find: () => ({
      select: async () => [{ _id: "lead_assigned_1" }, { _id: "lead_assigned_2" }],
    }),
  };

  const req = {
    user: {
      _id: "rep_id_101",
      name: "Alice Rep",
      role: "sales person",
    },
    tenantModels: {
      Followup: mockFollowupModel,
      Lead: mockLeadModel,
    },
  };
  const res = createMockRes();

  await getFollowups(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(capturedFilter.$or, "Filter must be scoped to assigned leads or author");
});

test("Followups: createFollowup and updateFollowup block reps from unassigned leads (403)", async () => {
  const mockLead = {
    _id: "lead_foreign",
    assignedTo: "rep_id_OTHER",
  };
  const mockLeadModel = {
    findById: async () => mockLead,
  };
  const mockFollowup = {
    _id: "fu_1",
    leadId: "lead_foreign",
    save: async () => {},
  };
  const mockFollowupModel = {
    findById: async () => mockFollowup,
  };

  const req = {
    user: {
      _id: "rep_id_101",
      name: "Alice Rep",
      role: "sales person",
    },
    body: { leadId: "lead_foreign", notes: "Call back" },
    params: { id: "fu_1" },
    tenantModels: {
      Lead: mockLeadModel,
      Followup: mockFollowupModel,
    },
  };

  // Create followup
  const resCreate = createMockRes();
  await createFollowup(req, resCreate);
  assert.equal(resCreate.statusCode, 403);

  // Update followup
  const resUpdate = createMockRes();
  await updateFollowup(req, resUpdate);
  assert.equal(resUpdate.statusCode, 403);
});

test("Analytics: logCall binds strictly to authenticated rep's own identity", async () => {
  let capturedQuery = null;
  const mockAnalyticsModel = {
    findOneAndUpdate: async (query, update) => {
      capturedQuery = query;
      return { ...query, ...update };
    },
  };

  const req = {
    user: {
      _id: "rep_id_101",
      name: "Alice Rep",
      role: "sales person",
    },
    body: {
      salespersonId: "rep_id_VICTIM", // Spoofing attempt
      salesperson: "Bob Rep", // Spoofing attempt
      date: "2026-09-23",
      duration: 120,
      callType: "outgoing",
      status: "connected",
    },
    tenantModels: { TelecallerAnalytics: mockAnalyticsModel },
  };
  const res = createMockRes();

  await logCall(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(
    capturedQuery.salespersonId,
    "rep_id_101",
    "Must be bound strictly to authenticated rep ID, ignoring request body spoofing"
  );
});

test("Analytics: Sales reps blocked from team-wide analytics and AI-limit refresh (403)", async () => {
  const req = {
    user: {
      _id: "rep_id_101",
      name: "Alice Rep",
      role: "sales person",
    },
    params: { salesperson: "rep_id_OTHER" },
    tenantModels: {},
  };

  // Team-wide today analytics
  const resTeam = createMockRes();
  await getTodayAnalyticsForAll(req, resTeam);
  assert.equal(resTeam.statusCode, 403);

  // Refresh AI limits
  const resRefresh = createMockRes();
  await refreshAILimits(req, resRefresh);
  assert.equal(resRefresh.statusCode, 403);

  // Cross-rep analytics view
  const resCross = createMockRes();
  await getAnalyticsBySalesperson(req, resCross);
  assert.equal(resCross.statusCode, 403);
});

// ============================================================================
// 6. ROLE-BASED ADMIN AUTHORIZATION (USERS & ORGANIZATION AI SETTINGS)
// ============================================================================
test("Admin: Sales reps blocked from adding or deleting representatives (403)", async () => {
  const req = {
    user: {
      _id: "rep_id_101",
      name: "Alice Rep",
      role: "sales person",
    },
    body: {
      name: "New Rep",
      email: "newrep@crm.test",
      phone: "+91 99999 88888",
    },
    params: { id: "user_to_delete" },
    tenantModels: {},
  };

  // Add rep
  const resAdd = createMockRes();
  await addSalesPerson(req, resAdd);
  assert.equal(resAdd.statusCode, 403);
  assert.match(resAdd.data.message, /Only sales managers or organization owners/);

  // Delete rep
  const resDelete = createMockRes();
  await deleteSalesPerson(req, resDelete);
  assert.equal(resDelete.statusCode, 403);
  assert.match(resDelete.data.message, /Only sales managers or organization owners/);
});

test("Admin: Sales reps blocked from updating AI settings and knowledge base (403)", async () => {
  const req = {
    user: {
      _id: "rep_id_101",
      name: "Alice Rep",
      role: "sales person",
    },
    body: { geminiApiKey: "AIzaSyFakeKey12345" },
    params: { docId: "doc_123" },
  };

  // Update AI settings
  const resAI = createMockRes();
  await updateMyAISettings(req, resAI);
  assert.equal(resAI.statusCode, 403);

  // Validate API key
  const resVal = createMockRes();
  await validateGeminiApiKey(req, resVal);
  assert.equal(resVal.statusCode, 403);

  // Upload knowledge doc
  const resUpload = createMockRes();
  await uploadKnowledgeDoc(req, resUpload);
  assert.equal(resUpload.statusCode, 403);

  // Delete knowledge doc
  const resDel = createMockRes();
  await deleteKnowledgeDoc(req, resDel);
  assert.equal(resDel.statusCode, 403);
});

// ============================================================================
// 7. CROSS-ORGANIZATION WHATSAPP SEND PREVENTION
// ============================================================================
test("WhatsApp: sendMessageFromCRM rejects session IDs belonging to another organization", async () => {
  await assert.rejects(
    async () => {
      await sendMessageFromCRM(
        "lead_123",
        "Hello customer",
        "Alice Rep",
        {
          organizationId: "org_alpha",
          sessionId: "org_beta_user_foreign", // Session belonging to org_beta!
        }
      );
    },
    /does not belong to organization org_alpha/,
    "Must throw unauthorized error when sessionId does not belong to organization"
  );
});

// ============================================================================
// 8. WHATSAPP SETTINGS, AI TEST, AND CLOUD STATUS AUTHORIZATION
// ============================================================================
test("WhatsApp: testAI and getTestAIHistory block sales reps from testing AI and resetting leads (403)", async () => {
  const req = {
    user: {
      _id: "rep_101",
      role: "sales person",
      name: "Alice Rep",
    },
    body: {
      message: "Test message",
      leadId: "lead_victim_999",
      reset: true,
    },
  };

  const resTest = createMockRes();
  await testAI(req, resTest);
  assert.equal(resTest.statusCode, 403);
  assert.match(resTest.data.message, /Access denied/);

  const resHistory = createMockRes();
  await getTestAIHistory(req, resHistory);
  assert.equal(resHistory.statusCode, 403);
});

test("WhatsApp: toggleAI blocks sales reps from toggling AI on unassigned leads (403)", async () => {
  const mockLeadUnassigned = {
    _id: "lead_unassigned",
    name: "Customer Bob",
    assignedTo: "other_rep_202",
    aiEnabled: true,
    save: async () => {},
  };
  const mockLeadAssigned = {
    _id: "lead_assigned",
    name: "Customer Alice",
    assignedTo: "rep_101",
    aiEnabled: false,
    save: async () => {},
  };

  const mockLeadModel = {
    findById: async (id) => (id === "lead_assigned" ? mockLeadAssigned : mockLeadUnassigned),
  };

  const repUser = {
    _id: "rep_101",
    role: "sales person",
    name: "Alice Rep",
  };

  // Attempt to toggle unassigned lead
  const reqBlocked = {
    user: repUser,
    body: { leadId: "lead_unassigned", aiEnabled: false },
    tenantModels: { Lead: mockLeadModel },
  };
  const resBlocked = createMockRes();
  await toggleAI(reqBlocked, resBlocked);
  assert.equal(resBlocked.statusCode, 403);
  assert.match(resBlocked.data.message, /You are not assigned to this lead/);

  // Successfully toggle assigned lead
  const reqAllowed = {
    user: repUser,
    body: { leadId: "lead_assigned", aiEnabled: true },
    tenantModels: { Lead: mockLeadModel },
  };
  const resAllowed = createMockRes();
  await toggleAI(reqAllowed, resAllowed);
  assert.equal(resAllowed.statusCode, 200);
  assert.equal(mockLeadAssigned.aiEnabled, true);
});

test("WhatsApp: updateGlobalSettings blocks sales reps (403)", async () => {
  const req = {
    user: {
      _id: "rep_101",
      role: "sales person",
      name: "Alice Rep",
    },
    body: { welcomeMessageTemplate: "Malicious template" },
  };
  const res = createMockRes();
  await updateGlobalSettings(req, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.data.message, /Only managers or administrators/);
});

test("WhatsApp Cloud: getCloudStatus blocks sales reps with 403", async () => {
  const req = {
    user: {
      _id: "rep_101",
      role: "sales person",
      name: "Alice Rep",
    },
    organization: {
      _id: "org_123",
      whatsappCloudSettings: {
        isConfigured: true,
        webhookVerifyToken: "secret_verify_token",
      },
    },
  };
  const res = createMockRes();
  await getCloudStatus(req, res);
  assert.equal(res.statusCode, 403);
});

test("WhatsApp Cloud: getCloudStatus does not return plaintext webhookVerifyToken or hardcoded fallback", async () => {
  const req = {
    user: {
      _id: "manager_101",
      role: "sales manager",
      name: "Manager Dan",
    },
    organization: {
      _id: "org_123",
      whatsappCloudSettings: {
        isConfigured: true,
        webhookVerifyToken: "production_secret_token_never_expose",
      },
    },
  };
  const res = createMockRes();
  await getCloudStatus(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.data.webhookVerifyToken, undefined);
  assert.notEqual(res.data.data.maskedWebhookVerifyToken, "production_secret_token_never_expose");
  assert.equal(res.data.data.hasWebhookVerifyToken, true);
});

test("WhatsApp Cloud: getCampaigns blocks sales reps with 403", async () => {
  const req = {
    user: {
      _id: "rep_101",
      role: "sales person",
      name: "Alice Rep",
    },
    query: {},
  };
  const res = createMockRes();
  await getCampaigns(req, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.data.message, /Manager or Administrator privileges required/);
});

test("WhatsApp Cloud: createCampaign blocks sales reps with 403", async () => {
  const req = {
    user: {
      _id: "rep_101",
      role: "sales person",
      name: "Alice Rep",
    },
    body: {
      name: "Test Campaign",
      templateId: "tpl_123",
    },
  };
  const res = createMockRes();
  await createCampaign(req, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.data.message, /Manager or Administrator privileges required/);
});

