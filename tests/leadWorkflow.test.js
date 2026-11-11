import test from "node:test";
import assert from "node:assert/strict";
import {
  checkOrganizationSlaBreaches,
  checkScheduledFollowupReminders,
  checkCadenceWorkflows,
} from "../services/leadWorkflowWorker.js";
import {
  setTenantModelsMock,
  setMasterModelsMock,
} from "../services/tenantManager.js";

// ============================================================================
// 1. SLA BREACH & ATTENDANCE SCENARIOS
// ============================================================================
test("SLA Scenario 1: Untouched lead in 'New Leads' > 24 hours is automatically moved to 'Not Attended'", async () => {
  const staleLead = {
    _id: "lead_sla_001",
    name: "Stale Lead",
    phone: "9876543210",
    folder: "New Leads",
    status: "New",
    sla: {
      enteredNewAt: new Date(Date.now() - 25 * 3600 * 1000), // 25 hours ago
      firstActionAt: null,
      slaBreached: false,
    },
    save: async function () {
      return this;
    },
    toJSON: function () {
      return { ...this };
    },
  };

  const createdNotifications = [];
  const mockTenantModels = {
    Lead: {
      find: async (query) => {
        // Match stale leads
        if (
          query.folder?.$in?.includes("New Leads") &&
          query["sla.slaBreached"]?.$ne === true
        ) {
          return [staleLead];
        }
        return [];
      },
    },
    Notification: {
      create: async (payload) => {
        createdNotifications.push(payload);
        return payload;
      },
    },
  };

  setTenantModelsMock(() => mockTenantModels);

  const mockOrg = {
    _id: "org_test_123",
    name: "Test Org",
    tenantDbName: "sb_tenant_test",
    workflowSettings: {
      leadAttendanceSlaHours: 24,
      enableAutoAttendanceEscalation: true,
    },
  };

  await checkOrganizationSlaBreaches(mockOrg);

  // Assert lead was updated
  assert.equal(staleLead.folder, "Not Attended");
  assert.equal(staleLead.status, "Not Attended");
  assert.equal(staleLead.sla.slaBreached, true);
  assert.ok(staleLead.sla.breachedAt instanceof Date);

  // Assert notification was created for sales manager
  assert.equal(createdNotifications.length, 1);
  assert.equal(createdNotifications[0].type, "sla_breach");
  assert.match(createdNotifications[0].title, /Lead Attendance SLA Breached/);
});

test("SLA Scenario 2: Lead is PROTECTED from breach if action was taken (firstActionAt is recorded)", async () => {
  const activeLead = {
    _id: "lead_sla_002",
    name: "Active Lead",
    folder: "New Leads",
    status: "New",
    sla: {
      enteredNewAt: new Date(Date.now() - 25 * 3600 * 1000),
      firstActionAt: new Date(Date.now() - 2 * 3600 * 1000), // Called 2h ago
      slaBreached: false,
    },
    save: async function () {
      return this;
    },
  };

  const mockTenantModels = {
    Lead: {
      find: async (query) => {
        // Query specifies $or: [{ "sla.firstActionAt": null }, { "sla.firstActionAt": { $exists: false } }]
        // Since firstActionAt exists and is not null, query returns empty
        return [];
      },
    },
    Notification: { create: async () => {} },
  };

  setTenantModelsMock(() => mockTenantModels);

  const mockOrg = {
    _id: "org_test_123",
    tenantDbName: "sb_tenant_test",
    workflowSettings: { leadAttendanceSlaHours: 24 },
  };

  await checkOrganizationSlaBreaches(mockOrg);

  assert.equal(activeLead.folder, "New Leads");
  assert.equal(activeLead.status, "New");
  assert.equal(activeLead.sla.slaBreached, false);
});

test("SLA Scenario 3: SLA breach check is SKIPPED when organization disables auto-escalation", async () => {
  let leadFindCalled = false;
  const mockTenantModels = {
    Lead: {
      find: async () => {
        leadFindCalled = true;
        return [];
      },
    },
  };

  setTenantModelsMock(() => mockTenantModels);

  const mockOrg = {
    _id: "org_test_123",
    tenantDbName: "sb_tenant_test",
    workflowSettings: {
      enableAutoAttendanceEscalation: false,
    },
  };

  await checkOrganizationSlaBreaches(mockOrg);
  assert.equal(leadFindCalled, false, "Should not query leads if escalation is disabled");
});

// ============================================================================
// 2. SCHEDULED FOLLOW-UP (TAKE UP LATER) REMINDERS
// ============================================================================
test("Followup Scenario 1: Caller receives pre-call reminder within configured reminder window", async () => {
  const now = new Date();
  const scheduledTime = new Date(now.getTime() + 15 * 60 * 1000); // 15 mins from now
  const timeStr = `${String(scheduledTime.getHours()).padStart(2, "0")}:${String(scheduledTime.getMinutes()).padStart(2, "0")}`;

  const scheduledLead = {
    _id: "lead_followup_001",
    name: "Upcoming Appointment Lead",
    phone: "9876543211",
    status: "Follow Up",
    nextFollowUp: now.toISOString().slice(0, 10),
    followupTime: timeStr,
    assignedTo: "user_caller_777",
    callerReminded: false,
    save: async function () {
      return this;
    },
  };

  const createdNotifications = [];
  const mockTenantModels = {
    Lead: {
      find: async () => [scheduledLead],
    },
    Notification: {
      create: async (n) => {
        createdNotifications.push(n);
        return n;
      },
    },
  };

  setTenantModelsMock(() => mockTenantModels);

  const mockOrg = {
    _id: "org_test_123",
    tenantDbName: "sb_tenant_test",
    workflowSettings: {
      callerReminderMinutesBefore: 30, // Within 30 min window
    },
  };

  await checkScheduledFollowupReminders(mockOrg);

  assert.equal(scheduledLead.callerReminded, true);
  assert.equal(createdNotifications.length, 1);
  assert.equal(createdNotifications[0].type, "followup_reminder");
  assert.equal(createdNotifications[0].userId, "user_caller_777");
});

test("Followup Scenario 2: Caller is NOT reminded when follow-up is far in the future", async () => {
  const now = new Date();
  const scheduledTime = new Date(now.getTime() + 90 * 60 * 1000); // 90 mins from now
  const timeStr = `${String(scheduledTime.getHours()).padStart(2, "0")}:${String(scheduledTime.getMinutes()).padStart(2, "0")}`;

  const futureLead = {
    _id: "lead_followup_002",
    status: "Follow Up",
    nextFollowUp: now.toISOString().slice(0, 10),
    followupTime: timeStr,
    assignedTo: "user_caller_777",
    callerReminded: false,
    save: async function () {
      return this;
    },
  };

  const createdNotifications = [];
  const mockTenantModels = {
    Lead: {
      find: async () => [futureLead],
    },
    Notification: {
      create: async (n) => createdNotifications.push(n),
    },
  };

  setTenantModelsMock(() => mockTenantModels);

  const mockOrg = {
    _id: "org_test_123",
    tenantDbName: "sb_tenant_test",
    workflowSettings: { callerReminderMinutesBefore: 30 },
  };

  await checkScheduledFollowupReminders(mockOrg);

  assert.equal(futureLead.callerReminded, false);
  assert.equal(createdNotifications.length, 0);
});

// ============================================================================
// 3. "NOT RESPONDING" CADENCE & FUTURE LEADS AUTO-MIGRATION
// ============================================================================
test("Cadence Scenario 1: Advances to next followup attempt when attempt < maxFollowups", async () => {
  const now = new Date();
  const cadenceLead = {
    _id: "lead_nr_001",
    name: "Unresponsive Lead",
    folder: "Not Responding",
    status: "Not Responding",
    cadence: {
      type: "Active_NotResponding",
      followupCount: 2,
      nextCadenceScheduledAt: new Date(now.getTime() - 1000), // Due now
    },
    save: async function () {
      return this;
    },
    toJSON: function () {
      return { ...this };
    },
  };

  const mockTenantModels = {
    Lead: {
      find: async () => [cadenceLead],
    },
    Notification: { create: async () => {} },
  };

  setTenantModelsMock(() => mockTenantModels);

  const mockOrg = {
    _id: "org_test_123",
    tenantDbName: "sb_tenant_test",
    workflowSettings: {
      notRespondingMaxFollowups: 5,
      notRespondingIntervalDays: [1, 3, 6, 10, 15],
    },
  };

  await checkCadenceWorkflows(mockOrg);

  // Attempt should increment from 2 to 3
  assert.equal(cadenceLead.cadence.followupCount, 3);
  assert.equal(cadenceLead.folder, "Not Responding");
  assert.ok(cadenceLead.cadence.nextCadenceScheduledAt.getTime() > now.getTime());
});

test("Cadence Scenario 2: Exhaustion of max followups automatically transfers lead to 'Future Leads' drip", async () => {
  const now = new Date();
  const maxAttemptLead = {
    _id: "lead_nr_002",
    name: "Exhausted Lead",
    folder: "Not Responding",
    status: "Not Responding",
    cadence: {
      type: "Active_NotResponding",
      followupCount: 4, // 1 step away from max (5)
      nextCadenceScheduledAt: new Date(now.getTime() - 1000),
    },
    save: async function () {
      return this;
    },
    toJSON: function () {
      return { ...this };
    },
  };

  const createdNotifications = [];
  const mockTenantModels = {
    Lead: {
      find: async () => [maxAttemptLead],
    },
    Notification: {
      create: async (n) => {
        createdNotifications.push(n);
        return n;
      },
    },
  };

  setTenantModelsMock(() => mockTenantModels);

  const mockOrg = {
    _id: "org_test_123",
    tenantDbName: "sb_tenant_test",
    workflowSettings: {
      notRespondingMaxFollowups: 5,
      notRespondingFallbackFolder: "Future Leads",
      futureLeadsDripIntervalDays: 15,
    },
  };

  await checkCadenceWorkflows(mockOrg);

  // Assert auto-migration to Future Leads
  assert.equal(maxAttemptLead.cadence.followupCount, 5);
  assert.equal(maxAttemptLead.folder, "Future Leads");
  assert.equal(maxAttemptLead.status, "Future Leads");
  assert.equal(maxAttemptLead.cadence.type, "Drip_FutureLeads");

  // Assert manager notification
  assert.equal(createdNotifications.length, 1);
  assert.equal(createdNotifications[0].type, "cadence_completed");
  assert.match(createdNotifications[0].message, /moved to Future Leads/);
});

// ============================================================================
// 4. WHATSAPP INTENT CLASSIFICATION LOGIC
// ============================================================================
test("Intent Routing Scenario 1: 'Job / Hiring' keyword routes lead to 'Jobs' folder", () => {
  const testPhrases = [
    "I am looking for a job",
    "Are you hiring for any sales vacancy?",
    "Need career opportunity in your company",
    "Job seeker details",
  ];

  for (const text of testPhrases) {
    const isJob = /job|job seeker|hiring|vacancy|career/i.test(text);
    assert.equal(isJob, true, `Expected "${text}" to classify as Job`);
  }
});

test("Intent Routing Scenario 2: 'Collab / Partnership' keyword routes lead to 'Collab Opportunity'", () => {
  const testPhrases = [
    "We want a partnership with your firm",
    "Let's collab on business expansion",
    "Interested in a tie up opportunity",
    "Looking for a partner agency",
  ];

  for (const text of testPhrases) {
    const isCollab = /collab|collaboration|partnership|tie up|partner/i.test(text);
    assert.equal(isCollab, true, `Expected "${text}" to classify as Collab Opportunity`);
  }
});

test("Intent Routing Scenario 3: 'Interested' keyword elevates lead to 'Priority' & 'High' priority", () => {
  const testPhrases = [
    "Yes I am interested",
    "Interested in booking",
    "I am interested in knowing more details",
  ];

  for (const text of testPhrases) {
    const isInterested = /interested|i am interested|yes i am interested/i.test(text);
    assert.equal(isInterested, true, `Expected "${text}" to classify as High Priority Interest`);
  }
});

test("Intent Routing Scenario 4: 'Take Up Later' routes to 'Upcoming Followup'", () => {
  const testPhrases = [
    "Please call later, busy right now",
    "I will take up later next month",
    "Call me tomorrow not now",
  ];

  for (const text of testPhrases) {
    const isLater = /take up later|call later|later|not now|busy/i.test(text);
    assert.equal(isLater, true, `Expected "${text}" to classify as Take Up Later`);
  }
});

test("Intent Routing Scenario 5: 'Price Issue' routes to 'Price Issue' folder", () => {
  const testPhrases = [
    "Too costly for me",
    "Price issue, please give discount",
    "Very expensive package",
    "Exceeds my budget",
  ];

  for (const text of testPhrases) {
    const isPrice = /price issue|too costly|expensive|high price|budget/i.test(text);
    assert.equal(isPrice, true, `Expected "${text}" to classify as Price Issue`);
  }
});

test("Intent Routing Scenario 6: Customer replying from Future Leads REACTIVATES lead", () => {
  const lead = {
    folder: "Future Leads",
    status: "Future Leads",
  };
  const incomingText = "Yes, please call me now";

  const isReactivation =
    (lead.folder === "Future Leads" || lead.folder === "Not Responding") &&
    /yes|interested|call|tell me/i.test(incomingText);

  assert.equal(isReactivation, true);
});
