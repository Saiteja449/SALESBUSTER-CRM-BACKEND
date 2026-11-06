import mongoose from "mongoose";
import Lead from "../models/Lead.js";
import CallRecord from "../models/CallRecord.js";
import TelecallerAnalytics from "../models/TelecallerAnalytics.js";
import { getISTDateString } from "../ai/assistant/dateUtils.js";

/**
 * Historical Data Backfill & Reconciliation Utility
 * Scans Lead.callHistory and reconciles missing CallRecord documents idempotently.
 */
export const backfillCallRecords = async ({
  tenantModels = {},
  organizationId = null,
}) => {
  const LeadModel = tenantModels.Lead || Lead;
  const CallRecordModel = tenantModels.CallRecord || CallRecord;
  const AnalyticsModel = tenantModels.TelecallerAnalytics || TelecallerAnalytics;

  console.log("[Backfill] Starting CallRecord backfill and reconciliation...");

  const leads = await LeadModel.find({
    $or: [
      { "callHistory.0": { $exists: true } },
      { status: "Missed Call" },
    ],
  }).lean();

  console.log(`[Backfill] Located ${leads.length} leads with call activity.`);

  let createdCount = 0;
  let skippedCount = 0;

  for (const lead of leads) {
    const history = lead.callHistory || [];

    // 1. Reconcile explicit callHistory items
    for (const call of history) {
      const callTime = call.calledAt ? new Date(call.calledAt) : new Date(lead.createdAt);
      const callEvtId = call.callEventId || `backfill_${lead._id}_${callTime.getTime()}`;

      // Check if already in CallRecord
      const existing = await CallRecordModel.findOne({
        $or: [
          { callEventId: callEvtId },
          {
            leadId: lead._id,
            calledAt: callTime,
            callType: call.callType || "outgoing",
          },
        ],
      });

      if (existing) {
        skippedCount++;
        continue;
      }

      await CallRecordModel.create({
        callEventId: callEvtId,
        organizationId: organizationId || undefined,
        leadId: lead._id,
        salespersonId: call.salespersonId || lead.assignedTo || null,
        salespersonName: call.salespersonName || (lead.assignedTo ? String(lead.assignedTo) : "Unassigned"),
        customerName: lead.name || "",
        customerPhone: lead.phone,
        callType: call.callType || "outgoing",
        callStatus: call.status || (call.duration > 0 ? "connected" : "not-connected"),
        duration: call.duration || 0,
        calledAt: callTime,
        source: "Call",
        recordingUrl: call.recordingUrl || null,
        recordingName: call.recordingName || null,
        recordingId: call.recordingId || null,
      });

      createdCount++;
    }

    // 2. If status is "Missed Call" but 0 missed entries in callHistory, create entry
    const hasMissedInHistory = history.some((c) => c.status === "missed" || c.callType === "missed");
    if (lead.status === "Missed Call" && !hasMissedInHistory) {
      const callTime = new Date(lead.createdAt);
      const callEvtId = `backfill_missed_${lead._id}`;

      const existing = await CallRecordModel.findOne({ callEventId: callEvtId });
      if (!existing) {
        await CallRecordModel.create({
          callEventId: callEvtId,
          organizationId: organizationId || undefined,
          leadId: lead._id,
          salespersonId: lead.assignedTo || null,
          salespersonName: lead.assignedTo ? String(lead.assignedTo) : "Unassigned",
          customerName: lead.name || "",
          customerPhone: lead.phone,
          callType: "missed",
          callStatus: "missed",
          duration: 0,
          calledAt: callTime,
          source: "Call",
        });
        createdCount++;
      } else {
        skippedCount++;
      }
    }
  }

  console.log(`[Backfill] Reconciliation complete. Created: ${createdCount}, Already existed/skipped: ${skippedCount}.`);
  return { createdCount, skippedCount };
};

// Executable if run directly via CLI
if (process.argv[1] && process.argv[1].endsWith("backfillCallRecords.js")) {
  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/salesbuster";
  mongoose.connect(mongoUri)
    .then(async () => {
      await backfillCallRecords({});
      process.exit(0);
    })
    .catch((err) => {
      console.error("[Backfill] Failed:", err);
      process.exit(1);
    });
}

