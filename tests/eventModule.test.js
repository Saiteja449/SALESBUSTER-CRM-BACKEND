import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createEventSchema,
  updateEventSchema,
  createEventContactSchema,
  updateEventContactStatusSchema,
} from "../schemas/eventSchemas.js";
import {
  queryEventsService,
  createEventService,
  getEventByIdService,
  updateEventContactStatusService,
  deleteEventService,
} from "../services/eventService.js";
import { NotFoundError } from "../utils/AppError.js";

describe("Event Module - Zod Validation Schemas", () => {
  it("createEventSchema accepts valid event payload and rejects empty name", () => {
    const valid = createEventSchema.safeParse({
      body: {
        name: "Tech Expo 2026",
        venue: "HITEX Hyderabad",
        status: "active",
      },
    });
    assert.equal(valid.success, true);
    assert.equal(valid.data.body.name, "Tech Expo 2026");

    const invalid = createEventSchema.safeParse({
      body: {
        name: "",
      },
    });
    assert.equal(invalid.success, false);
  });

  it("createEventContactSchema requires contact name", () => {
    const valid = createEventContactSchema.safeParse({
      params: { id: "ev_101" },
      body: {
        name: "Vikram Malhotra",
        phone: "+919876543210",
        companyName: "Innovate AI",
        designation: "CEO",
      },
    });
    assert.equal(valid.success, true);

    const invalid = createEventContactSchema.safeParse({
      params: { id: "ev_101" },
      body: {
        phone: "+919876543210",
      },
    });
    assert.equal(invalid.success, false);
  });

  it("updateEventContactStatusSchema accepts supported status enum values", () => {
    const valid = updateEventContactStatusSchema.safeParse({
      params: { id: "ev_101", contactId: "c_1" },
      body: { status: "whatsapp_opened" },
    });
    assert.equal(valid.success, true);

    const invalid = updateEventContactStatusSchema.safeParse({
      params: { id: "ev_101", contactId: "c_1" },
      body: { status: "unknown_status" },
    });
    assert.equal(invalid.success, false);
  });
});

describe("Event Module - Business Service Layer", () => {
  it("queryEventsService calculates aggregated contact stats for each event", async () => {
    const mockEvents = [
      { _id: "ev_1", name: "Global SaaS Summit", venue: "Bengaluru", status: "active" },
    ];
    const mockCounts = [
      { _id: "ev_1", totalCaptured: 15, whatsappSentCount: 8 },
    ];

    const mockTenantModels = {
      Event: {
        find: () => ({
          sort: () => ({
            lean: () => Promise.resolve(mockEvents),
          }),
        }),
      },
      EventContact: {
        aggregate: async () => mockCounts,
      },
    };

    const result = await queryEventsService({
      tenantModels: mockTenantModels,
      status: "active",
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].stats.totalCaptured, 15);
    assert.equal(result[0].stats.whatsappSentCount, 8);
  });

  it("createEventService creates event with sanitized attachments and defaults", async () => {
    let createdEvent = null;

    const mockTenantModels = {
      Event: {
        create: async (data) => {
          createdEvent = { ...data, _id: "ev_new_1" };
          return createdEvent;
        },
      },
    };

    const res = await createEventService({
      tenantModels: mockTenantModels,
      data: {
        name: "Auto Expo 2026",
        venue: "New Delhi",
        time: "10:00 AM",
      },
      user: { id: "user_manager_1", name: "Manager Mike" },
      organizationId: "org_alpha_9",
    });

    assert.ok(res);
    assert.equal(res.name, "Auto Expo 2026");
    assert.equal(res.organizationId, "org_alpha_9");
    assert.equal(res.createdByName, "Manager Mike");
  });

  it("getEventByIdService returns event details or throws NotFoundError", async () => {
    const mockEvent = { _id: "ev_200", name: "Design Week", venue: "Mumbai" };

    const mockTenantModels = {
      Event: {
        findById: (id) => ({
          lean: () => Promise.resolve(id === "ev_200" ? mockEvent : null),
        }),
      },
      EventContact: {
        aggregate: async () => [{ _id: "ev_200", totalCaptured: 3, whatsappSentCount: 2 }],
      },
    };

    const event = await getEventByIdService({
      tenantModels: mockTenantModels,
      eventId: "ev_200",
    });

    assert.equal(event.name, "Design Week");
    assert.equal(event.stats.totalCaptured, 3);

    await assert.rejects(
      async () => {
        await getEventByIdService({
          tenantModels: mockTenantModels,
          eventId: "non_existent_event",
        });
      },
      (err) => err instanceof NotFoundError
    );
  });

  it("updateEventContactStatusService updates status or throws NotFoundError", async () => {
    let saved = false;
    const mockContact = {
      _id: "c_99",
      eventId: "ev_200",
      status: "captured",
      save: async function () {
        saved = true;
        return this;
      },
    };

    const mockTenantModels = {
      EventContact: {
        findOne: async (q) => (q._id === "c_99" && q.eventId === "ev_200" ? mockContact : null),
      },
    };

    const updated = await updateEventContactStatusService({
      tenantModels: mockTenantModels,
      eventId: "ev_200",
      contactId: "c_99",
      status: "completed",
    });

    assert.equal(updated.status, "completed");
    assert.equal(saved, true);

    await assert.rejects(
      async () => {
        await updateEventContactStatusService({
          tenantModels: mockTenantModels,
          eventId: "ev_200",
          contactId: "c_unknown",
          status: "completed",
        });
      },
      (err) => err instanceof NotFoundError
    );
  });

  it("deleteEventService deletes event and cascades associated EventContact deletion", async () => {
    let deletedEvent = false;
    let deletedContactsEventId = null;

    const mockEventDoc = {
      _id: "ev_to_delete",
      deleteOne: async () => {
        deletedEvent = true;
      },
    };

    const mockTenantModels = {
      Event: {
        findById: async (id) => (id === "ev_to_delete" ? mockEventDoc : null),
      },
      EventContact: {
        deleteMany: async (filter) => {
          deletedContactsEventId = filter.eventId;
        },
      },
    };

    const res = await deleteEventService({
      tenantModels: mockTenantModels,
      eventId: "ev_to_delete",
    });

    assert.equal(res.deleted, true);
    assert.equal(deletedEvent, true);
    assert.equal(deletedContactsEventId, "ev_to_delete");
  });

  it("createEventService allows guest accounts to create and manage events", async () => {
    let createdEvent = null;
    const mockTenantModels = {
      Event: {
        create: async (data) => {
          createdEvent = { ...data, _id: "ev_guest_99" };
          return createdEvent;
        },
      },
    };

    const res = await createEventService({
      tenantModels: mockTenantModels,
      data: {
        name: "Conference Networking Expo",
        venue: "Hyderabad HITEX",
      },
      user: { id: "guest_user_1", name: "Guest User", accountType: "guest" },
      organizationId: "org_guest_1",
    });

    assert.ok(res);
    assert.equal(res.name, "Conference Networking Expo");
    assert.equal(res.organizationId, "org_guest_1");
  });
});
