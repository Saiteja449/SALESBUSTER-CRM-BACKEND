import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import Lead from "../models/Lead.js";
import { uploadRecordingForLead, updateLead } from "../controllers/leadController.js";
import { logCall } from "../controllers/analyticsController.js";
import { recordLeadCallAtomic } from "../services/leadCallService.js";

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

// Helper to create an in-memory mock LeadModel that correctly emulates MongoDB findOneAndUpdate atomic operations
const createMockLeadModel = (initialLeadDoc) => {
  const state = JSON.parse(JSON.stringify(initialLeadDoc));
  state._id = initialLeadDoc._id;
  state.save = async function () {
    return this;
  };

  const applyUpdate = (doc, update) => {
    // Handle $inc
    if (update.$inc) {
      for (const [key, incVal] of Object.entries(update.$inc)) {
        if (key === "callCount") {
          doc.callCount = (doc.callCount || 0) + incVal;
        } else if (key === "repCallCounts.$.count") {
          if (doc._matchedRepIndex !== undefined && doc.repCallCounts[doc._matchedRepIndex]) {
            doc.repCallCounts[doc._matchedRepIndex].count =
              (doc.repCallCounts[doc._matchedRepIndex].count || 0) + incVal;
          }
        }
      }
    }

    // Handle $set
    if (update.$set) {
      for (const [key, val] of Object.entries(update.$set)) {
        if (key === "lastCallAt") {
          doc.lastCallAt = val;
        } else if (key === "repCallCounts.$.lastCalledAt") {
          if (doc._matchedRepIndex !== undefined && doc.repCallCounts[doc._matchedRepIndex]) {
            doc.repCallCounts[doc._matchedRepIndex].lastCalledAt = val;
          }
        } else if (key === "repCallCounts.$.salespersonName") {
          if (doc._matchedRepIndex !== undefined && doc.repCallCounts[doc._matchedRepIndex]) {
            doc.repCallCounts[doc._matchedRepIndex].salespersonName = val;
          }
        }
      }
    }

    // Handle $push
    if (update.$push) {
      for (const [key, val] of Object.entries(update.$push)) {
        if (!doc[key]) doc[key] = [];
        doc[key].push(val);
      }
    }

    delete doc._matchedRepIndex;
    return doc;
  };

  return {
    doc: state,
    findById: async (id) => (String(id) === String(state._id) ? state : null),
    findOne: async () => state,
    findOneAndUpdate: async (filter, update, opts) => {
      // Check if filter matches lead ID
      if (filter._id && String(filter._id) !== String(state._id)) {
        return null;
      }

      // Check rep matching in $or (Attempt 1: existing rep)
      if (filter.$or) {
        let matchedIndex = -1;
        for (let i = 0; i < (state.repCallCounts || []).length; i++) {
          const rep = state.repCallCounts[i];
          const matched = filter.$or.some((cond) => {
            if (cond["repCallCounts.salespersonId"] && rep.salespersonId) {
              return String(cond["repCallCounts.salespersonId"]) === String(rep.salespersonId);
            }
            if (cond["repCallCounts.salespersonName"] && rep.salespersonName) {
              if (cond["repCallCounts.salespersonName"] instanceof RegExp) {
                return cond["repCallCounts.salespersonName"].test(rep.salespersonName);
              }
              return String(cond["repCallCounts.salespersonName"]).toLowerCase() === String(rep.salespersonName).toLowerCase();
            }
            return false;
          });
          if (matched) {
            matchedIndex = i;
            break;
          }
        }

        if (matchedIndex >= 0) {
          state._matchedRepIndex = matchedIndex;
          applyUpdate(state, update);
          return { ...state };
        }
        return null;
      }

      // Check $nor condition (Attempt 2: new rep)
      if (filter.$nor) {
        const hasExisting = (state.repCallCounts || []).some((rep) => {
          return filter.$nor.some((cond) => {
            if (cond["repCallCounts.salespersonId"] && rep.salespersonId) {
              return String(cond["repCallCounts.salespersonId"]) === String(rep.salespersonId);
            }
            if (cond["repCallCounts.salespersonName"] && rep.salespersonName) {
              if (cond["repCallCounts.salespersonName"] instanceof RegExp) {
                return cond["repCallCounts.salespersonName"].test(rep.salespersonName);
              }
              return String(cond["repCallCounts.salespersonName"]).toLowerCase() === String(rep.salespersonName).toLowerCase();
            }
            return false;
          });
        });

        if (hasExisting) {
          return null; // Rep already exists; $nor condition fails
        }

        applyUpdate(state, update);
        return { ...state };
      }

      applyUpdate(state, update);
      return { ...state };
    },
  };
};

test("1. Lead Schema has callCount, repCallCounts, and lastCallAt fields", () => {
  const paths = Lead.schema.paths;
  assert.ok(paths.callCount, "callCount path must exist on Lead schema");
  assert.equal(paths.callCount.instance, "Number");
  assert.ok(paths.repCallCounts, "repCallCounts path must exist on Lead schema");
  assert.ok(paths.lastCallAt, "lastCallAt path must exist on Lead schema");

  const recSubSchema = Lead.schema.path("recordings").schema;
  assert.ok(recSubSchema.paths.salespersonId, "salespersonId must exist in recordings sub-schema");
  assert.ok(recSubSchema.paths.salespersonName, "salespersonName must exist in recordings sub-schema");
});

test("2. recordLeadCallAtomic handles concurrent calls without losing increments", async () => {
  const leadId = new mongoose.Types.ObjectId();
  const repAId = new mongoose.Types.ObjectId();
  const repBId = new mongoose.Types.ObjectId();

  const mockLeadModel = createMockLeadModel({
    _id: leadId,
    name: "Enterprise Client",
    phone: "9123456780",
    recordings: [],
    callCount: 0,
    repCallCounts: [],
    lastCallAt: null,
  });

  // Simulate 10 simultaneous calls (6 from repA, 4 from repB) running in parallel
  const calls = [
    ...Array(6).fill(null).map((_, i) =>
      recordLeadCallAtomic({
        LeadModel: mockLeadModel,
        leadId,
        salespersonId: repAId,
        salespersonName: "Alice Rep",
        recordingObj: { name: `rec_A_${i}.mp3`, url: `http://localhost/uploads/rec_A_${i}.mp3` },
      })
    ),
    ...Array(4).fill(null).map((_, i) =>
      recordLeadCallAtomic({
        LeadModel: mockLeadModel,
        leadId,
        salespersonId: repBId,
        salespersonName: "Bob Rep",
        recordingObj: { name: `rec_B_${i}.mp3`, url: `http://localhost/uploads/rec_B_${i}.mp3` },
      })
    ),
  ];

  await Promise.all(calls);

  // Total call count must exactly equal 10
  assert.equal(mockLeadModel.doc.callCount, 10, "Total lead call count must be 10");
  assert.equal(mockLeadModel.doc.recordings.length, 10, "Total recordings must be 10");
  assert.equal(mockLeadModel.doc.repCallCounts.length, 2, "There must be 2 reps in repCallCounts");

  const repAEntry = mockLeadModel.doc.repCallCounts.find((r) => String(r.salespersonId) === String(repAId));
  const repBEntry = mockLeadModel.doc.repCallCounts.find((r) => String(r.salespersonId) === String(repBId));

  assert.ok(repAEntry);
  assert.equal(repAEntry.count, 6, "Rep A counter must be exactly 6");
  assert.equal(repAEntry.salespersonName, "Alice Rep");

  assert.ok(repBEntry);
  assert.equal(repBEntry.count, 4, "Rep B counter must be exactly 4");
  assert.equal(repBEntry.salespersonName, "Bob Rep");
});

test("3. uploadRecordingForLead stamps salesperson identity and increments repCallCounts atomically", async () => {
  const repId = new mongoose.Types.ObjectId();
  const leadId = new mongoose.Types.ObjectId();

  const mockLeadModel = createMockLeadModel({
    _id: leadId,
    name: "John Smith",
    phone: "9876543210",
    assignedTo: repId.toString(),
    recordings: [],
    callCount: 0,
    repCallCounts: [],
    lastCallAt: null,
  });

  const req = {
    params: { id: leadId.toString() },
    body: { recordingName: "Call_Test_01.mp3", duration: "120" },
    file: {
      filename: "1726504567890-Call_Test_01.mp3",
      originalname: "Call_Test_01.mp3",
      path: "uploads/1726504567890-Call_Test_01.mp3",
      mimetype: "audio/mp3",
    },
    user: {
      _id: repId,
      name: "Alice Rep",
      role: "sales person",
    },
    tenantModels: {
      Lead: mockLeadModel,
    },
    headers: {},
    get: () => "localhost:5000",
    protocol: "http",
  };

  const res = createMockRes();
  await uploadRecordingForLead(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(mockLeadModel.doc.callCount, 1);
  assert.equal(mockLeadModel.doc.recordings.length, 1);
  assert.equal(mockLeadModel.doc.recordings[0].salespersonName, "Alice Rep");
  assert.equal(String(mockLeadModel.doc.recordings[0].salespersonId), repId.toString());

  assert.equal(mockLeadModel.doc.repCallCounts.length, 1);
  assert.equal(mockLeadModel.doc.repCallCounts[0].count, 1);
  assert.equal(mockLeadModel.doc.repCallCounts[0].salespersonName, "Alice Rep");
  assert.equal(String(mockLeadModel.doc.repCallCounts[0].salespersonId), repId.toString());
});

test("4. updateLead route with file upload stamps rep identity and increments counters atomically", async () => {
  const repId = new mongoose.Types.ObjectId();
  const leadId = new mongoose.Types.ObjectId();

  const mockLeadModel = createMockLeadModel({
    _id: leadId,
    name: "Jane Doe",
    phone: "9123450000",
    status: "new",
    recordings: [],
    callCount: 0,
    repCallCounts: [],
    lastCallAt: null,
  });
  mockLeadModel.doc.set = function (data) {
    Object.assign(this, data);
  };

  const mockNotificationModel = {
    create: async () => ({ _id: new mongoose.Types.ObjectId() }),
  };

  const mockFollowupModel = {
    updateMany: async () => ({ modifiedCount: 0 }),
  };

  const req = {
    params: { id: leadId.toString() },
    body: { status: "contacted", recordingName: "Call_Jane_01.mp3", duration: "180" },
    file: {
      filename: "1726504567890-Call_Jane_01.mp3",
      originalname: "Call_Jane_01.mp3",
      path: "uploads/1726504567890-Call_Jane_01.mp3",
      mimetype: "audio/mp3",
    },
    user: {
      _id: repId,
      name: "Dave Telecaller",
      role: "sales person",
    },
    tenantModels: {
      Lead: mockLeadModel,
      Notification: mockNotificationModel,
      Followup: mockFollowupModel,
    },
    headers: {},
    get: () => "localhost:5000",
    protocol: "http",
  };

  const res = createMockRes();
  await updateLead(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(mockLeadModel.doc.status, "contacted");
  assert.equal(mockLeadModel.doc.callCount, 1);
  assert.equal(mockLeadModel.doc.recordings.length, 1);
  assert.equal(mockLeadModel.doc.recordings[0].salespersonName, "Dave Telecaller");
  assert.equal(String(mockLeadModel.doc.recordings[0].salespersonId), repId.toString());
  assert.equal(mockLeadModel.doc.repCallCounts.length, 1);
  assert.equal(mockLeadModel.doc.repCallCounts[0].count, 1);
  assert.equal(mockLeadModel.doc.repCallCounts[0].salespersonName, "Dave Telecaller");
});

test("5. logCall returns 404 error when nonexistent leadId is provided", async () => {
  const repId = new mongoose.Types.ObjectId();
  const nonExistentLeadId = new mongoose.Types.ObjectId();

  const mockLeadModel = {
    findById: async () => null,
    findOne: async () => null,
    findOneAndUpdate: async () => null,
  };

  let analyticsSaved = false;
  const mockAnalyticsModel = {
    findOneAndUpdate: async () => {
      analyticsSaved = true;
      return {};
    },
  };

  const req = {
    body: {
      salespersonId: repId.toString(),
      salesperson: "Charlie Rep",
      date: "2026-10-27",
      duration: 60,
      leadId: nonExistentLeadId.toString(),
    },
    user: {
      _id: repId,
      name: "Charlie Rep",
      role: "sales person",
    },
    tenantModels: {
      TelecallerAnalytics: mockAnalyticsModel,
      Lead: mockLeadModel,
    },
  };

  const res = createMockRes();
  await logCall(req, res);

  // Must reject with 404 and NOT increment analytics
  assert.equal(res.statusCode, 404);
  assert.equal(res.data.success, false);
  assert.equal(analyticsSaved, false, "Analytics must not be saved when lead tracking fails");
});

test("6. logCall increments repCallCounts on Lead when valid leadId is provided", async () => {
  const repId = new mongoose.Types.ObjectId();
  const leadId = new mongoose.Types.ObjectId();

  const mockLeadModel = createMockLeadModel({
    _id: leadId,
    phone: "9876500000",
    callCount: 1,
    repCallCounts: [
      {
        salespersonId: repId,
        salespersonName: "Charlie Rep",
        count: 1,
        lastCalledAt: new Date(Date.now() - 3600000),
      },
    ],
  });

  let analyticsSaved = false;
  const mockAnalyticsModel = {
    findOneAndUpdate: async (filter, update, opts) => {
      analyticsSaved = true;
      return {
        salespersonId: repId.toString(),
        date: "2026-10-27",
        totalCalls: 2,
      };
    },
  };

  const req = {
    body: {
      salespersonId: repId.toString(),
      salesperson: "Charlie Rep",
      date: "2026-10-27",
      duration: 60,
      callType: "outgoing",
      status: "connected",
      leadId: leadId.toString(),
    },
    user: {
      _id: repId,
      name: "Charlie Rep",
      role: "sales person",
    },
    tenantModels: {
      TelecallerAnalytics: mockAnalyticsModel,
      Lead: mockLeadModel,
    },
  };

  const res = createMockRes();
  await logCall(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(analyticsSaved, true);
  assert.equal(mockLeadModel.doc.callCount, 2);
  assert.equal(mockLeadModel.doc.repCallCounts[0].count, 2);
  assert.equal(mockLeadModel.doc.repCallCounts[0].salespersonName, "Charlie Rep");
});
