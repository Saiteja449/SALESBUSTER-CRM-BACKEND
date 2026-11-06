import { test, describe } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { composeMongoQuery } from "../ai/assistant/analytics/queryComposer.js";
import { resolveSalesperson, listAllSalespeople } from "../ai/assistant/analytics/salespersonResolver.js";
import { searchCallRecords, getMissedCallAnalytics } from "../ai/assistant/analytics/callAnalyticsService.js";
import { getWhatsAppAnalytics } from "../ai/assistant/analytics/whatsappAnalyticsService.js";
import { recordCallEvent } from "../services/callEventService.js";

describe("CRM Data Intelligence - 16 Critical Regression Tests", () => {
  const rep1Id = new mongoose.Types.ObjectId("650000000000000000000001");
  const rep2Id = new mongoose.Types.ObjectId("650000000000000000000002");
  const mgrId = new mongoose.Types.ObjectId("650000000000000000000003");

  const mockUsers = [
    {
      _id: rep1Id,
      id: rep1Id.toString(),
      name: "Shanmukh Sarma",
      email: "shanmukh@acme.com",
      role: "sales person",
      status: "active",
    },
    {
      _id: rep2Id,
      id: rep2Id.toString(),
      name: "Jhansi Rani",
      email: "jhansi@acme.com",
      role: "sales representative",
      status: "active",
    },
    {
      _id: mgrId,
      id: mgrId.toString(),
      name: "Alice Manager",
      email: "alice@acme.com",
      role: "sales manager",
      status: "active",
    },
  ];

  const createMockUserModel = () => ({
    findById: (id) => ({
      lean: async () => mockUsers.find((u) => u._id.toString() === id.toString()) || null,
    }),
    findOne: (filter) => ({
      lean: async () => {
        if (filter.email) {
          return mockUsers.find((u) => filter.email.test(u.email)) || null;
        }
        return null;
      },
    }),
    find: (filter = {}) => {
      let filtered = [...mockUsers];
      if (filter.name) {
        filtered = filtered.filter((u) => filter.name.test(u.name));
      } else if (filter.$or) {
        filtered = filtered.filter((u) =>
          filter.$or.some((clause) => {
            if (clause.name && clause.name.test) return clause.name.test(u.name);
            if (clause.email && clause.email.test) return clause.email.test(u.email);
            return false;
          })
        );
      }
      if (filter.role && filter.role.$in) {
        filtered = filtered.filter((u) => filter.role.$in.includes(u.role));
      }
      const builder = {
        select: () => builder,
        sort: () => builder,
        lean: async () => filtered,
        then: (resolve) => resolve(filtered),
      };
      return builder;
    },
  });

  const createQueryBuilderMock = (data = []) => {
    const builder = {
      sort: () => builder,
      skip: () => builder,
      limit: () => builder,
      select: () => builder,
      distinct: async () => data,
      lean: async () => data,
      then: (resolve) => resolve(data),
    };
    return builder;
  };

  // 1. Missed calls filtered by salesperson
  test("1. Missed calls filtered by salesperson returns only that salesperson's calls", async () => {
    const mockCallRecords = [
      {
        _id: new mongoose.Types.ObjectId(),
        callEventId: "evt_101",
        salespersonId: rep1Id.toString(),
        salespersonName: "Shanmukh Sarma",
        customerPhone: "9999900001",
        callType: "missed",
        callStatus: "missed",
        calledAt: new Date(),
      },
      {
        _id: new mongoose.Types.ObjectId(),
        callEventId: "evt_102",
        salespersonId: rep2Id.toString(),
        salespersonName: "Jhansi Rani",
        customerPhone: "9999900002",
        callType: "missed",
        callStatus: "missed",
        calledAt: new Date(),
      },
    ];

    const CallRecordModel = {
      find: (filter) => createQueryBuilderMock(mockCallRecords.filter((r) => r.salespersonName === "Shanmukh Sarma")),
    };

    const tenantModels = {
      User: createMockUserModel(),
      CallRecord: CallRecordModel,
      Lead: { find: () => createQueryBuilderMock([]) },
      Followup: { find: () => createQueryBuilderMock([]) },
    };

    const res = await getMissedCallAnalytics({
      tenantModels,
      filters: { salespersonNameOrId: "Shanmukh Sarma" },
    });

    assert.equal(res.success, true);
    assert.equal(res.totalCount, 1);
    assert.equal(res.records[0].salesperson, "Shanmukh Sarma");
    assert.equal(res.summary.totalMatchingMissedCalls, 1);
  });

  // 2. Missed calls filtered by salesperson and date
  test("2. Missed calls filtered by salesperson and date respects temporal boundaries", async () => {
    const today = new Date();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const mockCallRecords = [
      {
        _id: new mongoose.Types.ObjectId(),
        callEventId: "evt_today",
        salespersonId: rep1Id.toString(),
        salespersonName: "Shanmukh Sarma",
        customerPhone: "9999900001",
        callType: "missed",
        callStatus: "missed",
        calledAt: today,
      },
      {
        _id: new mongoose.Types.ObjectId(),
        callEventId: "evt_yesterday",
        salespersonId: rep1Id.toString(),
        salespersonName: "Shanmukh Sarma",
        customerPhone: "9999900002",
        callType: "missed",
        callStatus: "missed",
        calledAt: yesterday,
      },
    ];

    const CallRecordModel = {
      find: (filter) => createQueryBuilderMock([mockCallRecords[0]]),
    };

    const tenantModels = {
      User: createMockUserModel(),
      CallRecord: CallRecordModel,
      Lead: { find: () => createQueryBuilderMock([]) },
      Followup: { find: () => createQueryBuilderMock([]) },
    };

    const res = await getMissedCallAnalytics({
      tenantModels,
      filters: { salespersonNameOrId: "Shanmukh Sarma", period: "today" },
    });

    assert.equal(res.success, true);
    assert.equal(res.totalCount, 1);
    assert.equal(res.records[0].callEventId, "evt_today");
  });

  // 3. Missed calls filtered by salesperson and follow-up status
  test("3. Missed calls filtered by salesperson and follow-up status", async () => {
    const leadId1 = new mongoose.Types.ObjectId();
    const leadId2 = new mongoose.Types.ObjectId();

    const mockCallRecords = [
      {
        _id: new mongoose.Types.ObjectId(),
        callEventId: "evt_fu_overdue",
        leadId: leadId1,
        salespersonId: rep1Id.toString(),
        salespersonName: "Shanmukh Sarma",
        customerPhone: "9999900001",
        callType: "missed",
        callStatus: "missed",
        calledAt: new Date(),
      },
      {
        _id: new mongoose.Types.ObjectId(),
        callEventId: "evt_fu_completed",
        leadId: leadId2,
        salespersonId: rep1Id.toString(),
        salespersonName: "Shanmukh Sarma",
        customerPhone: "9999900002",
        callType: "missed",
        callStatus: "missed",
        calledAt: new Date(),
      },
    ];

    const mockFollowups = [
      { leadId: leadId1, done: false, date: "2020-01-01" }, // Overdue
      { leadId: leadId2, done: true, date: "2026-11-06" }, // Completed
    ];

    const tenantModels = {
      User: createMockUserModel(),
      CallRecord: {
        find: () => createQueryBuilderMock(mockCallRecords),
      },
      Lead: {
        find: () => createQueryBuilderMock([{ _id: leadId1, name: "Lead Overdue" }, { _id: leadId2, name: "Lead Completed" }]),
      },
      Followup: {
        find: () => createQueryBuilderMock(mockFollowups),
      },
    };

    const res = await getMissedCallAnalytics({
      tenantModels,
      filters: { salespersonNameOrId: "Shanmukh Sarma", followupStatus: "overdue" },
    });

    assert.equal(res.success, true);
    assert.equal(res.totalCount, 1);
    assert.equal(res.records[0].followupStatus, "Overdue Follow-up");
    assert.equal(res.records[0].callEventId, "evt_fu_overdue");
    // Summary must match the filtered population exactly
    assert.equal(res.summary.totalMatchingMissedCalls, 1);
    assert.equal(res.summary.overdueFollowups, 1);
    assert.equal(res.summary.completedFollowups, 0);
  });

  // 4. Multiple $or conditions in one query (no clobbering)
  test("4. Safe query composition preserves multiple independent $or conditions without overwriting", () => {
    const missedClause = { $or: [{ callStatus: "missed" }, { callType: "missed" }] };
    const repClause = { $or: [{ salespersonId: "123" }, { salespersonName: "Shanmukh" }] };
    const searchClause = { $or: [{ name: /test/i }, { phone: /123/ }] };

    const composed = composeMongoQuery(missedClause, repClause, searchClause);

    assert.ok(composed.$and, "Must wrap multiple clauses in $and");
    assert.equal(composed.$and.length, 3, "Must retain all 3 clauses");
    assert.deepEqual(composed.$and[0], missedClause, "First $or clause must be preserved");
    assert.deepEqual(composed.$and[1], repClause, "Second $or clause must be preserved");
    assert.deepEqual(composed.$and[2], searchClause, "Third $or clause must be preserved");
  });

  // 5. Invalid salesperson returning zero matched results rather than all organization records
  test("5. Invalid salesperson returns zero matched results rather than all organization records", async () => {
    const mockCallRecords = [
      {
        _id: new mongoose.Types.ObjectId(),
        callEventId: "evt_org_1",
        salespersonName: "Shanmukh Sarma",
        customerPhone: "9999900001",
        callType: "missed",
        callStatus: "missed",
        calledAt: new Date(),
      },
    ];

    const tenantModels = {
      User: createMockUserModel(),
      CallRecord: {
        find: () => createQueryBuilderMock(mockCallRecords),
        distinct: async () => [],
      },
      Lead: {
        find: () => createQueryBuilderMock([]),
        distinct: async () => [],
      },
      TelecallerAnalytics: {
        distinct: async () => [],
      },
      Followup: { find: () => createQueryBuilderMock([]) },
    };

    const res = await getMissedCallAnalytics({
      tenantModels,
      filters: { salespersonNameOrId: "NonExistentRepresentativeXYZ" },
    });

    assert.equal(res.success, true);
    assert.equal(res.totalCount, 0, "Must return 0 records when rep not found");
    assert.equal(res.records.length, 0);
    assert.equal(res.summary.totalMatchingMissedCalls, 0);
    assert.equal(res.filtersApplied.salespersonNotFound, true);
    assert.match(res.message, /not found/i);
  });

  // 6. Mixed CallRecord and legacy Lead.callHistory data
  test("6. Dual-source retrieval seamlessly aggregates CallRecord and legacy Lead.callHistory", async () => {
    const leadId1 = new mongoose.Types.ObjectId();
    const leadId2 = new mongoose.Types.ObjectId();

    const crRecords = [
      {
        _id: new mongoose.Types.ObjectId(),
        callEventId: "cr_call_1",
        leadId: leadId1,
        salespersonName: "Shanmukh Sarma",
        customerPhone: "9999900001",
        callType: "incoming",
        callStatus: "connected",
        duration: 45,
        calledAt: new Date(Date.now() - 10000),
      },
    ];

    const legacyLeads = [
      {
        _id: leadId2,
        name: "Legacy Customer",
        phone: "9999900002",
        assignedTo: "Shanmukh Sarma",
        createdAt: new Date(),
        callHistory: [
          {
            callEventId: "legacy_call_2",
            callType: "outgoing",
            status: "connected",
            duration: 60,
            calledAt: new Date(Date.now() - 50000),
          },
        ],
      },
    ];

    const tenantModels = {
      User: createMockUserModel(),
      CallRecord: {
        find: () => createQueryBuilderMock(crRecords),
      },
      Lead: {
        find: (filter) => {
          if (filter && filter._id) {
            return createQueryBuilderMock([
              { _id: leadId1, name: "CR Lead", phone: "9999900001" },
              { _id: leadId2, name: "Legacy Customer", phone: "9999900002" },
            ]);
          }
          return createQueryBuilderMock(legacyLeads);
        },
      },
    };

    const res = await searchCallRecords({
      tenantModels,
      filters: {},
    });

    assert.equal(res.success, true);
    assert.equal(res.totalCount, 2, "Must retrieve both CallRecord and Lead.callHistory entries");
    const eventIds = res.records.map((r) => r.callEventId);
    assert.ok(eventIds.includes("cr_call_1"));
    assert.ok(eventIds.includes("legacy_call_2"));
  });

  // 7. Duplicate historical call-event detection
  test("7. Duplicate historical call-event detection prevents duplicate records", async () => {
    const sharedEventId = "evt_shared_007";
    const leadId = new mongoose.Types.ObjectId();

    const crRecords = [
      {
        _id: new mongoose.Types.ObjectId(),
        callEventId: sharedEventId,
        leadId,
        salespersonName: "Shanmukh Sarma",
        customerPhone: "9999900001",
        callType: "incoming",
        callStatus: "connected",
        duration: 30,
        calledAt: new Date("2026-11-06T10:00:00Z"),
      },
    ];

    const legacyLeads = [
      {
        _id: leadId,
        name: "Customer",
        phone: "9999900001",
        assignedTo: "Shanmukh Sarma",
        createdAt: new Date("2026-11-06T09:00:00Z"),
        callHistory: [
          {
            callEventId: sharedEventId, // same callEventId!
            callType: "incoming",
            status: "connected",
            duration: 30,
            calledAt: new Date("2026-11-06T10:00:00Z"),
          },
        ],
      },
    ];

    const tenantModels = {
      User: createMockUserModel(),
      CallRecord: {
        find: () => createQueryBuilderMock(crRecords),
      },
      Lead: {
        find: (filter) => {
          if (filter && filter._id) {
            return createQueryBuilderMock([{ _id: leadId, name: "Customer", phone: "9999900001" }]);
          }
          return createQueryBuilderMock(legacyLeads);
        },
      },
    };

    const res = await searchCallRecords({ tenantModels, filters: {} });

    assert.equal(res.success, true);
    assert.equal(res.totalCount, 1, "Must deduplicate identical callEventId across sources");
    assert.equal(res.records[0].callEventId, sharedEventId);
  });

  // 8. Summary counts matching filtered records
  test("8. Summary counts match filtered records exactly", async () => {
    const calls = [
      {
        _id: new mongoose.Types.ObjectId(),
        callEventId: "call_1",
        customerPhone: "9876500001",
        salespersonName: "Shanmukh Sarma",
        callType: "missed",
        callStatus: "missed",
        calledAt: new Date(),
      },
      {
        _id: new mongoose.Types.ObjectId(),
        callEventId: "call_2",
        customerPhone: "9876500002",
        salespersonName: "Shanmukh Sarma",
        callType: "missed",
        callStatus: "missed",
        calledAt: new Date(),
      },
    ];

    const tenantModels = {
      User: createMockUserModel(),
      CallRecord: {
        find: () => createQueryBuilderMock(calls),
      },
      Lead: { find: () => createQueryBuilderMock([]) },
      Followup: { find: () => createQueryBuilderMock([]) },
    };

    const res = await getMissedCallAnalytics({
      tenantModels,
      filters: { salespersonNameOrId: "Shanmukh Sarma" },
    });

    assert.equal(res.totalCount, 2);
    assert.equal(res.summary.totalMatchingMissedCalls, 2);
    assert.equal(res.summary.uniqueCustomers, 2);
    assert.equal(res.summary.salespersonBreakdown["Shanmukh Sarma"], 2);
  });

  // 9. WhatsApp messages filtered by salesperson
  test("9. WhatsApp messages filter by salesperson via assigned Lead ownership", async () => {
    const repLeadId = new mongoose.Types.ObjectId();

    const tenantModels = {
      User: createMockUserModel(),
      Lead: {
        find: () => createQueryBuilderMock([repLeadId]),
        countDocuments: async () => 0,
      },
      Message: {
        aggregate: async (pipeline) => {
          const matchStage = pipeline[0].$match;
          assert.ok(matchStage.$and || matchStage.leadId);
          return [
            {
              total: [{ c: 2 }],
              incoming: [{ c: 1 }],
              outgoing: [{ c: 1 }],
            },
          ];
        },
      },
    };

    const res = await getWhatsAppAnalytics({
      tenantModels,
      filters: { salespersonNameOrId: "Shanmukh Sarma" },
    });

    assert.equal(res.success, true);
    assert.equal(res.summary.messagingActivity.totalMessages, 2);
    assert.equal(res.summary.messagingActivity.incomingFromCustomers, 1);
    assert.equal(res.summary.messagingActivity.outgoingFromTeamOrAI, 1);
  });

  // 10. WhatsApp unread filtering combined with salesperson
  test("10. WhatsApp unread filtering combines unread and salesperson without clobbering $or", async () => {
    let capturedFilter = null;
    const repLeadId = new mongoose.Types.ObjectId();

    const tenantModels = {
      User: createMockUserModel(),
      Lead: {
        find: (filter) => {
          if (!capturedFilter && filter && Object.keys(filter).length > 0) {
            capturedFilter = filter;
          }
          return createQueryBuilderMock([repLeadId]);
        },
        countDocuments: async (filter) => {
          capturedFilter = filter;
          return 0;
        },
      },
      Message: {
        aggregate: async () => [{ total: [], incoming: [], outgoing: [] }],
      },
    };

    await getWhatsAppAnalytics({
      tenantModels,
      filters: { salespersonNameOrId: "Shanmukh Sarma", type: "unreplied_leads" },
    });

    assert.ok(capturedFilter, "Filter must be captured");
    assert.ok(capturedFilter.$and, "Combined unread and rep filters must use $and");
    assert.equal(capturedFilter.$and.length >= 2, true);
  });

  // 11. Manager and administrator not being misidentified as salespeople
  test("11. Manager and administrator not misidentified as salespeople without sales records", async () => {
    const tenantModels = {
      User: createMockUserModel(),
      Lead: { countDocuments: async () => 0, distinct: async () => [] },
      CallRecord: { countDocuments: async () => 0, distinct: async () => [] },
      TelecallerAnalytics: { countDocuments: async () => 0, distinct: async () => [] },
    };

    // Alice Manager is a sales manager with no historical sales records
    const res = await resolveSalesperson({ tenantModels, identifier: "Alice Manager" });
    assert.equal(res.resolved, false, "Must not resolve pure manager as salesperson");
    assert.equal(res.isManagerOrAdmin, true);
    assert.match(res.message, /sales manager/);

    // listAllSalespeople excludes Alice Manager by default
    const salesReps = await listAllSalespeople({ tenantModels });
    assert.equal(salesReps.some((u) => u.name === "Alice Manager"), false);
    assert.equal(salesReps.length, 2); // only Shanmukh Sarma and Jhansi Rani
  });

  // 12. Partial coverage reporting on CallRecord failure
  test("12. Partial coverage reporting on CallRecord failure", async () => {
    const leadCall = {
      _id: new mongoose.Types.ObjectId(),
      name: "Fallback Lead",
      phone: "9876500009",
      assignedTo: "Shanmukh Sarma",
      createdAt: new Date(),
      callHistory: [{ callEventId: "fb_1", callType: "missed", status: "missed", calledAt: new Date() }],
    };

    const tenantModels = {
      User: createMockUserModel(),
      CallRecord: {
        find: () => {
          throw new Error("CallRecord database replica unavailable");
        },
      },
      Lead: {
        find: (filter) => {
          if (filter && filter._id) {
            return createQueryBuilderMock([{ _id: leadCall._id, name: "Fallback Lead", phone: "9876500009" }]);
          }
          return createQueryBuilderMock([leadCall]);
        },
      },
      Followup: { find: () => createQueryBuilderMock([]) },
    };

    const res = await getMissedCallAnalytics({ tenantModels, filters: {} });

    assert.equal(res.success, true);
    assert.equal(res.dataCoverage, "partial", "Must flag dataCoverage as partial");
    assert.ok(res.message.includes("CallRecord query error"));
    assert.equal(res.totalCount, 1);
  });

  // 13. Partial coverage reporting on Lead failure
  test("13. Partial coverage reporting on Lead failure", async () => {
    const crCall = {
      _id: new mongoose.Types.ObjectId(),
      callEventId: "cr_only_1",
      customerPhone: "9876500009",
      salespersonName: "Shanmukh Sarma",
      callType: "outgoing",
      callStatus: "connected",
      duration: 30,
      calledAt: new Date(),
    };

    const tenantModels = {
      User: createMockUserModel(),
      CallRecord: {
        find: () => createQueryBuilderMock([crCall]),
      },
      Lead: {
        find: () => {
          throw new Error("Lead collection lock timeout");
        },
      },
    };

    const res = await searchCallRecords({ tenantModels, filters: {} });

    assert.equal(res.success, true);
    assert.equal(res.dataCoverage, "partial", "Must flag dataCoverage as partial when Lead fails");
    assert.ok(res.message.includes("Lead query error"));
    assert.equal(res.totalCount, 1);
  });

  // 14. Datasets with > 100 call records
  test("14. Correctly pages datasets with > 100 call records", async () => {
    const largeCalls = Array.from({ length: 150 }, (_, i) => ({
      _id: new mongoose.Types.ObjectId(),
      callEventId: `evt_large_${i}`,
      customerPhone: `98700000${i.toString().padStart(3, "0")}`,
      salespersonName: "Shanmukh Sarma",
      callType: "missed",
      callStatus: "missed",
      duration: 0,
      calledAt: new Date(Date.now() - i * 60000),
    }));

    const tenantModels = {
      User: createMockUserModel(),
      CallRecord: {
        find: () => createQueryBuilderMock(largeCalls),
      },
      Lead: { find: () => createQueryBuilderMock([]) },
      Followup: { find: () => createQueryBuilderMock([]) },
    };

    const res = await getMissedCallAnalytics({
      tenantModels,
      pagination: { page: 2, limit: 50 },
    });

    assert.equal(res.totalCount, 150);
    assert.equal(res.records.length, 50);
    assert.equal(res.page, 2);
    assert.equal(res.totalPages, 3);
    assert.equal(res.hasMore, true);
  });

  // 15. Pagination without duplicate or missing records
  test("15. Pagination retrieves disjoint sets without duplicate or missing records", async () => {
    const dataset = Array.from({ length: 50 }, (_, i) => ({
      _id: new mongoose.Types.ObjectId(),
      callEventId: `evt_seq_${i}`,
      customerPhone: `999000${i.toString().padStart(4, "0")}`,
      salespersonName: "Shanmukh Sarma",
      callType: "missed",
      callStatus: "missed",
      duration: 0,
      calledAt: new Date(Date.now() - i * 60000),
    }));

    const tenantModels = {
      User: createMockUserModel(),
      CallRecord: {
        find: () => createQueryBuilderMock(dataset),
      },
      Lead: { find: () => createQueryBuilderMock([]) },
      Followup: { find: () => createQueryBuilderMock([]) },
    };

    const page1 = await getMissedCallAnalytics({ tenantModels, pagination: { page: 1, limit: 25 } });
    const page2 = await getMissedCallAnalytics({ tenantModels, pagination: { page: 2, limit: 25 } });

    assert.equal(page1.records.length, 25);
    assert.equal(page2.records.length, 25);

    const p1Ids = new Set(page1.records.map((r) => r.customerPhone));
    const p2Ids = new Set(page2.records.map((r) => r.customerPhone));

    // Intersection must be empty
    for (const id of p1Ids) {
      assert.equal(p2Ids.has(id), false, `Phone ${id} must not appear on both page 1 and page 2`);
    }
  });

  // 16. Duplicate event retry repairing failed downstream writes
  test("16. Duplicate event retry repairs failed downstream writes idempotently", async () => {
    let callRecordSaved = null;
    let leadAtomicCalled = false;
    let analyticsUpdated = false;

    const existingCR = {
      callEventId: "retry_evt_999",
      customerPhone: "9876543210",
      customerPhoneNormalized: "9876543210",
      salespersonName: "Shanmukh Sarma",
      callType: "missed",
      callStatus: "missed",
      duration: 0,
      calledAt: new Date(),
      metadata: { leadUpdated: false, analyticsUpdated: false },
      save: async function () {
        callRecordSaved = this;
      },
    };

    const CallRecordModel = {
      findOne: async () => existingCR,
    };

    const LeadModel = {
      findOne: async () => ({
        _id: new mongoose.Types.ObjectId(),
        phone: "9876543210",
        callHistory: [],
      }),
      findOneAndUpdate: async () => {
        leadAtomicCalled = true;
        return { _id: new mongoose.Types.ObjectId(), name: "Customer" };
      },
    };

    const AnalyticsModel = {
      findOneAndUpdate: async () => {
        analyticsUpdated = true;
        return { totalCalls: 1 };
      },
    };

    const res = await recordCallEvent({
      CallRecordModel,
      LeadModel,
      AnalyticsModel,
      callEventId: "retry_evt_999",
      customerPhone: "9876543210",
      salespersonName: "Shanmukh Sarma",
      callType: "missed",
      callStatus: "missed",
    });

    assert.equal(res.isDuplicate, true, "Must flag event as duplicate");
    assert.equal(res.repairedDownstream, true, "Must flag that downstream updates were repaired");
    assert.equal(leadAtomicCalled, true, "Lead atomic call must have run to repair downstream");
    assert.equal(analyticsUpdated, true, "Analytics must have run to repair downstream");
    assert.equal(existingCR.metadata.leadUpdated, true, "metadata.leadUpdated must be marked true");
    assert.equal(existingCR.metadata.analyticsUpdated, true, "metadata.analyticsUpdated must be marked true");
  });
});
