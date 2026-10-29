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
  state.set = function (data) {
    Object.assign(this, data);
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
        } else if (key.startsWith("repCallCounts.") && key.endsWith(".count")) {
          const idx = parseInt(key.split(".")[1], 10);
          if (doc.repCallCounts && doc.repCallCounts[idx]) {
            doc.repCallCounts[idx].count = (doc.repCallCounts[idx].count || 0) + incVal;
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
        } else if (key.startsWith("repCallCounts.")) {
          const parts = key.split(".");
          const idx = parseInt(parts[1], 10);
          const field = parts[2];
          if (doc.repCallCounts && doc.repCallCounts[idx] && field) {
            doc.repCallCounts[idx][field] = val;
          }
        } else if (key.startsWith("callHistory.")) {
          const parts = key.split(".");
          const idx = parseInt(parts[1], 10);
          const field = parts[2];
          if (doc.callHistory && doc.callHistory[idx] && field) {
            doc.callHistory[idx][field] = val;
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
});

test("2. recordLeadCallAtomic handles concurrent calls without losing increments", async () => {
  const repAId = new mongoose.Types.ObjectId();
  const repBId = new mongoose.Types.ObjectId();
  const leadId = new mongoose.Types.ObjectId();

  const mockLeadModel = createMockLeadModel({
    _id: leadId,
    phone: "9999999999",
    callCount: 0,
    repCallCounts: [],
    lastCallAt: null,
  });

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

test("7. Stable callEventId links dialer logCall and post-call updateLead without duplicate call count", async () => {
  const repId = new mongoose.Types.ObjectId();
  const leadId = new mongoose.Types.ObjectId();
  const callTimestamp = new Date(Date.now() - 30000);
  const stableEventId = "call_evt_1001";

  const mockLeadModel = createMockLeadModel({
    _id: leadId,
    name: "Customer One",
    phone: "9876512345",
    status: "New",
    callCount: 0,
    repCallCounts: [],
    callHistory: [],
    recordings: [],
    lastCallAt: null,
  });

  const mockAnalyticsModel = {
    findOneAndUpdate: async () => ({}),
  };
  const mockNotificationModel = {
    create: async () => ({ _id: new mongoose.Types.ObjectId() }),
  };
  const mockFollowupModel = {
    updateMany: async () => ({ modifiedCount: 0 }),
  };

  // STEP 1: Dialer completes call, CallContext logs call via logCall API with stable callEventId
  const logCallReq = {
    body: {
      salespersonId: repId.toString(),
      salesperson: "Sahil Rep",
      date: "2026-10-29",
      timestamp: callTimestamp.getTime(),
      duration: 25,
      callType: "outgoing",
      status: "connected",
      leadId: leadId.toString(),
      phone: "9876512345",
      callEventId: stableEventId,
    },
    user: {
      _id: repId,
      name: "Sahil Rep",
      role: "sales person",
    },
    tenantModels: {
      TelecallerAnalytics: mockAnalyticsModel,
      Lead: mockLeadModel,
    },
  };

  const logCallRes = createMockRes();
  await logCall(logCallReq, logCallRes);

  assert.equal(logCallRes.statusCode, 200);
  assert.equal(mockLeadModel.doc.callCount, 1, "Call count must be 1 after dialer call log");
  assert.equal(mockLeadModel.doc.repCallCounts[0].count, 1, "Rep call count must be 1");
  assert.equal(mockLeadModel.doc.callHistory.length, 1, "There must be exactly 1 callHistory entry");
  assert.equal(mockLeadModel.doc.callHistory[0].callEventId, stableEventId, "callEventId must be stored");
  assert.ok(!mockLeadModel.doc.callHistory[0].recordingUrl, "recordingUrl must initially be absent/falsy");
  assert.equal(mockLeadModel.doc.callHistory[0].duration, 25);

  // STEP 2: User opens Post-Call Popup and submits details with audio recording and matching callEventId
  const updateReq = {
    params: { id: leadId.toString() },
    body: {
      status: "Follow Up",
      recordingName: "Call_Recording_Customer_01.m4a",
      duration: "25",
      callEventId: stableEventId, // Exact stable match
      callTimestamp: callTimestamp.toISOString(),
    },
    file: {
      filename: "Call_Recording_Customer_01.m4a",
      originalname: "Call_Recording_Customer_01.m4a",
      path: "uploads/Call_Recording_Customer_01.m4a",
      mimetype: "audio/mp4",
    },
    user: {
      _id: repId,
      name: "Sahil Rep",
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

  const updateRes = createMockRes();
  await updateLead(updateReq, updateRes);

  assert.equal(updateRes.statusCode, 200);
  // CRITICAL CHECKS: Must NOT have incremented to 2!
  assert.equal(mockLeadModel.doc.callCount, 1, "CRITICAL: callCount MUST REMAIN 1 (no duplicate)");
  assert.equal(mockLeadModel.doc.repCallCounts[0].count, 1, "CRITICAL: repCallCounts MUST REMAIN 1");
  assert.equal(mockLeadModel.doc.callHistory.length, 1, "CRITICAL: callHistory MUST REMAIN 1 entry (no duplicate)");
  assert.ok(mockLeadModel.doc.callHistory[0].recordingUrl, "Recording URL must be attached to the existing call entry");
  assert.equal(mockLeadModel.doc.recordings.length, 1, "Recordings array must have 1 recording");
});

test("8. Retrying upload of same recording is idempotent and does not create duplicate entries", async () => {
  const repId = new mongoose.Types.ObjectId();
  const leadId = new mongoose.Types.ObjectId();
  const recordingObj = {
    _id: new mongoose.Types.ObjectId(),
    name: "Existing_Call_Rec.m4a",
    url: "http://localhost:5000/uploads/Existing_Call_Rec.m4a",
    duration: 30,
    salespersonId: repId,
    salespersonName: "Sahil Rep",
  };

  const mockLeadModel = createMockLeadModel({
    _id: leadId,
    name: "Customer Two",
    phone: "9876599999",
    status: "Follow Up",
    callCount: 1,
    repCallCounts: [
      {
        salespersonId: repId,
        salespersonName: "Sahil Rep",
        count: 1,
        lastCalledAt: new Date(),
      },
    ],
    callHistory: [
      {
        callEventId: "evt_existing_01",
        salespersonId: repId.toString(),
        salespersonName: "Sahil Rep",
        callType: "outgoing",
        status: "connected",
        duration: 30,
        calledAt: new Date(),
        recordingUrl: recordingObj.url,
        recordingName: recordingObj.name,
        recordingId: recordingObj._id,
      },
    ],
    recordings: [recordingObj],
    lastCallAt: new Date(),
  });

  // Background uploader attempts to upload recording again
  const result = await recordLeadCallAtomic({
    LeadModel: mockLeadModel,
    leadId,
    salespersonId: repId,
    salespersonName: "Sahil Rep",
    callEventId: "evt_existing_01",
    recordingObj,
    duration: 30,
  });

  assert.ok(result);
  assert.equal(mockLeadModel.doc.callCount, 1, "callCount must remain 1 on re-upload");
  assert.equal(mockLeadModel.doc.repCallCounts[0].count, 1, "repCallCounts must remain 1 on re-upload");
  assert.equal(mockLeadModel.doc.callHistory.length, 1, "callHistory must remain 1 item");
  assert.equal(mockLeadModel.doc.recordings.length, 1, "recordings must remain 1 item");
});

test("9. Separate distinct calls from same rep with different callEventId are never merged", async () => {
  const repId = new mongoose.Types.ObjectId();
  const leadId = new mongoose.Types.ObjectId();

  const mockLeadModel = createMockLeadModel({
    _id: leadId,
    name: "Customer Three",
    phone: "9876533333",
    status: "New",
    callCount: 0,
    repCallCounts: [],
    callHistory: [],
    recordings: [],
    lastCallAt: null,
  });

  // Call 1 at 10:00:00 AM
  await recordLeadCallAtomic({
    LeadModel: mockLeadModel,
    leadId,
    salespersonId: repId,
    salespersonName: "Sahil Rep",
    callEventId: "call_evt_A",
    duration: 10,
    calledAt: new Date("2026-10-29T10:00:00Z"),
  });

  assert.equal(mockLeadModel.doc.callCount, 1);
  assert.equal(mockLeadModel.doc.callHistory.length, 1);

  // Call 2 from same rep just 15 seconds later (10:00:15 AM)
  await recordLeadCallAtomic({
    LeadModel: mockLeadModel,
    leadId,
    salespersonId: repId,
    salespersonName: "Sahil Rep",
    callEventId: "call_evt_B", // Different stable ID
    duration: 15,
    calledAt: new Date("2026-10-29T10:00:15Z"),
  });

  // Both calls must be preserved as distinct calls!
  assert.equal(mockLeadModel.doc.callCount, 2, "Separate calls must both be counted");
  assert.equal(mockLeadModel.doc.repCallCounts[0].count, 2, "Rep call count must be 2");
  assert.equal(mockLeadModel.doc.callHistory.length, 2, "Both distinct calls must exist in callHistory");
  assert.equal(mockLeadModel.doc.callHistory[0].callEventId, "call_evt_A");
  assert.equal(mockLeadModel.doc.callHistory[1].callEventId, "call_evt_B");
});

test("10. Without stable ID, separate calls are kept and never merged by broad time window", async () => {
  const repId = new mongoose.Types.ObjectId();
  const leadId = new mongoose.Types.ObjectId();

  const mockLeadModel = createMockLeadModel({
    _id: leadId,
    name: "Customer Four",
    phone: "9876544444",
    status: "New",
    callCount: 0,
    repCallCounts: [],
    callHistory: [],
    recordings: [],
    lastCallAt: null,
  });

  // Call 1 with no callEventId
  await recordLeadCallAtomic({
    LeadModel: mockLeadModel,
    leadId,
    salespersonId: repId,
    salespersonName: "Sahil Rep",
    callEventId: null,
    duration: 20,
    calledAt: new Date("2026-10-29T10:00:00Z"),
  });

  assert.equal(mockLeadModel.doc.callCount, 1);

  // Call 2 with no callEventId 2 minutes later
  await recordLeadCallAtomic({
    LeadModel: mockLeadModel,
    leadId,
    salespersonId: repId,
    salespersonName: "Sahil Rep",
    callEventId: null, // No stable ID
    duration: 40,
    calledAt: new Date("2026-10-29T10:02:00Z"),
  });

  // Must NOT merge based on broad time window: must be 2 calls!
  assert.equal(mockLeadModel.doc.callCount, 2, "Without stable ID, separate calls must NOT be merged");
  assert.equal(mockLeadModel.doc.callHistory.length, 2, "Both calls must exist in callHistory");
  assert.equal(mockLeadModel.doc.callHistory[0].duration, 20);
  assert.equal(mockLeadModel.doc.callHistory[1].duration, 40);
});
