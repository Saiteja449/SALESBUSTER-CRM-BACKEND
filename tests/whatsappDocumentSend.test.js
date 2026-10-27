import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import fs from "fs";
import { sendDocumentMessage } from "../controllers/whatsappController.js";
import { sendDocumentMessageFromCRM } from "../whatsapp/whatsappService.js";

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
// 1. INPUT VALIDATION TESTS
// ============================================================================
test("sendDocumentMessage: Rejects request missing document file and fileUrl", async () => {
  const req = {
    headers: { "x-webhook-secret": "test-key" },
    body: { phone: "9876543210", caption: "Check our brochure" },
  };
  const res = createMockRes();

  await sendDocumentMessage(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.data.success, false);
  assert.match(res.data.message, /document file/i);
});

test("sendDocumentMessage: Rejects request missing recipient phone and leadId", async () => {
  const req = {
    headers: { "x-webhook-secret": "test-key" },
    file: {
      path: "uploads/documents/sample.pdf",
      originalname: "sample.pdf",
      mimetype: "application/pdf",
      filename: "doc-sample.pdf",
    },
    body: { caption: "Check our brochure" },
  };
  const res = createMockRes();

  await sendDocumentMessage(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.data.success, false);
  assert.match(res.data.message, /recipient phone number or leadId/i);
});

test("sendDocumentMessage: Rejects request with missing organization credentials", async () => {
  const req = {
    headers: {},
    file: {
      path: "uploads/documents/sample.pdf",
      originalname: "sample.pdf",
      mimetype: "application/pdf",
      filename: "doc-sample.pdf",
    },
    body: { phone: "9876543210", caption: "Check our brochure" },
  };
  const res = createMockRes();

  await sendDocumentMessage(req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.data.success, false);
  assert.match(res.data.message, /Organization authentication required/i);
});

// ============================================================================
// 2. LEAD LOOKUP / CREATION & DOCUMENT MESSAGE PERSISTENCE IN SERVICE
// ============================================================================
test("sendDocumentMessageFromCRM: Finds existing lead or creates new lead, formats JID, and records message", async () => {
  let createdMessage = null;
  let updatedConversation = null;
  let createdLead = null;

  const mockExistingLead = {
    _id: "654321654321654321654321",
    name: "John Doe",
    phone: "9876543210",
    aiEnabled: false,
    organizationId: "org_alpha_123",
  };

  const mockLeadModel = {
    findById: async (id) => (id === mockExistingLead._id ? mockExistingLead : null),
    findOne: async (query) => mockExistingLead,
    create: async (data) => {
      createdLead = { ...data, _id: "new_lead_999" };
      return createdLead;
    },
  };

  const mockMessageModel = {
    create: async (data) => {
      createdMessage = data;
      return { ...data, _id: "msg_record_111" };
    },
  };

  const mockConversationModel = {
    findOneAndUpdate: async (filter, update) => {
      updatedConversation = { filter, update };
      return updatedConversation;
    },
  };

  // Create temporary test file for buffer reading
  const tempDir = path.resolve(process.cwd(), "scratch");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const tempFilePath = path.join(tempDir, "test_brochure.pdf");
  fs.writeFileSync(tempFilePath, "%PDF-1.4 test dummy content");

  // Mock socket
  let sentSockData = null;
  const mockSock = {
    sendMessage: async (jid, payload) => {
      sentSockData = { jid, payload };
      return { key: { id: "mock_msg_xyz_123" } };
    },
  };

  // Mock sessions map in memory test context
  const mockContext = {
    organizationId: "org_alpha_123",
    sessionId: "org_alpha_123",
    tenantModels: {
      Lead: mockLeadModel,
      Message: mockMessageModel,
      Conversation: mockConversationModel,
    },
  };

  // Test documentData
  const documentData = {
    filePath: tempFilePath,
    fileName: "Company_Brochure.pdf",
    mimetype: "application/pdf",
    mediaUrl: "/uploads/documents/Company_Brochure.pdf",
  };

  try {
    // We test with a mock session injected into the module's exported sessions
    const { sessions } = await import("../whatsapp/whatsappService.js");
    sessions["org_alpha_123"] = {
      sock: mockSock,
      organizationId: "org_alpha_123",
      status: "connected",
    };

    const result = await sendDocumentMessageFromCRM(
      "9876543210",
      documentData,
      "Please review our corporate profile attached.",
      "Support Team",
      mockContext
    );

    assert.ok(result);
    assert.equal(sentSockData.jid, "919876543210@s.whatsapp.net");
    assert.equal(sentSockData.payload.fileName, "Company_Brochure.pdf");
    assert.equal(sentSockData.payload.mimetype, "application/pdf");
    assert.equal(sentSockData.payload.caption, "Please review our corporate profile attached.");

    assert.equal(createdMessage.messageType, "document");
    assert.equal(createdMessage.fileName, "Company_Brochure.pdf");
    assert.equal(createdMessage.text, "Please review our corporate profile attached.");
    assert.equal(createdMessage.mediaUrl, "/uploads/documents/Company_Brochure.pdf");
    assert.equal(createdMessage.direction, "outgoing");

    assert.ok(updatedConversation);
    assert.match(updatedConversation.update.lastMessage, /Company_Brochure\.pdf/);

    delete sessions["org_alpha_123"];
  } finally {
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
  }
});

test("sendDocumentMessageFromCRM: Supports Word DOCX mimetype mapping", async () => {
  const tempDir = path.resolve(process.cwd(), "scratch");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const tempWordPath = path.join(tempDir, "Proposal.docx");
  fs.writeFileSync(tempWordPath, "PK dummy word document content");

  let sentSockData = null;
  const mockSock = {
    sendMessage: async (jid, payload) => {
      sentSockData = { jid, payload };
      return { key: { id: "mock_docx_999" } };
    },
  };

  const mockLead = {
    _id: "lead_docx_123",
    name: "Jane Smith",
    phone: "9123456789",
    aiEnabled: false,
    organizationId: "org_beta_456",
  };

  const mockContext = {
    organizationId: "org_beta_456",
    sessionId: "org_beta_456",
    tenantModels: {
      Lead: {
        findById: async () => mockLead,
        findOne: async () => mockLead,
      },
      Message: {
        create: async (data) => data,
      },
      Conversation: {
        findOneAndUpdate: async () => ({}),
      },
    },
  };

  const documentData = {
    filePath: tempWordPath,
    fileName: "Proposal_Final.docx",
  };

  try {
    const { sessions } = await import("../whatsapp/whatsappService.js");
    sessions["org_beta_456"] = {
      sock: mockSock,
      organizationId: "org_beta_456",
      status: "connected",
    };

    await sendDocumentMessageFromCRM(
      "9123456789",
      documentData,
      "Here is the finalized commercial agreement.",
      "Executive",
      mockContext
    );

    assert.equal(
      sentSockData.payload.mimetype,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    assert.equal(sentSockData.payload.fileName, "Proposal_Final.docx");
    assert.equal(sentSockData.payload.caption, "Here is the finalized commercial agreement.");

    delete sessions["org_beta_456"];
  } finally {
    if (fs.existsSync(tempWordPath)) fs.unlinkSync(tempWordPath);
  }
});
