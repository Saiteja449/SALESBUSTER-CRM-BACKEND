import mongoose from "mongoose";

/**
 * Atomically records a call / audio recording onto a Lead in MongoDB.
 * Appends to lead.callHistory, increments callCount, and updates repCallCounts.
 * Uses atomic MongoDB operators ($inc, $set, $push) to guarantee
 * zero race conditions or overwritten counts during concurrent calls/uploads.
 *
 * Deduplication & Idempotency:
 * - Uses a stable `callEventId` passed through both the call-log and
 *   recording-upload flows to update matching history entries idempotently.
 * - If no stable ID is available, does NOT merge calls based on broad time windows;
 *   separate calls and recordings are preserved.
 * - Genuinely duplicate retries of the same recording file are handled idempotently.
 *
 * @param {Object} params
 * @param {Object} params.LeadModel - The tenant-scoped Lead Mongoose model
 * @param {string} [params.leadId] - Lead ObjectId string
 * @param {string} [params.phone] - Phone number to locate lead
 * @param {string|Object} [params.salespersonId] - Authenticated salesperson ID
 * @param {string} [params.salespersonName] - Authenticated salesperson display name
 * @param {string} [params.callEventId] - Stable unique call/event ID from native/client
 * @param {Object} [params.recordingObj] - Optional recording subdocument to append to recordings array
 * @param {string} [params.callType] - Call type (incoming, outgoing, missed, rejected)
 * @param {string} [params.status] - Call status (connected, missed, not-connected, rejected)
 * @param {number} [params.duration] - Call duration in seconds
 * @param {Date|string} [params.calledAt] - Timestamp when call occurred
 * @returns {Promise<Object|null>} Updated lead document or null if lead not found
 */
export const recordLeadCallAtomic = async ({
  LeadModel,
  leadId,
  phone,
  salespersonId,
  salespersonName,
  callEventId = null,
  recordingObj = null,
  callType = "outgoing",
  status = "connected",
  duration = 0,
  calledAt = null,
}) => {
  if (!LeadModel) {
    throw new Error("LeadModel is required for recordLeadCallAtomic");
  }

  const now = new Date();
  const repIdStr = salespersonId ? String(salespersonId).trim() : null;
  const repNameStr = salespersonName ? String(salespersonName).trim() : "Sales Representative";
  const callDuration = parseInt(duration) || (recordingObj?.duration || 0);
  const callTimestamp = calledAt ? new Date(calledAt) : now;
  const cleanCallEventId = callEventId ? String(callEventId).trim() : null;

  // Build match query for the lead
  let baseQuery = null;
  if (leadId && mongoose.Types.ObjectId.isValid(leadId)) {
    baseQuery = { _id: new mongoose.Types.ObjectId(leadId) };
  } else if (phone) {
    const cleanPhone = String(phone).replace(/\D/g, "");
    const last10 = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;
    if (last10.length >= 7) {
      baseQuery = {
        $or: [
          { phone: String(phone).trim() },
          { phoneNormalized: last10 },
          { phone: new RegExp(last10 + "$") },
        ],
      };
    }
  }

  if (!baseQuery) {
    return null;
  }

  // 1. Locate the target lead document
  let lead = await LeadModel.findOne(baseQuery);
  if (!lead && phone) {
    const cleanPhone = String(phone).replace(/\D/g, "");
    const last10 = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;
    if (last10.length >= 7) {
      lead = await LeadModel.findOne({
        $or: [
          { phone: String(phone).trim() },
          { phoneNormalized: last10 },
          { phone: new RegExp(last10 + "$") },
        ],
      });
    }
  }

  if (!lead) {
    return null;
  }

  const history = lead.callHistory || [];
  let matchedCallIndex = -1;

  // ---------------------------------------------------------------------------
  // 1. PRIMARY MATCH: Stable call/event ID
  // When callEventId is present, match the exact corresponding callHistory entry.
  // ---------------------------------------------------------------------------
  if (cleanCallEventId) {
    matchedCallIndex = history.findIndex(
      (entry) => entry.callEventId && String(entry.callEventId).trim() === cleanCallEventId
    );
  }

  // ---------------------------------------------------------------------------
  // 2. IDEMPOTENT RECORDING RETRY MATCH:
  // If no match by callEventId, but a recordingObj is provided, check if the
  // EXACT same recording file (by name, URL, or _id) is already attached to
  // prevent duplicate recordings on network retries.
  // ---------------------------------------------------------------------------
  if (matchedCallIndex === -1 && recordingObj) {
    matchedCallIndex = history.findIndex((entry) => {
      const matchUrl = recordingObj.url && entry.recordingUrl && entry.recordingUrl === recordingObj.url;
      const matchName = recordingObj.name && entry.recordingName && entry.recordingName === recordingObj.name;
      const matchId = recordingObj._id && entry.recordingId && String(entry.recordingId) === String(recordingObj._id);
      return Boolean(matchUrl || matchName || matchId);
    });
  }

  // ---------------------------------------------------------------------------
  // SCENARIO A: Existing matching call found. Update entry idempotently without
  // incrementing callCount or repCallCounts.
  // ---------------------------------------------------------------------------
  if (matchedCallIndex !== -1) {
    const updateOps = {
      $set: {},
    };

    if (cleanCallEventId && !history[matchedCallIndex].callEventId) {
      updateOps.$set[`callHistory.${matchedCallIndex}.callEventId`] = cleanCallEventId;
    }

    if (recordingObj) {
      if (cleanCallEventId && !recordingObj.callEventId) {
        recordingObj.callEventId = cleanCallEventId;
      }
      updateOps.$set[`callHistory.${matchedCallIndex}.recordingUrl`] = recordingObj.url || null;
      updateOps.$set[`callHistory.${matchedCallIndex}.recordingName`] = recordingObj.name || null;
      updateOps.$set[`callHistory.${matchedCallIndex}.recordingId`] = recordingObj._id || null;

      const alreadyHasRecording = (lead.recordings || []).some(
        (r) =>
          (recordingObj._id && r._id && String(r._id) === String(recordingObj._id)) ||
          (recordingObj.url && r.url === recordingObj.url) ||
          (recordingObj.name && r.name === recordingObj.name) ||
          (cleanCallEventId && r.callEventId && String(r.callEventId) === cleanCallEventId)
      );

      if (!alreadyHasRecording) {
        updateOps.$push = { recordings: recordingObj };
      }
    }

    if (callDuration > 0 && (!history[matchedCallIndex].duration || history[matchedCallIndex].duration === 0)) {
      updateOps.$set[`callHistory.${matchedCallIndex}.duration`] = callDuration;
      updateOps.$set[`callHistory.${matchedCallIndex}.status`] = "connected";
    }

    let updatedLead = null;
    if (Object.keys(updateOps.$set).length > 0 || updateOps.$push) {
      updatedLead = await LeadModel.findOneAndUpdate(
        { _id: lead._id },
        updateOps,
        { new: true, returnDocument: "after" }
      );
    } else {
      updatedLead = lead;
    }

    return updatedLead;
  }

  // ---------------------------------------------------------------------------
  // SCENARIO B: Genuinely new call or distinct recording. Proceed with atomic
  // increment of callCount and repCallCounts.
  // ---------------------------------------------------------------------------
  if (cleanCallEventId && recordingObj && !recordingObj.callEventId) {
    recordingObj.callEventId = cleanCallEventId;
  }

  const callEntry = {
    callEventId: cleanCallEventId || null,
    salespersonId: repIdStr || null,
    salespersonName: repNameStr,
    callType: callType || "outgoing",
    status: status || (callDuration > 0 ? "connected" : "not-connected"),
    duration: callDuration,
    calledAt: callTimestamp,
    ...(recordingObj
      ? {
          recordingUrl: recordingObj.url || null,
          recordingName: recordingObj.name || null,
          recordingId: recordingObj._id || null,
        }
      : {}),
  };

  const existingRepIndex = (lead.repCallCounts || []).findIndex((rep) => {
    if (repIdStr && rep.salespersonId && String(rep.salespersonId) === repIdStr) {
      return true;
    }
    if (repNameStr && rep.salespersonName && rep.salespersonName.toLowerCase() === repNameStr.toLowerCase()) {
      return true;
    }
    return false;
  });

  let updatedLead = null;

  if (existingRepIndex >= 0) {
    // Rep already exists in array. Direct index access avoids positional operator ($) errors.
    const updateOps = {
      $inc: {
        callCount: 1,
        [`repCallCounts.${existingRepIndex}.count`]: 1,
      },
      $set: {
        lastCallAt: callTimestamp,
        [`repCallCounts.${existingRepIndex}.lastCalledAt`]: callTimestamp,
        ...(repNameStr ? { [`repCallCounts.${existingRepIndex}.salespersonName`]: repNameStr } : {}),
        ...(repIdStr ? { [`repCallCounts.${existingRepIndex}.salespersonId`]: repIdStr } : {}),
      },
      $push: {
        callHistory: callEntry,
        ...(recordingObj ? { recordings: recordingObj } : {}),
      },
    };

    const insertFilter = cleanCallEventId
      ? {
          _id: lead._id,
          callHistory: { $not: { $elemMatch: { callEventId: cleanCallEventId } } },
        }
      : { _id: lead._id };
    updatedLead = await LeadModel.findOneAndUpdate(
      insertFilter,
      updateOps,
      { new: true, returnDocument: "after" }
    );
  } else {
    // Rep does NOT exist in array yet. Atomically $push new subdocument and call entry.
    const pushOps = {
      $inc: { callCount: 1 },
      $set: { lastCallAt: callTimestamp },
      $push: {
        repCallCounts: {
          salespersonId: repIdStr || null,
          salespersonName: repNameStr,
          count: 1,
          lastCalledAt: callTimestamp,
        },
        callHistory: callEntry,
        ...(recordingObj ? { recordings: recordingObj } : {}),
      },
    };

    const insertFilter = cleanCallEventId
      ? {
          _id: lead._id,
          callHistory: { $not: { $elemMatch: { callEventId: cleanCallEventId } } },
        }
      : { _id: lead._id };
    updatedLead = await LeadModel.findOneAndUpdate(
      insertFilter,
      pushOps,
      { new: true, returnDocument: "after" }
    );
  }

  // A concurrent request may have inserted the same event after our initial read.
  // The conditional insert above makes exactly one request increment the counters;
  // reload the winner and attach any recording data without incrementing again.
  if (!updatedLead && cleanCallEventId) {
    const latestLead = await LeadModel.findOne({ _id: lead._id });
    const latestHistory = latestLead?.callHistory || [];
    const duplicateIndex = latestHistory.findIndex(
      (entry) => entry.callEventId && String(entry.callEventId).trim() === cleanCallEventId
    );
    if (duplicateIndex >= 0) {
      const duplicate = latestHistory[duplicateIndex];
      const mergeSet = {};
      const mergeUpdate = { $set: mergeSet };
      if (recordingObj) {
        mergeSet[`callHistory.${duplicateIndex}.recordingUrl`] = recordingObj.url || null;
        mergeSet[`callHistory.${duplicateIndex}.recordingName`] = recordingObj.name || null;
        mergeSet[`callHistory.${duplicateIndex}.recordingId`] = recordingObj._id || null;
        const hasRecording = (latestLead.recordings || []).some(
          (item) => item.callEventId === cleanCallEventId ||
            (recordingObj.url && item.url === recordingObj.url)
        );
        if (!hasRecording) {
          recordingObj.callEventId = cleanCallEventId;
          mergeUpdate.$push = { recordings: recordingObj };
        }
      }
      if (callDuration > 0 && !duplicate.duration) {
        mergeSet[`callHistory.${duplicateIndex}.duration`] = callDuration;
        mergeSet[`callHistory.${duplicateIndex}.status`] = "connected";
      }
      if (Object.keys(mergeSet).length > 0 || mergeUpdate.$push) {
        return await LeadModel.findOneAndUpdate(
          { _id: lead._id, [`callHistory.${duplicateIndex}.callEventId`]: cleanCallEventId },
          mergeUpdate,
          { new: true, returnDocument: "after" }
        );
      }
      return latestLead;
    }
  }

  return updatedLead;
};
