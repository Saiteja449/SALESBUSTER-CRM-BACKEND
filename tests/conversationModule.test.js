import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  queryConversationsSchema,
  confirmContactSchema,
} from "../schemas/conversationSchemas.js";
import {
  queryCapturedConversationsService,
  getConversationByIdService,
  confirmConversationContactService,
} from "../services/conversationService.js";
import { NotFoundError } from "../utils/AppError.js";

describe("Conversation Module - Zod Validation Schemas", () => {
  it("queryConversationsSchema parses valid page and limit numbers", () => {
    const valid = queryConversationsSchema.safeParse({
      query: { page: "2", limit: "15" },
    });
    assert.equal(valid.success, true);
    assert.equal(valid.data.query.page, "2");
    assert.equal(valid.data.query.limit, "15");
  });

  it("confirmContactSchema validates id parameter and contact body", () => {
    const valid = confirmContactSchema.safeParse({
      params: { id: "sess_capture_001" },
      body: {
        name: "Jane Smith",
        phone: "+919876543210",
        company: "NextGen Tech",
        designation: "CTO",
      },
    });
    assert.equal(valid.success, true);
  });
});

describe("Conversation Module - Business Service Layer", () => {
  it("queryCapturedConversationsService applies tenant scoping and user isolation for reps", async () => {
    const mockConversations = [
      { _id: "c_1", sessionId: "sess_1", userId: "user_rep_1", customerName: "Prospect A" },
    ];
    let capturedQuery = null;

    const mockTenantModels = {
      Conversation: {
        find: (query) => {
          capturedQuery = query;
          return {
            sort: () => ({
              skip: () => ({
                limit: () => ({
                  select: () => ({
                    lean: () => Promise.resolve(mockConversations),
                  }),
                }),
              }),
            }),
          };
        },
        countDocuments: async () => 1,
      },
    };

    const result = await queryCapturedConversationsService({
      tenantModels: mockTenantModels,
      user: { id: "user_rep_1", role: "sales person" },
      organizationId: "org_test_100",
      query: { page: "1", limit: "10" },
    });

    assert.equal(result.conversations.length, 1);
    assert.equal(result.total, 1);
    assert.equal(capturedQuery.organizationId, "org_test_100");
    assert.equal(capturedQuery.userId, "user_rep_1");
  });

  it("getConversationByIdService fetches conversation or throws NotFoundError", async () => {
    const mockDoc = { _id: "c_valid_1", sessionId: "sess_ok_100", originalTranscript: "Meeting notes" };

    const mockTenantModels = {
      Conversation: {
        findOne: (filter) => ({
          lean: () => {
            const matches = filter.$or.some((c) => c.sessionId === "sess_ok_100" || c._id === "sess_ok_100");
            return Promise.resolve(matches ? mockDoc : null);
          },
        }),
      },
    };

    const doc = await getConversationByIdService({
      tenantModels: mockTenantModels,
      id: "sess_ok_100",
    });
    assert.equal(doc.sessionId, "sess_ok_100");

    await assert.rejects(
      async () => {
        await getConversationByIdService({
          tenantModels: mockTenantModels,
          id: "unknown_session",
        });
      },
      (err) => err instanceof NotFoundError
    );
  });

  it("confirmConversationContactService updates extracted details and creates EventContact", async () => {
    let saved = false;
    let createdEventContact = null;

    const mockConvDoc = {
      _id: "conv_target_1",
      sessionId: "sess_target_1",
      eventId: "event_expo_2026",
      extractedContact: {
        name: { value: "Old Name" },
        phone: { value: "1111111111" },
        company: { value: "Old Co" },
        designation: { value: "Executive" },
      },
      summary: { keyDiscussion: "Discussed software licenses" },
      originalTranscript: "Raw audio transcript",
      save: async function () {
        saved = true;
        return this;
      },
    };

    const mockTenantModels = {
      Conversation: {
        findOne: async () => mockConvDoc,
      },
      EventContact: {
        create: async (data) => {
          createdEventContact = { ...data, _id: "ec_999" };
          return createdEventContact;
        },
      },
    };

    const res = await confirmConversationContactService({
      tenantModels: mockTenantModels,
      id: "sess_target_1",
      contactData: {
        name: "Verified Name",
        phone: "9876543210",
        company: "Verified Corp",
        designation: "VP",
        createEventContactRecord: true,
      },
      user: { id: "rep_agent_1", name: "Agent Smith" },
    });

    assert.equal(saved, true);
    assert.equal(res.conversation.extractedContact.name.value, "Verified Name");
    assert.equal(res.conversation.extractedContact.confirmationStatus, "confirmed");
    assert.ok(createdEventContact);
    assert.equal(createdEventContact.name, "Verified Name");
    assert.equal(createdEventContact.capturedByName, "Agent Smith");
  });
});
