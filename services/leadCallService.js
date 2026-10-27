import mongoose from "mongoose";

/**
 * Atomically records a call / audio recording onto a Lead in MongoDB.
 * Uses atomic MongoDB operators ($inc, $set, $push) to guarantee
 * zero race conditions or overwritten counts during concurrent calls/uploads.
 *
 * @param {Object} params
 * @param {Object} params.LeadModel - The tenant-scoped Lead Mongoose model
 * @param {string} [params.leadId] - Lead ObjectId string
 * @param {string} [params.phone] - Phone number to locate lead
 * @param {string|Object} [params.salespersonId] - Authenticated salesperson ID
 * @param {string} [params.salespersonName] - Authenticated salesperson display name
 * @param {Object} [params.recordingObj] - Optional recording subdocument to append to recordings array
 * @returns {Promise<Object|null>} Updated lead document or null if lead not found
 */
export const recordLeadCallAtomic = async ({
  LeadModel,
  leadId,
  phone,
  salespersonId,
  salespersonName,
  recordingObj = null,
}) => {
  if (!LeadModel) {
    throw new Error("LeadModel is required for recordLeadCallAtomic");
  }

  const now = new Date();
  const repIdStr = salespersonId ? String(salespersonId).trim() : null;
  const repNameStr = salespersonName ? String(salespersonName).trim() : "Sales Representative";
  const escapedName = repNameStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

  // Conditions to match rep in repCallCounts array
  const repOrConditions = [];
  if (repIdStr && mongoose.Types.ObjectId.isValid(repIdStr)) {
    repOrConditions.push({ "repCallCounts.salespersonId": new mongoose.Types.ObjectId(repIdStr) });
    repOrConditions.push({ "repCallCounts.salespersonId": repIdStr });
  } else if (repIdStr) {
    repOrConditions.push({ "repCallCounts.salespersonId": repIdStr });
  }
  if (repNameStr) {
    repOrConditions.push({ "repCallCounts.salespersonName": new RegExp("^" + escapedName + "$", "i") });
  }

  if (repOrConditions.length === 0) {
    repOrConditions.push({ "repCallCounts.salespersonName": "Sales Representative" });
  }

  // ATTEMPT 1: Atomically update if rep ALREADY exists in repCallCounts array
  const updateExistingQuery = {
    ...baseQuery,
    $or: repOrConditions,
  };

  const updateExistingOps = {
    $inc: {
      callCount: 1,
      "repCallCounts.$.count": 1,
    },
    $set: {
      lastCallAt: now,
      "repCallCounts.$.lastCalledAt": now,
      ...(repNameStr ? { "repCallCounts.$.salespersonName": repNameStr } : {}),
      ...(repIdStr ? { "repCallCounts.$.salespersonId": repIdStr } : {}),
    },
  };

  if (recordingObj) {
    updateExistingOps.$push = { recordings: recordingObj };
  }

  let updatedLead = await LeadModel.findOneAndUpdate(
    updateExistingQuery,
    updateExistingOps,
    { new: true, returnDocument: "after" },
  );

  // ATTEMPT 2: If rep does NOT exist in repCallCounts, atomically push new rep subdocument
  if (!updatedLead) {
    const updateNewOps = {
      $inc: { callCount: 1 },
      $set: { lastCallAt: now },
      $push: {
        repCallCounts: {
          salespersonId: repIdStr || null,
          salespersonName: repNameStr,
          count: 1,
          lastCalledAt: now,
        },
        ...(recordingObj ? { recordings: recordingObj } : {}),
      },
    };

    // Use $nor to prevent race condition where a concurrent request pushed the rep in the same millisecond
    updatedLead = await LeadModel.findOneAndUpdate(
      {
        ...baseQuery,
        $nor: repOrConditions,
      },
      updateNewOps,
      { new: true, returnDocument: "after" },
    );

    // If still null, it means a concurrent request pushed this rep just before our second attempt.
    // Retry Attempt 1 once to guarantee counter increment without dropping counts:
    if (!updatedLead) {
      updatedLead = await LeadModel.findOneAndUpdate(
        updateExistingQuery,
        updateExistingOps,
        { new: true, returnDocument: "after" },
      );
    }
  }

  return updatedLead;
};
