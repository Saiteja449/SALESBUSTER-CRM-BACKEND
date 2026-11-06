import mongoose from "mongoose";
import { recordLeadCallAtomic } from "./leadCallService.js";
import { getISTDateString } from "../ai/assistant/dateUtils.js";

const canQueryModel = (model) => {
  if (!model) return false;
  // If it is a real Mongoose Model (has schema or prototype is Model), check readyState
  if (model.prototype instanceof mongoose.Model || model.schema) {
    const readyState = model.db?.readyState ?? mongoose.connection?.readyState;
    return readyState === 1;
  }
  // Otherwise it's a mock object in unit test suites
  return true;
};

/**
 * Idempotently records a call event (including missed calls) across:
 * 1. CallRecord collection (independent single source of truth for all call events)
 * 2. Lead.callHistory & repCallCounts & callCount (atomic)
 * 3. TelecallerAnalytics (daily aggregations)
 *
 * Guarantees idempotency via callEventId or narrow timestamp deduplication window.
 * Supports self-healing repair of incomplete downstream processing on retry.
 */
export const recordCallEvent = async ({
  CallRecordModel,
  LeadModel,
  AnalyticsModel,
  organizationId = null,
  callEventId = null,
  leadId = null,
  salespersonId = null,
  salespersonName = "Unassigned",
  customerName = "",
  customerPhone,
  callType = "missed",
  callStatus = "missed",
  duration = 0,
  calledAt = null,
  source = "Call",
  receivedSimNumber = "",
  recordingObj = null,
  metadata = {},
}) => {
  if (!customerPhone && !leadId) {
    throw new Error("customerPhone or leadId is required to record a call event");
  }

  const callTimestamp = calledAt ? new Date(calledAt) : new Date();
  const rawDuration = parseInt(duration, 10) || (recordingObj?.duration ? parseInt(recordingObj.duration, 10) : 0);
  const cleanPhone = customerPhone ? String(customerPhone).trim() : "";
  const phoneDigits = cleanPhone.replace(/\D/g, "");
  const last10 = phoneDigits.length >= 10 ? phoneDigits.slice(-10) : phoneDigits;

  const repIdStr = salespersonId && String(salespersonId).trim() !== "Unassigned" ? String(salespersonId).trim() : null;
  const repNameStr = salespersonName && String(salespersonName).trim() ? String(salespersonName).trim() : "Unassigned";

  let cleanCallEventId = callEventId ? String(callEventId).trim() : null;

  let existingRecord = null;

  // 1. Check idempotency by callEventId
  if (canQueryModel(CallRecordModel)) {
    try {
      if (cleanCallEventId) {
        existingRecord = await CallRecordModel.findOne({ callEventId: cleanCallEventId });
      } else if (last10.length >= 7) {
        // Prevent duplicate webhook triggers within 30 seconds
        const windowStart = new Date(callTimestamp.getTime() - 30000);
        const windowEnd = new Date(callTimestamp.getTime() + 30000);
        existingRecord = await CallRecordModel.findOne({
          customerPhoneNormalized: last10,
          callType,
          callStatus,
          calledAt: { $gte: windowStart, $lte: windowEnd },
        });
      }
    } catch (err) {
      console.warn("[CallEventService] Error checking duplicate CallRecord:", err.message);
    }
  }

  // 2. Handle Duplicate Event & Repair Missing Downstream Updates
  if (existingRecord) {
    cleanCallEventId = existingRecord.callEventId;
    let needsSave = false;
    let repairedDownstream = false;

    // Update recording or duration if newly available
    if (recordingObj?.url && !existingRecord.recordingUrl) {
      existingRecord.recordingUrl = recordingObj.url;
      existingRecord.recordingName = recordingObj.name || existingRecord.recordingName;
      existingRecord.recordingId = recordingObj._id || existingRecord.recordingId;
      needsSave = true;
    }
    if (rawDuration > 0 && (!existingRecord.duration || existingRecord.duration === 0)) {
      existingRecord.duration = rawDuration;
      needsSave = true;
    }
    if (leadId && !existingRecord.leadId) {
      existingRecord.leadId = leadId;
      needsSave = true;
    }

    const recMeta = existingRecord.metadata || {};

    // Downstream Repair: Lead callHistory
    let repairedLead = null;
    if (!recMeta.leadUpdated && canQueryModel(LeadModel) && (leadId || cleanPhone) && typeof LeadModel.findOneAndUpdate === "function") {
      try {
        repairedLead = await recordLeadCallAtomic({
          LeadModel,
          leadId: existingRecord.leadId || leadId,
          phone: cleanPhone || existingRecord.customerPhone,
          salespersonId: existingRecord.salespersonId || repIdStr,
          salespersonName: existingRecord.salespersonName || repNameStr,
          callEventId: cleanCallEventId,
          recordingObj,
          callType: existingRecord.callType || callType,
          status: existingRecord.callStatus || callStatus,
          duration: existingRecord.duration || rawDuration,
          calledAt: existingRecord.calledAt || callTimestamp,
        });
        if (repairedLead) {
          recMeta.leadUpdated = true;
          needsSave = true;
          repairedDownstream = true;
        }
      } catch (rLeadErr) {
        console.warn("[CallEventService] Downstream Lead repair error:", rLeadErr.message);
      }
    }

    // Downstream Repair: TelecallerAnalytics
    let repairedAnalytics = null;
    if (!recMeta.analyticsUpdated && canQueryModel(AnalyticsModel)) {
      try {
        const dateStr = getISTDateString(existingRecord.calledAt || callTimestamp);
        const update = {
          $inc: { totalCalls: 1, talkTime: rawDuration },
          $max: { longestCall: rawDuration },
        };
        if (callType === "incoming" || callType === "missed") update.$inc.incoming = 1;
        if (callType === "outgoing") update.$inc.outgoing = 1;
        if (callStatus === "missed") update.$inc.missed = 1;
        else if (callStatus === "connected") update.$inc.connected = 1;

        let queryFilter = {};
        if (repIdStr && mongoose.Types.ObjectId.isValid(repIdStr)) {
          queryFilter = { salespersonId: repIdStr, date: dateStr };
          update.$setOnInsert = { salesperson: repNameStr };
        } else {
          queryFilter = { salesperson: repNameStr || "Unassigned", date: dateStr };
        }

        if (typeof AnalyticsModel.findOneAndUpdate === "function") {
          repairedAnalytics = await AnalyticsModel.findOneAndUpdate(queryFilter, update, {
            new: true,
            upsert: true,
          });
          if (repairedAnalytics) {
            recMeta.analyticsUpdated = true;
            needsSave = true;
            repairedDownstream = true;
          }
        }
      } catch (rAnalErr) {
        console.warn("[CallEventService] Downstream Analytics repair error:", rAnalErr.message);
      }
    }

    if (needsSave) {
      existingRecord.metadata = recMeta;
      if (typeof existingRecord.save === "function") {
        await existingRecord.save();
      }
    }

    return {
      callRecord: existingRecord,
      isDuplicate: true,
      repairedDownstream,
      callEventId: cleanCallEventId,
      updatedLead: repairedLead,
      updatedAnalytics: repairedAnalytics,
    };
  }

  // Generate stable ID if none provided
  if (!cleanCallEventId) {
    cleanCallEventId = `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  // 3. Atomically update Lead call history first or concurrently
  let updatedLead = null;
  if (canQueryModel(LeadModel) && (leadId || cleanPhone) && typeof LeadModel.findOneAndUpdate === "function") {
    try {
      updatedLead = await recordLeadCallAtomic({
        LeadModel,
        leadId,
        phone: cleanPhone,
        salespersonId: repIdStr,
        salespersonName: repNameStr,
        callEventId: cleanCallEventId,
        recordingObj,
        callType,
        status: callStatus,
        duration: rawDuration,
        calledAt: callTimestamp,
      });
    } catch (leadErr) {
      console.error("[CallEventService] Critical: Failed to update Lead call history atomically:", leadErr);
    }
  }

  // 4. Update TelecallerAnalytics
  let updatedAnalytics = null;
  if (canQueryModel(AnalyticsModel)) {
    try {
      const dateStr = getISTDateString(callTimestamp);
      const update = {
        $inc: {
          totalCalls: 1,
          talkTime: rawDuration,
        },
        $max: {
          longestCall: rawDuration,
        },
      };

      if (callType === "incoming" || callType === "missed") {
        update.$inc.incoming = 1;
      }
      if (callType === "outgoing") {
        update.$inc.outgoing = 1;
      }

      if (callStatus === "missed") {
        update.$inc.missed = 1;
      } else if (callStatus === "connected") {
        update.$inc.connected = 1;
      } else if (callStatus === "rejected") {
        update.$inc.rejected = 1;
      } else if (callStatus === "not-connected") {
        update.$inc.notConnected = 1;
      }

      let queryFilter = {};
      if (repIdStr && mongoose.Types.ObjectId.isValid(repIdStr)) {
        queryFilter = { salespersonId: repIdStr, date: dateStr };
        update.$setOnInsert = { salesperson: repNameStr };
      } else if (repNameStr && repNameStr !== "Unassigned") {
        queryFilter = { salesperson: repNameStr, date: dateStr };
      } else {
        queryFilter = { salesperson: "Unassigned", date: dateStr };
      }

      if (typeof AnalyticsModel.findOneAndUpdate === "function") {
        updatedAnalytics = await AnalyticsModel.findOneAndUpdate(queryFilter, update, {
          new: true,
          upsert: true,
        });
      }
    } catch (analyticsErr) {
      console.error("[CallEventService] Critical: Failed to update TelecallerAnalytics:", analyticsErr);
    }
  }

  // 5. Persist CallRecord with processing tracking metadata
  let createdCallRecord = null;
  if (canQueryModel(CallRecordModel)) {
    try {
      const recordPayload = {
        callEventId: cleanCallEventId,
        organizationId: organizationId && mongoose.Types.ObjectId.isValid(organizationId) ? organizationId : undefined,
        leadId: (updatedLead?._id || leadId) && mongoose.Types.ObjectId.isValid(updatedLead?._id || leadId) ? (updatedLead?._id || leadId) : undefined,
        salespersonId: repIdStr,
        salespersonName: repNameStr,
        customerName: customerName || updatedLead?.name || "",
        customerPhone: cleanPhone || (leadId ? "Unknown" : ""),
        callType,
        callStatus,
        duration: rawDuration,
        calledAt: callTimestamp,
        source: source || "Call",
        receivedSimNumber: receivedSimNumber || "",
        recordingUrl: recordingObj?.url || null,
        recordingName: recordingObj?.name || null,
        recordingId: recordingObj?._id || null,
        metadata: {
          ...(metadata || {}),
          leadUpdated: Boolean(updatedLead),
          analyticsUpdated: Boolean(updatedAnalytics),
        },
      };

      if (typeof CallRecordModel.create === "function") {
        createdCallRecord = await CallRecordModel.create(recordPayload);
      }
    } catch (createErr) {
      console.error("[CallEventService] Critical: Failed to create CallRecord:", createErr);
    }
  }

  return {
    callRecord: createdCallRecord,
    updatedLead,
    updatedAnalytics,
    callEventId: cleanCallEventId,
    isDuplicate: false,
  };
};
