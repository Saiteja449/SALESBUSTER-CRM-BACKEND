import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { verifyPhoneNumberMatch, getWhatsAppStatus } from "../whatsapp/whatsappService.js";
import {
  sendMessage,
  getConversations,
  getMessages,
  summarizeConversation,
  getQR,
  getStatus,
} from "../controllers/whatsappController.js";
import {
  socketAuthMiddleware,
  handleJoinLeadChat,
  handleJoinOrganization,
} from "../socket/socket.js";

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
// 1. STRICT PHONE VERIFICATION UNIT TESTS
// ============================================================================
test("Strict Phone Verification - Matching country code and number succeeds", () => {
  // Scanned from Baileys: 919876543210:1@s.whatsapp.net
  // Profile registered: +91 98765 43210
  assert.equal(
    verifyPhoneNumberMatch("919876543210:1@s.whatsapp.net", "+91 98765 43210"),
    true,
    "Should match identical international number"
  );
});

test("Strict Phone Verification - Different country codes REJECTED even if last 10 digits match", () => {
  // Scanned from Baileys in India: 919876543210@s.whatsapp.net
  // Profile registered in US: +1 98765 43210
  assert.equal(
    verifyPhoneNumberMatch("919876543210@s.whatsapp.net", "+1 98765 43210"),
    false,
    "Cross-country matching must be strictly rejected"
  );

  // Scanned in US: 19876543210@s.whatsapp.net
  // Profile in UK: +44 19876543210
  assert.equal(
    verifyPhoneNumberMatch("19876543210@s.whatsapp.net", "+44 9876543210"),
    false,
    "UK number must not match US scanned number"
  );
});

test("Strict Phone Verification - 10-digit national number matches default country code", () => {
  assert.equal(
    verifyPhoneNumberMatch("919876543210@s.whatsapp.net", "9876543210"),
    true,
    "10-digit national number should match default 91 country code"
  );
});

test("Strict Phone Verification - Missing or invalid phone returns false", () => {
  assert.equal(verifyPhoneNumberMatch("", "+91 98765 43210"), false);
  assert.equal(verifyPhoneNumberMatch("919876543210@s.whatsapp.net", ""), false);
  assert.equal(verifyPhoneNumberMatch(null, null), false);
});

// ============================================================================
// 2. ADMIN VIEW-ONLY & REQUISITE AUTHORIZATION IN sendMessage
// ============================================================================
test("sendMessage - Admin is blocked (403) from sending to rep-owned lead regardless of request sessionId", async () => {
  const repUserId = new mongoose.Types.ObjectId().toString();
  const leadId = new mongoose.Types.ObjectId().toString();

  const mockLead = {
    _id: leadId,
    name: "Customer John",
    phone: "919999999999",
    assignedTo: repUserId,
  };

  const mockUser = {
    _id: repUserId,
    role: "sales person",
  };

  const req = {
    user: {
      _id: new mongoose.Types.ObjectId().toString(),
      role: "super_admin",
      organizationId: new mongoose.Types.ObjectId().toString(),
    },
    body: {
      leadId,
      text: "Hello from admin",
      // Admin attempts to omit or supply an org sessionId
      sessionId: "org_12345",
    },
    tenantModels: {
      Lead: {
        findById: () => ({
          lean: async () => mockLead,
        }),
      },
      User: {
        findById: () => ({
          select: () => ({
            lean: async () => mockUser,
          }),
        }),
      },
      Message: {
        findOne: () => ({
          select: () => ({
            lean: async () => null,
          }),
        }),
      },
    },
  };

  const res = createMockRes();
  await sendMessage(req, res);

  assert.equal(res.statusCode, 403, "Admin should receive 403 Forbidden");
  assert.match(res.data.message, /View-Only access/);
});

test("sendMessage - Sales Rep blocked (403) from sending to lead assigned to another rep", async () => {
  const repA_Id = new mongoose.Types.ObjectId().toString();
  const repB_Id = new mongoose.Types.ObjectId().toString();
  const leadId = new mongoose.Types.ObjectId().toString();

  const mockLead = {
    _id: leadId,
    name: "Customer Jane",
    phone: "918888888888",
    assignedTo: repB_Id, // Assigned to Rep B
  };

  const req = {
    user: {
      _id: repA_Id, // Logged in as Rep A
      name: "Rep A",
      role: "sales person",
      organizationId: new mongoose.Types.ObjectId().toString(),
    },
    body: {
      leadId,
      text: "Unauthorized message from Rep A",
    },
    tenantModels: {
      Lead: {
        findById: () => ({
          lean: async () => mockLead,
        }),
      },
      User: {
        findById: () => ({
          select: () => ({
            lean: async () => ({ role: "sales person" }),
          }),
        }),
      },
      Message: {
        findOne: () => ({
          select: () => ({
            lean: async () => null,
          }),
        }),
      },
    },
  };

  const res = createMockRes();
  await sendMessage(req, res);

  assert.equal(res.statusCode, 403, "Unassigned rep should receive 403 Forbidden");
  assert.match(res.data.message, /only authorized to send messages to leads assigned to you/);
});

// ============================================================================
// 3. CONVERSATION ISOLATION IN getConversations
// ============================================================================
test("getConversations - Sales Rep query tampering is completely ignored", async () => {
  const authRepId = new mongoose.Types.ObjectId().toString();
  const targetOtherRepId = new mongoose.Types.ObjectId().toString();

  let capturedPopulateOptions = null;

  const mockConversationModel = {
    find: () => ({
      populate: (options) => {
        capturedPopulateOptions = options;
        return {
          sort: () => Promise.resolve([]),
        };
      },
    }),
  };

  const req = {
    user: {
      _id: authRepId,
      name: "Alice Rep",
      role: "sales person",
    },
    // Malicious query tampering trying to request another rep's conversations
    query: {
      userId: targetOtherRepId,
      role: "super_admin",
      name: "Bob Manager",
    },
    tenantModels: {
      Conversation: mockConversationModel,
    },
  };

  const res = createMockRes();
  await getConversations(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(capturedPopulateOptions, "populateOptions should be captured");

  // Verify that match.assignedTo contains authRepId and NOT targetOtherRepId
  const matchValues = capturedPopulateOptions.match.assignedTo.$in.map(String);
  assert.ok(
    matchValues.includes(authRepId),
    "Must filter by authenticated rep's userId"
  );
  assert.ok(
    !matchValues.includes(targetOtherRepId),
    "Must NOT include tampered query userId"
  );
});

// ============================================================================
// 4. MESSAGE ACCESS CONTROL IN getMessages
// ============================================================================
test("getMessages - Sales Rep blocked (403) from accessing messages of unassigned lead", async () => {
  const authRepId = new mongoose.Types.ObjectId().toString();
  const otherRepId = new mongoose.Types.ObjectId().toString();
  const leadId = new mongoose.Types.ObjectId().toString();

  const req = {
    user: {
      _id: authRepId,
      name: "Alice Rep",
      role: "sales person",
    },
    params: { leadId },
    tenantModels: {
      Lead: {
        findById: () => ({
          select: () => ({
            lean: async () => ({
              _id: leadId,
              assignedTo: otherRepId,
            }),
          }),
        }),
      },
      Conversation: {
        findOneAndUpdate: async () => null,
      },
      Message: {
        find: () => ({
          sort: async () => [],
        }),
      },
    },
  };

  const res = createMockRes();
  await getMessages(req, res);

  assert.equal(res.statusCode, 403, "Unassigned rep should receive 403 Forbidden");
  assert.match(res.data.message, /not assigned to this conversation/);
});

test("getMessages - Non-existent lead returns 404", async () => {
  const req = {
    user: {
      _id: new mongoose.Types.ObjectId().toString(),
      role: "sales person",
    },
    params: { leadId: new mongoose.Types.ObjectId().toString() },
    tenantModels: {
      Lead: {
        findById: () => ({
          select: () => ({
            lean: async () => null,
          }),
        }),
      },
    },
  };

  const res = createMockRes();
  await getMessages(req, res);

  assert.equal(res.statusCode, 404);
  assert.match(res.data.message, /Lead not found/);
});

// ============================================================================
// 5. AI SUMMARY ACCESS CONTROL IN summarizeConversation
// ============================================================================
test("summarizeConversation - Sales Rep blocked (403) from summarizing unassigned lead", async () => {
  const authRepId = new mongoose.Types.ObjectId().toString();
  const otherRepId = new mongoose.Types.ObjectId().toString();
  const leadId = new mongoose.Types.ObjectId().toString();

  const req = {
    user: {
      _id: authRepId,
      name: "Alice Rep",
      role: "sales person",
    },
    params: { leadId },
    body: {},
    tenantModels: {
      Lead: {
        findById: () => ({
          select: () => ({
            lean: async () => ({
              _id: leadId,
              assignedTo: otherRepId,
            }),
          }),
        }),
      },
      Conversation: {},
    },
  };

  const res = createMockRes();
  await summarizeConversation(req, res);

  assert.equal(res.statusCode, 403, "Unassigned rep should receive 403 Forbidden");
  assert.match(res.data.message, /not authorized to summarize/);
});

// ============================================================================
// 6. QR ACCESS CONTROL IN getQR
// ============================================================================
test("getQR - Sales Rep blocked (403) from requesting other session IDs", async () => {
  const authRepId = new mongoose.Types.ObjectId().toString();
  const orgId = new mongoose.Types.ObjectId().toString();

  const req = {
    user: {
      _id: authRepId,
      role: "sales person",
      organizationId: orgId,
    },
    query: {
      // Rep maliciously tries to access org line QR
      sessionId: `org_${orgId}`,
    },
  };

  const res = createMockRes();
  await getQR(req, res);

  assert.equal(res.statusCode, 403, "Sales rep should receive 403 when requesting other session QR");
  assert.match(res.data.message, /only access their own WhatsApp session QR code/);
});

test("getQR - Admin blocked (403) from requesting a rep session QR code", async () => {
  const orgId = new mongoose.Types.ObjectId().toString();
  const repId = new mongoose.Types.ObjectId().toString();

  const req = {
    user: {
      _id: new mongoose.Types.ObjectId().toString(),
      role: "sales manager",
      organizationId: orgId,
    },
    query: {
      sessionId: `org_${orgId}_user_${repId}`,
    },
  };

  const res = createMockRes();
  await getQR(req, res);

  assert.equal(res.statusCode, 403, "Admin should receive 403 when requesting rep session QR");
  assert.match(res.data.message, /only generate QR codes for organization lines/);
});

// ============================================================================
// 7. SOCKET.IO AUTHENTICATION & ROOM AUTHORIZATION (PRODUCTION HANDLERS)
// ============================================================================
test("Socket.IO Security - Handshake rejects missing or invalid JWT", () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-xyz";

  // Test 1: Missing token
  let errorReceived = null;
  socketAuthMiddleware({ handshake: { auth: {}, headers: {} } }, (err) => {
    errorReceived = err;
  });
  assert.ok(errorReceived, "Should error on missing token");
  assert.match(errorReceived.message, /Token required/);

  // Test 2: Invalid token
  errorReceived = null;
  socketAuthMiddleware({ handshake: { auth: { token: "bad-token" }, headers: {} } }, (err) => {
    errorReceived = err;
  });
  assert.ok(errorReceived, "Should error on invalid token");
  assert.match(errorReceived.message, /Invalid or expired token/);

  // Test 3: Valid token
  errorReceived = null;
  const validToken = jwt.sign(
    { id: "user_123", role: "sales person", organizationId: "org_123" },
    process.env.JWT_SECRET
  );
  const mockSocket = { handshake: { auth: { token: validToken }, headers: {} } };
  socketAuthMiddleware(mockSocket, (err) => {
    errorReceived = err;
  });
  assert.equal(errorReceived, undefined, "Valid token should be accepted");
  assert.equal(mockSocket.user.id, "user_123");
});

test("Socket.IO Security - join_organization blocks cross-tenant access", () => {
  let joinedRooms = [];
  let emittedSecurityErrors = [];

  const mockSocket = {
    id: "sock_1",
    user: { id: "user_1", role: "sales person", organizationId: "org_alpha" },
    join(room) { joinedRooms.push(room); },
    emit(event, payload) { if (event === "security_error") emittedSecurityErrors.push(payload); },
  };

  // Attempt to join foreign organization room using production handler
  handleJoinOrganization(mockSocket, "org_beta");
  assert.equal(joinedRooms.length, 0, "Should NOT join foreign org room");
  assert.equal(emittedSecurityErrors.length, 1, "Should emit security_error");

  // Attempt to join own organization room using production handler
  handleJoinOrganization(mockSocket, "org_alpha");
  assert.equal(joinedRooms.includes("org_alpha"), true, "Should join own org room");
});

test("Socket.IO Security - join_lead_chat blocks unassigned sales rep", async () => {
  let joinedRooms = [];
  let emittedSecurityErrors = [];

  const mockLeadModel = {
    findById: (id) => ({
      select: () => ({
        lean: async () => ({ _id: id, assignedTo: "rep_2" }),
      }),
    }),
  };

  const mockSocket = {
    id: "sock_2",
    user: { id: "rep_1", role: "sales person" }, // Rep 1 attempting to join chat for Rep 2's lead
    join(room) { joinedRooms.push(room); },
    emit(event, payload) { if (event === "security_error") emittedSecurityErrors.push(payload); },
  };

  // Call actual production handleJoinLeadChat
  await handleJoinLeadChat(mockSocket, "lead_99", { LeadModel: mockLeadModel });
  assert.equal(joinedRooms.length, 0, "Rep 1 should not join Rep 2's lead room");
  assert.equal(emittedSecurityErrors.length, 1, "Should emit security_error");
});

test("Socket.IO Security - join_lead_chat blocks access when tenant LeadModel is unresolved", async () => {
  let joinedRooms = [];
  let emittedSecurityErrors = [];

  const mockSocket = {
    id: "sock_3",
    user: { id: "rep_1", role: "sales person" },
    join(room) { joinedRooms.push(room); },
    emit(event, payload) { if (event === "security_error") emittedSecurityErrors.push(payload); },
  };

  // When LeadModel is null/unresolved using production handleJoinLeadChat
  await handleJoinLeadChat(mockSocket, "lead_99", { LeadModel: null, tenantModels: null });
  assert.equal(joinedRooms.length, 0, "Must NOT join room when LeadModel is unresolved");
  assert.equal(emittedSecurityErrors.length, 1, "Must emit security_error");
  assert.match(emittedSecurityErrors[0].message, /Tenant context could not be resolved/);

  // When lead is not found using production handleJoinLeadChat
  const emptyLeadModel = {
    findById: () => ({
      select: () => ({
        lean: async () => null,
      }),
    }),
  };
  await handleJoinLeadChat(mockSocket, "lead_missing", { LeadModel: emptyLeadModel });
  assert.equal(joinedRooms.length, 0, "Must NOT join room when lead is missing");
  assert.equal(emittedSecurityErrors.length, 2, "Must emit security_error");
  assert.match(emittedSecurityErrors[1].message, /Lead not found/);
});

test("Socket.IO Security - handleJoinOrganization isolates sales reps from admin room", () => {
  // Test sales rep join
  const repRooms = [];
  const repSocket = {
    id: "sock_rep",
    user: { id: "rep_42", role: "sales person", organizationId: "org_test" },
    join(room) { repRooms.push(room); },
    emit() {},
  };
  handleJoinOrganization(repSocket, "org_test");
  assert.ok(repRooms.includes("org_test"), "Rep must join org_test");
  assert.ok(repRooms.includes("user_rep_42"), "Rep must join user_rep_42 private room");
  assert.ok(!repRooms.includes("org_test_admins"), "Rep must NEVER join admin leadership room");

  // Test manager join
  const mgrRooms = [];
  const mgrSocket = {
    id: "sock_mgr",
    user: { id: "mgr_1", role: "sales manager", organizationId: "org_test" },
    join(room) { mgrRooms.push(room); },
    emit() {},
  };
  handleJoinOrganization(mgrSocket, "org_test");
  assert.ok(mgrRooms.includes("org_test"), "Manager must join org_test");
  assert.ok(mgrRooms.includes("user_mgr_1"), "Manager must join user_mgr_1 private room");
  assert.ok(mgrRooms.includes("org_test_admins"), "Manager must join admin leadership room");
});

test("WhatsApp: getStatus resolves to disconnected when server restarted and DB is connecting", async () => {
  const mockSessionModel = {
    findOne: () => ({
      lean: async () => ({
        sessionId: "org_alpha_user_rep99",
        status: "connecting", // Stale DB status from before restart
      }),
    }),
    updateOne: async () => {},
  };

  const req = {
    user: {
      _id: "rep99",
      role: "sales person",
      organizationId: "alpha",
    },
    tenantModels: {
      WhatsAppSession: mockSessionModel,
    },
  };
  const res = createMockRes();
  await getStatus(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.sessions[0].status, "disconnected", "Must resolve to disconnected instead of stuck connecting");
});

test("WhatsApp: getQR retrieves rep personal session QR and does not fall back to org line", async () => {
  const mockSessionModel = {
    findOne: () => ({
      select: () => ({
        lean: async () => ({
          sessionId: "org_alpha_user_rep99",
          status: "qr",
          qrCode: "data:image/png;base64,mockrepqr123",
        }),
      }),
    }),
  };

  const req = {
    user: {
      _id: "rep99",
      role: "sales person",
      organizationId: "alpha",
    },
    query: {
      sessionId: "org_alpha_user_rep99",
    },
    tenantModels: {
      WhatsAppSession: mockSessionModel,
    },
  };
  const res = createMockRes();
  await getQR(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.sessionId, "org_alpha_user_rep99");
  assert.equal(res.data.qrCode, "data:image/png;base64,mockrepqr123");
});


