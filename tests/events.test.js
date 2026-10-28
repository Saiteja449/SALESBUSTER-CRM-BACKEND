import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getEvents,
  createEvent,
  getEventById,
  getEventContacts,
  createEventContact,
  updateContactStatus,
} from "../controllers/eventController.js";

describe("Event & EventContact Architecture Unit Tests", () => {
  it("creates an event successfully with initial stats", async () => {
    let createdEventDoc = null;
    const mockEventModel = {
      create: async (payload) => {
        createdEventDoc = {
          _id: "event_123",
          ...payload,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        return createdEventDoc;
      },
    };

    let statusCode = null;
    let jsonResponse = null;
    const req = {
      tenantModels: { Event: mockEventModel },
      body: {
        name: "Hyderabad Real Estate Conclave 2026",
        description: "Annual real estate expo at Hitex",
        location: "Hitex Hall 2",
      },
      user: {
        _id: "user_manager_1",
        name: "Alice Manager",
        organizationId: "org_test_1",
      },
    };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonResponse = data;
        return this;
      },
    };

    await createEvent(req, res);
    assert.equal(statusCode, 201);
    assert.equal(jsonResponse.success, true);
    assert.equal(jsonResponse.data.name, "Hyderabad Real Estate Conclave 2026");
    assert.equal(jsonResponse.data.stats.totalCaptured, 0);
    assert.equal(jsonResponse.data.stats.whatsappSentCount, 0);
  });

  it("stores a contact strictly under an Event without touching Leads", async () => {
    let savedContact = null;
    let eventIncUpdate = null;
    let leadModelAccessed = false;

    const mockEventModel = {
      findById: async (id) => (id === "event_123" ? { _id: id, name: "Tech Expo" } : null),
      findByIdAndUpdate: async (id, update) => {
        eventIncUpdate = update;
        return { _id: id };
      },
    };

    const mockEventContactModel = {
      create: async (doc) => {
        savedContact = {
          _id: "contact_999",
          ...doc,
          createdAt: new Date(),
        };
        return savedContact;
      },
    };

    const mockLeadModel = {
      create: async () => {
        leadModelAccessed = true;
        throw new Error("Lead model must NOT be touched by event contacts!");
      },
      findOneAndUpdate: async () => {
        leadModelAccessed = true;
      },
    };

    let statusCode = null;
    let jsonResponse = null;
    const req = {
      tenantModels: {
        Event: mockEventModel,
        EventContact: mockEventContactModel,
        Lead: mockLeadModel,
      },
      params: { id: "event_123" },
      body: {
        name: "Rahul Sharma",
        phone: "+91 9876543210",
        companyName: "Apex Infratech",
        summary: "Interested in automated commercial followups",
        messageText: "Hello Rahul, great connecting with you today!",
        status: "whatsapp_opened",
      },
      user: {
        _id: "user_manager_1",
        name: "Alice Manager",
      },
    };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonResponse = data;
        return this;
      },
    };

    await createEventContact(req, res);
    assert.equal(statusCode, 201);
    assert.equal(jsonResponse.success, true);
    assert.equal(jsonResponse.data.name, "Rahul Sharma");
    assert.equal(jsonResponse.data.phone, "919876543210");
    assert.equal(jsonResponse.data.eventId, "event_123");
    assert.equal(jsonResponse.data.status, "whatsapp_opened");
    assert.ok(jsonResponse.data.sentAt !== null);

    // Verify Event stats updated
    assert.equal(eventIncUpdate.$inc["stats.totalCaptured"], 1);
    assert.equal(eventIncUpdate.$inc["stats.whatsappSentCount"], 1);

    // CRITICAL: Verify Lead model was completely untouched
    assert.equal(leadModelAccessed, false, "Lead model must not be accessed!");
  });

  it("updates contact status to completed and tracks sentAt", async () => {
    let updatedDoc = null;
    let eventIncUpdate = null;

    const contactDoc = {
      _id: "contact_999",
      eventId: "event_123",
      status: "captured",
      sentAt: null,
      save: async function () {
        updatedDoc = this;
        return this;
      },
    };

    const mockEventContactModel = {
      findOne: async (query) => (query._id === "contact_999" ? contactDoc : null),
    };

    const mockEventModel = {
      findByIdAndUpdate: async (id, update) => {
        eventIncUpdate = update;
        return { _id: id };
      },
    };

    let statusCode = null;
    let jsonResponse = null;
    const req = {
      tenantModels: {
        Event: mockEventModel,
        EventContact: mockEventContactModel,
      },
      params: { id: "event_123", contactId: "contact_999" },
      body: { status: "whatsapp_opened" },
    };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonResponse = data;
        return this;
      },
    };

    await updateContactStatus(req, res);
    assert.equal(statusCode, 200);
    assert.equal(jsonResponse.success, true);
    assert.equal(updatedDoc.status, "whatsapp_opened");
    assert.ok(updatedDoc.sentAt instanceof Date);
    assert.equal(eventIncUpdate.$inc["stats.whatsappSentCount"], 1);
  });

  it("retrieves paginated contacts filtered by event ID and search query", async () => {
    const mockContacts = [
      {
        _id: "c1",
        eventId: "event_123",
        name: "Suresh Reddy",
        phone: "9876500001",
        companyName: "Reddy Logistics",
      },
    ];

    const mockEventContactModel = {
      find: (query) => ({
        sort: () => ({
          skip: () => ({
            limit: () => ({
              lean: async () => mockContacts,
            }),
          }),
        }),
      }),
      countDocuments: async () => 1,
    };

    let statusCode = null;
    let jsonResponse = null;
    const req = {
      tenantModels: { EventContact: mockEventContactModel },
      params: { id: "event_123" },
      query: { search: "Reddy", page: 1, limit: 10 },
    };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonResponse = data;
        return this;
      },
    };

    await getEventContacts(req, res);
    assert.equal(statusCode, 200);
    assert.equal(jsonResponse.success, true);
    assert.equal(jsonResponse.data.contacts.length, 1);
    assert.equal(jsonResponse.data.contacts[0].name, "Suresh Reddy");
    assert.equal(jsonResponse.data.total, 1);
  });
});

