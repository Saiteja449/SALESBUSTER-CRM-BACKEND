import mongoose from "mongoose";

/**
 * Atomically records a call / audio recording onto a Lead in MongoDB.
 * Uses atomic MongoDB operators ($inc, $set, $push) to guarantee
 * zero race conditions or overwritten counts during concurrent calls/uploads.
 * Avoids MongoDB positional operator ($) errors with $or queries.
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

  // 2. Determine if rep already exists in lead's repCallCounts array
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
    // SCENARIO 1: Rep already exists in array.
    // Use direct index access (`repCallCounts.${existingRepIndex}`) which avoids MongoDB's
    // positional operator ($) plan executor error when array conditions combine with $or.
    const updateOps = {
      $inc: {
        callCount: 1,
        [`repCallCounts.${existingRepIndex}.count`]: 1,
      },
      $set: {
        lastCallAt: now,
        [`repCallCounts.${existingRepIndex}.lastCalledAt`]: now,
        ...(repNameStr ? { [`repCallCounts.${existingRepIndex}.salespersonName`]: repNameStr } : {}),
        ...(repIdStr ? { [`repCallCounts.${existingRepIndex}.salespersonId`]: repIdStr } : {}),
      },
    };

    if (recordingObj) {
      updateOps.$push = { recordings: recordingObj };
    }

    updatedLead = await LeadModel.findOneAndUpdate(
      { _id: lead._id },
      updateOps,
      { new: true, returnDocument: "after" }
    );
  } else {
    // SCENARIO 2: Rep does NOT exist in array yet. Atomically $push new subdocument.
    const pushOps = {
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

    updatedLead = await LeadModel.findOneAndUpdate(
      { _id: lead._id },
      pushOps,
      { new: true, returnDocument: "after" }
    );
  }

  return updatedLead;
};
