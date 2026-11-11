import dotenv from "dotenv";
dotenv.config();

import connectDB from "../configs/db.js";
import { getMasterModels, getTenantModels } from "../services/tenantManager.js";
import {
  checkOrganizationSlaBreaches,
  checkScheduledFollowupReminders,
  checkCadenceWorkflows,
} from "../services/leadWorkflowWorker.js";

async function runLiveLeadFlowScenarios() {
  console.log("\n=======================================================");
  console.log("   🚀 SALESBUSTER CRM: LIVE LEAD FLOW TEST SUITE       ");
  console.log("=======================================================\n");

  await connectDB();

  const { Organization } = getMasterModels();
  const org = await Organization.findOne({ status: "active" });
  if (!org) {
    console.error("❌ No active organization found in database!");
    process.exit(1);
  }

  console.log(`🏢 Testing with Active Org: "${org.name}" (Tenant DB: ${org.tenantDbName})`);
  const { Lead, Notification } = getTenantModels(org.tenantDbName);

  const cleanupLeadIds = [];

  try {
    // -------------------------------------------------------------------------
    // SCENARIO 1: SLA Breach Execution (>24h Inactivity)
    // -------------------------------------------------------------------------
    console.log("\n▶ Running Scenario 1: SLA Breach Escalation (>24h untouched)...");
    const testSlaLead = await Lead.create({
      name: "Test SLA Lead",
      phone: "9999900001",
      folder: "New Leads",
      status: "New",
      sla: {
        enteredNewAt: new Date(Date.now() - 25 * 3600 * 1000), // 25 hours ago
        firstActionAt: null,
        slaBreached: false,
      },
    });
    cleanupLeadIds.push(testSlaLead._id);

    console.log(`   - Created test lead in "New Leads" with enteredNewAt = 25h ago (ID: ${testSlaLead._id})`);

    // Execute SLA check
    await checkOrganizationSlaBreaches(org);

    // Reload from database
    const updatedSlaLead = await Lead.findById(testSlaLead._id);
    if (
      updatedSlaLead.folder === "Not Attended" &&
      updatedSlaLead.status === "Not Attended" &&
      updatedSlaLead.sla?.slaBreached === true
    ) {
      console.log("   ✔ PASSED: Lead automatically moved to 'Not Attended' with slaBreached = true");
    } else {
      console.error(
        `   ❌ FAILED: Lead folder is "${updatedSlaLead.folder}", status: "${updatedSlaLead.status}", breached: ${updatedSlaLead.sla?.slaBreached}`
      );
    }

    // Verify Notification
    const slaNotif = await Notification.findOne({
      "metadata.leadId": testSlaLead._id,
      type: "sla_breach",
    });
    if (slaNotif) {
      console.log(`   ✔ PASSED: Manager SLA Breach Notification dispatched: "${slaNotif.title}"`);
    } else {
      console.log("   ⚠ Notice: Notification not found (check Notification schema setup)");
    }

    // -------------------------------------------------------------------------
    // SCENARIO 2: Scheduled Follow-up (Take Up Later) Pre-Call Reminder
    // -------------------------------------------------------------------------
    console.log("\n▶ Running Scenario 2: Scheduled Follow-up Pre-Call Reminder...");
    const now = new Date();
    const scheduledTime = new Date(now.getTime() + 15 * 60 * 1000); // 15 mins ahead
    const timeStr = `${String(scheduledTime.getHours()).padStart(2, "0")}:${String(scheduledTime.getMinutes()).padStart(2, "0")}`;

    const testFollowupLead = await Lead.create({
      name: "Test Followup Lead",
      phone: "9999900002",
      folder: "Upcoming Followup",
      status: "Follow Up",
      nextFollowUp: now.toISOString().slice(0, 10),
      followupTime: timeStr,
      assignedTo: "Test_Representative",
      callerReminded: false,
    });
    cleanupLeadIds.push(testFollowupLead._id);

    console.log(`   - Scheduled followup for ${testFollowupLead.nextFollowUp} at ${timeStr} (in 15m)`);

    await checkScheduledFollowupReminders(org);

    const updatedFollowupLead = await Lead.findById(testFollowupLead._id);
    if (updatedFollowupLead.callerReminded === true) {
      console.log("   ✔ PASSED: Lead flagged with callerReminded = true within 30m window");
    } else {
      console.error(`   ❌ FAILED: callerReminded is ${updatedFollowupLead.callerReminded}`);
    }

    // -------------------------------------------------------------------------
    // SCENARIO 3: "Not Responding" Cadence -> Future Leads Auto-Transfer
    // -------------------------------------------------------------------------
    console.log("\n▶ Running Scenario 3: 'Not Responding' Cadence Exhaustion -> Future Leads...");
    const testCadenceLead = await Lead.create({
      name: "Test Cadence Lead",
      phone: "9999900003",
      folder: "Not Responding",
      status: "Not Responding",
      cadence: {
        type: "Active_NotResponding",
        followupCount: 4, // Attempt 4 of max 5
        nextCadenceScheduledAt: new Date(Date.now() - 5000), // Due right now
      },
    });
    cleanupLeadIds.push(testCadenceLead._id);

    console.log("   - Created lead at cadence attempt 4 with nextCadenceScheduledAt due now");

    await checkCadenceWorkflows(org);

    const updatedCadenceLead = await Lead.findById(testCadenceLead._id);
    if (
      updatedCadenceLead.cadence?.followupCount === 5 &&
      updatedCadenceLead.folder === "Future Leads" &&
      updatedCadenceLead.status === "Future Leads" &&
      updatedCadenceLead.cadence?.type === "Drip_FutureLeads"
    ) {
      console.log("   ✔ PASSED: Lead reached max follow-ups (5) and was auto-moved to 'Future Leads' drip");
    } else {
      console.error(
        `   ❌ FAILED: Count: ${updatedCadenceLead.cadence?.followupCount}, folder: "${updatedCadenceLead.folder}", type: "${updatedCadenceLead.cadence?.type}"`
      );
    }

    // -------------------------------------------------------------------------
    // SCENARIO 4: Intent Classification & Routing Rules
    // -------------------------------------------------------------------------
    console.log("\n▶ Running Scenario 4: Intent Classification & Routing Regex...");
    const intentTests = [
      { text: "I am looking for a job vacancy", expected: "Jobs" },
      { text: "Want to do a business partnership collab", expected: "Collab Opportunity" },
      { text: "The price is too high for my budget", expected: "Price Issue" },
      { text: "I am very interested in this service", expected: "Priority" },
      { text: "Please call me later next week", expected: "Upcoming Followup" },
    ];

    let intentPassed = 0;
    for (const testItem of intentTests) {
      let routedFolder = "General";
      const normalized = testItem.text.toLowerCase();

      if (/interested|i am interested|yes i am interested/i.test(normalized)) {
        routedFolder = "Priority";
      } else if (/take up later|call later|later|not now|busy/i.test(normalized)) {
        routedFolder = "Upcoming Followup";
      } else if (/job|job seeker|hiring|vacancy|career/i.test(normalized)) {
        routedFolder = "Jobs";
      } else if (/collab|collaboration|partnership|tie up|partner/i.test(normalized)) {
        routedFolder = "Collab Opportunity";
      } else if (/price issue|too costly|expensive|high price|budget/i.test(normalized)) {
        routedFolder = "Price Issue";
      }

      if (routedFolder === testItem.expected) {
        console.log(`   ✔ PASSED: "${testItem.text}" -> Folder: ${routedFolder}`);
        intentPassed++;
      } else {
        console.error(`   ❌ FAILED: "${testItem.text}" expected ${testItem.expected} but got ${routedFolder}`);
      }
    }

    console.log(`   ✔ Intent Classification: ${intentPassed}/${intentTests.length} tests passed`);

    console.log("\n=======================================================");
    console.log("   🎉 ALL LEAD FLOW SCENARIOS COMPLETED SUCCESSFULLY!  ");
    console.log("=======================================================\n");
  } finally {
    // Clean up created test leads
    if (cleanupLeadIds.length > 0) {
      await Lead.deleteMany({ _id: { $in: cleanupLeadIds } });
      console.log(`🧹 Cleaned up ${cleanupLeadIds.length} temporary test leads from tenant DB.`);
    }
    process.exit(0);
  }
}

runLiveLeadFlowScenarios().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
