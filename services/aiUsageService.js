import { getMasterModels } from "./tenantManager.js";
import { getIO } from "../socket/socket.js";

export const DEFAULT_DAILY_QUOTA_LIMIT = 500;

/**
 * Returns today's UTC date string in YYYY-MM-DD format
 */
export const getTodayDateString = () => {
  return new Date().toISOString().slice(0, 10);
};

/**
 * Returns the default quota split based on whether biAnalyst addon is active
 */
export const getDefaultQuotaSplit = (isBiAnalystActive = false) => {
  if (isBiAnalystActive) {
    return {
      whatsappAi: 250,
      calls: 150,
      biAnalyst: 100,
    };
  }
  return {
    whatsappAi: 300,
    calls: 200,
    biAnalyst: 0,
  };
};

/**
 * Normalizes and ensures dailyAiUsage counters are up-to-date for today.
 * If the recorded date is before today, resets chat, audio, bi, and total calls to 0.
 * @param {Object} org - Organization mongoose document or plain object
 * @returns {Object} normalized dailyAiUsage object
 */
export const checkAndResetDailyAiUsage = (org) => {
  if (!org) return null;
  const today = getTodayDateString();

  if (!org.aiSettings) {
    org.aiSettings = {};
  }

  const isBiActive = Boolean(org.addons?.biAnalyst);

  if (!org.aiSettings.dailyAiUsage) {
    const defaultSplit = getDefaultQuotaSplit(isBiActive);
    org.aiSettings.dailyAiUsage = {
      date: today,
      chatApiCalls: 0,
      audioApiCalls: 0,
      whatsappAiCalls: 0,
      callsApiCalls: 0,
      biAnalystCalls: 0,
      totalApiCalls: 0,
      dailyQuotaLimit: DEFAULT_DAILY_QUOTA_LIMIT,
      quotaSplit: defaultSplit,
      lastResetAt: new Date(),
    };
    return org.aiSettings.dailyAiUsage;
  }

  // Ensure dailyQuotaLimit is fixed at 500
  org.aiSettings.dailyAiUsage.dailyQuotaLimit = DEFAULT_DAILY_QUOTA_LIMIT;

  // Ensure quotaSplit exists and is valid
  if (!org.aiSettings.dailyAiUsage.quotaSplit) {
    org.aiSettings.dailyAiUsage.quotaSplit = getDefaultQuotaSplit(isBiActive);
  } else {
    // If biAnalyst is not active, force biAnalyst split to 0 and reallocate to whatsappAi
    if (!isBiActive && (org.aiSettings.dailyAiUsage.quotaSplit.biAnalyst || 0) > 0) {
      org.aiSettings.dailyAiUsage.quotaSplit.whatsappAi =
        (org.aiSettings.dailyAiUsage.quotaSplit.whatsappAi || 250) +
        org.aiSettings.dailyAiUsage.quotaSplit.biAnalyst;
      org.aiSettings.dailyAiUsage.quotaSplit.biAnalyst = 0;
    }
  }

  // If stored date does not match today's date, refresh and reset everyday!
  if (org.aiSettings.dailyAiUsage.date !== today) {
    org.aiSettings.dailyAiUsage.date = today;
    org.aiSettings.dailyAiUsage.chatApiCalls = 0;
    org.aiSettings.dailyAiUsage.audioApiCalls = 0;
    org.aiSettings.dailyAiUsage.whatsappAiCalls = 0;
    org.aiSettings.dailyAiUsage.callsApiCalls = 0;
    org.aiSettings.dailyAiUsage.biAnalystCalls = 0;
    org.aiSettings.dailyAiUsage.totalApiCalls = 0;
    org.aiSettings.dailyAiUsage.lastResetAt = new Date();
  }

  // Ensure channel counters are synced if legacy values exist
  if (
    org.aiSettings.dailyAiUsage.whatsappAiCalls === undefined &&
    org.aiSettings.dailyAiUsage.chatApiCalls !== undefined
  ) {
    org.aiSettings.dailyAiUsage.whatsappAiCalls = org.aiSettings.dailyAiUsage.chatApiCalls;
  }
  if (
    org.aiSettings.dailyAiUsage.callsApiCalls === undefined &&
    org.aiSettings.dailyAiUsage.audioApiCalls !== undefined
  ) {
    org.aiSettings.dailyAiUsage.callsApiCalls = org.aiSettings.dailyAiUsage.audioApiCalls;
  }
  if (org.aiSettings.dailyAiUsage.biAnalystCalls === undefined) {
    org.aiSettings.dailyAiUsage.biAnalystCalls = 0;
  }

  return org.aiSettings.dailyAiUsage;
};

/**
 * Checks whether an organization has remaining daily quota for a specific channel.
 * @param {string|Object} orgOrId - Organization document or ID
 * @param {'whatsapp'|'chat'|'calls'|'audio'|'biAnalyst'|'assistant'} type - Channel
 * @param {number} count - Units requested (default 1)
 * @returns {Promise<{ allowed: boolean, reason?: string, channel?: string, used?: number, limit?: number, totalUsed?: number, totalLimit?: number }>}
 */
export const checkAiQuotaAvailable = async (orgOrId, type = "whatsapp", count = 1) => {
  if (!orgOrId) {
    return { allowed: false, reason: "Organization context not provided" };
  }

  try {
    let org = orgOrId;
    if (typeof orgOrId === "string" || orgOrId._bsontype) {
      const { Organization } = getMasterModels();
      org = await Organization.findById(orgOrId);
    }
    if (!org) {
      return { allowed: false, reason: "Organization not found" };
    }

    checkAndResetDailyAiUsage(org);
    const usage = org.aiSettings?.dailyAiUsage;
    const totalLimit = usage?.dailyQuotaLimit || DEFAULT_DAILY_QUOTA_LIMIT;
    const totalUsed = Number(usage?.totalApiCalls) || 0;

    // 1. Overall organization 500 limit check
    if (totalUsed + count > totalLimit) {
      return {
        allowed: false,
        reason: `Daily organization conversation limit of ${totalLimit} reached for today (${totalUsed}/${totalLimit}). Resets at 00:00 UTC.`,
        channel: type,
        used: totalUsed,
        limit: totalLimit,
        totalUsed,
        totalLimit,
      };
    }

    // 2. Specific channel split check
    const normalizedType =
      type === "chat" ? "whatsapp" : type === "audio" ? "calls" : type === "assistant" ? "biAnalyst" : type;

    const split = usage?.quotaSplit || getDefaultQuotaSplit(Boolean(org.addons?.biAnalyst));

    let channelLimit = 0;
    let channelUsed = 0;

    if (normalizedType === "whatsapp") {
      channelLimit = Number(split.whatsappAi) || 0;
      channelUsed = Number(usage?.whatsappAiCalls ?? usage?.chatApiCalls) || 0;
    } else if (normalizedType === "calls") {
      channelLimit = Number(split.calls) || 0;
      channelUsed = Number(usage?.callsApiCalls ?? usage?.audioApiCalls) || 0;
    } else if (normalizedType === "biAnalyst") {
      if (!org.addons?.biAnalyst) {
        return {
          allowed: false,
          reason: "BI Analyst add-on is not active for this organization.",
          channel: normalizedType,
          used: 0,
          limit: 0,
          totalUsed,
          totalLimit,
        };
      }
      channelLimit = Number(split.biAnalyst) || 0;
      channelUsed = Number(usage?.biAnalystCalls) || 0;
    }

    if (channelUsed + count > channelLimit) {
      const channelLabel =
        normalizedType === "whatsapp"
          ? "WhatsApp AI Chat Bot"
          : normalizedType === "calls"
          ? "Call Recording Analysis"
          : "BI Analyst";
      return {
        allowed: false,
        reason: `Daily quota limit for ${channelLabel} reached (${channelUsed}/${channelLimit}). Resets at 00:00 UTC.`,
        channel: normalizedType,
        used: channelUsed,
        limit: channelLimit,
        totalUsed,
        totalLimit,
      };
    }

    return {
      allowed: true,
      channel: normalizedType,
      used: channelUsed,
      limit: channelLimit,
      remainingChannel: channelLimit - channelUsed,
      totalUsed,
      totalLimit,
      remainingTotal: totalLimit - totalUsed,
    };
  } catch (err) {
    console.error("[AI Usage] Error in checkAiQuotaAvailable:", err.message);
    return {
      allowed: false,
      reason: "Daily AI conversation quota verification failed. Please try again shortly.",
      error: err.message,
    };
  }
};

/**
 * Atomically reserves AI conversation quota for an organization before calling model.
 * Uses atomic MongoDB findOneAndUpdate with condition checks to eliminate concurrency race conditions.
 *
 * @param {string|Object} orgOrId - Organization document or ID
 * @param {'whatsapp'|'chat'|'calls'|'audio'|'biAnalyst'|'assistant'} type - Channel
 * @param {number} count - Units to reserve (default 1)
 * @returns {Promise<{ allowed: boolean, reason?: string, channel?: string, used?: number, limit?: number, totalUsed?: number, totalLimit?: number, dailyAiUsage?: Object }>}
 */
export const reserveAiQuota = async (orgOrId, type = "whatsapp", count = 1) => {
  if (!orgOrId || count <= 0) {
    return { allowed: false, reason: "Invalid organization or quota request" };
  }

  const normalizedType =
    type === "chat" ? "whatsapp" : type === "audio" ? "calls" : type === "assistant" ? "biAnalyst" : type;

  try {
    const today = getTodayDateString();
    let Organization = null;
    try {
      const models = getMasterModels();
      Organization = models?.Organization;
    } catch (_) {}

    const isPlainObject =
      typeof orgOrId === "object" &&
      !orgOrId.save &&
      (!orgOrId._id || typeof orgOrId._id === "string" || !orgOrId._id?.getTimestamp);

    // A reservation must be persisted before AI work starts. Never approve a
    // request from an in-memory copy when the master model is unavailable.
    if (!Organization) {
      return {
        allowed: false,
        reason: "Daily AI conversation quota could not be verified. Please try again shortly.",
      };
    }

    // In-memory fallback is only for plain-object test fixtures with synthetic
    // IDs. Production organizations have Mongo ObjectIds (or valid ObjectId
    // strings) and must use the persisted atomic reservation below.
    const isSyntheticTestFixture =
      isPlainObject &&
      typeof orgOrId._id === "string" &&
      !/^[a-f\d]{24}$/i.test(orgOrId._id);
    if (isSyntheticTestFixture) {
      const org = orgOrId;
      checkAndResetDailyAiUsage(org);
      const usage = org.aiSettings?.dailyAiUsage;
      const totalLimit = usage?.dailyQuotaLimit || DEFAULT_DAILY_QUOTA_LIMIT;
      const totalUsed = Number(usage?.totalApiCalls) || 0;

      if (totalUsed + count > totalLimit) {
        return {
          allowed: false,
          reason: `Daily organization conversation limit of ${totalLimit} reached for today (${totalUsed}/${totalLimit}). Resets at 00:00 UTC.`,
          channel: normalizedType,
          used: totalUsed,
          limit: totalLimit,
          totalUsed,
          totalLimit,
        };
      }

      const split = usage?.quotaSplit || getDefaultQuotaSplit(Boolean(org.addons?.biAnalyst));
      let channelLimit = 0;
      let channelUsed = 0;

      if (normalizedType === "whatsapp") {
        channelLimit = Number(split.whatsappAi) || 0;
        channelUsed = Number(usage?.whatsappAiCalls ?? usage?.chatApiCalls) || 0;
      } else if (normalizedType === "calls") {
        channelLimit = Number(split.calls) || 0;
        channelUsed = Number(usage?.callsApiCalls ?? usage?.audioApiCalls) || 0;
      } else if (normalizedType === "biAnalyst") {
        if (!org.addons?.biAnalyst) {
          return {
            allowed: false,
            reason: "BI Analyst add-on is not active for this organization.",
            channel: normalizedType,
            used: 0,
            limit: 0,
            totalUsed,
            totalLimit,
          };
        }
        channelLimit = Number(split.biAnalyst) || 0;
        channelUsed = Number(usage?.biAnalystCalls) || 0;
      }

      if (channelUsed + count > channelLimit) {
        const channelLabel =
          normalizedType === "whatsapp"
            ? "WhatsApp AI Chat Bot"
            : normalizedType === "calls"
            ? "Call Recording Analysis"
            : "BI Analyst";
        return {
          allowed: false,
          reason: `Daily quota limit for ${channelLabel} reached (${channelUsed}/${channelLimit}). Resets at 00:00 UTC.`,
          channel: normalizedType,
          used: channelUsed,
          limit: channelLimit,
          totalUsed,
          totalLimit,
        };
      }

      // Mutate in-memory counters atomically
      if (normalizedType === "whatsapp") {
        usage.whatsappAiCalls = channelUsed + count;
        usage.chatApiCalls = usage.whatsappAiCalls;
      } else if (normalizedType === "calls") {
        usage.callsApiCalls = channelUsed + count;
        usage.audioApiCalls = usage.callsApiCalls;
      } else if (normalizedType === "biAnalyst") {
        usage.biAnalystCalls = channelUsed + count;
      }
      usage.totalApiCalls = totalUsed + count;

      return {
        allowed: true,
        channel: normalizedType,
        used: channelUsed + count,
        limit: channelLimit,
        remainingChannel: channelLimit - (channelUsed + count),
        totalUsed: usage.totalApiCalls,
        totalLimit,
        remainingTotal: totalLimit - usage.totalApiCalls,
        dailyAiUsage: usage,
      };
    }

    // Database flow: fetch organization to check add-ons and settings
    const orgId = orgOrId?._id || orgOrId;
    const org = await Organization.findById(orgId);
    if (!org) {
      return { allowed: false, reason: "Organization not found" };
    }

    const isBiActive = Boolean(org.addons?.biAnalyst);
    if (normalizedType === "biAnalyst" && !isBiActive) {
      return {
        allowed: false,
        reason: "BI Analyst add-on is not active for this organization.",
        channel: normalizedType,
        used: 0,
        limit: 0,
      };
    }

    // If date changed or dailyAiUsage not initialized, reset atomically
    if (org.aiSettings?.dailyAiUsage?.date !== today) {
      const defaultSplit = getDefaultQuotaSplit(isBiActive);
      const preservedSplit = org.aiSettings?.dailyAiUsage?.quotaSplit || defaultSplit;
      if (!isBiActive && (preservedSplit.biAnalyst || 0) > 0) {
        preservedSplit.whatsappAi = (preservedSplit.whatsappAi || 250) + preservedSplit.biAnalyst;
        preservedSplit.biAnalyst = 0;
      }

      await Organization.updateOne(
        {
          _id: org._id,
          $or: [
            { "aiSettings.dailyAiUsage.date": { $ne: today } },
            { "aiSettings.dailyAiUsage": { $exists: false } },
          ],
        },
        {
          $set: {
            "aiSettings.dailyAiUsage.date": today,
            "aiSettings.dailyAiUsage.whatsappAiCalls": 0,
            "aiSettings.dailyAiUsage.callsApiCalls": 0,
            "aiSettings.dailyAiUsage.biAnalystCalls": 0,
            "aiSettings.dailyAiUsage.chatApiCalls": 0,
            "aiSettings.dailyAiUsage.audioApiCalls": 0,
            "aiSettings.dailyAiUsage.totalApiCalls": 0,
            "aiSettings.dailyAiUsage.dailyQuotaLimit": DEFAULT_DAILY_QUOTA_LIMIT,
            "aiSettings.dailyAiUsage.quotaSplit": preservedSplit,
            "aiSettings.dailyAiUsage.lastResetAt": new Date(),
          },
        }
      );
    }

    // Refresh limits from database
    const freshOrg = await Organization.findById(org._id).lean();
    const usage = freshOrg?.aiSettings?.dailyAiUsage;
    const split = usage?.quotaSplit || getDefaultQuotaSplit(isBiActive);
    const totalLimit = usage?.dailyQuotaLimit || DEFAULT_DAILY_QUOTA_LIMIT;

    let channelLimit = 0;
    let channelField = "";
    let legacyField = null;

    if (normalizedType === "whatsapp") {
      channelLimit = Number(split.whatsappAi) || 0;
      channelField = "aiSettings.dailyAiUsage.whatsappAiCalls";
      legacyField = "aiSettings.dailyAiUsage.chatApiCalls";
    } else if (normalizedType === "calls") {
      channelLimit = Number(split.calls) || 0;
      channelField = "aiSettings.dailyAiUsage.callsApiCalls";
      legacyField = "aiSettings.dailyAiUsage.audioApiCalls";
    } else if (normalizedType === "biAnalyst") {
      channelLimit = Number(split.biAnalyst) || 0;
      channelField = "aiSettings.dailyAiUsage.biAnalystCalls";
    }

    const incUpdates = {
      "aiSettings.dailyAiUsage.totalApiCalls": count,
      [channelField]: count,
    };
    if (legacyField) {
      incUpdates[legacyField] = count;
    }

    // Atomic reservation: only increment if remaining total AND remaining channel quota >= count
    const updatedOrg = await Organization.findOneAndUpdate(
      {
        _id: org._id,
        "aiSettings.dailyAiUsage.date": today,
        "aiSettings.dailyAiUsage.totalApiCalls": { $lte: totalLimit - count },
        [channelField]: { $lte: channelLimit - count },
      },
      {
        $inc: incUpdates,
      },
      {
        new: true,
      }
    );

    if (!updatedOrg) {
      // Reservation rejected: identify whether channel or total quota was exceeded
      const currentOrg = await Organization.findById(org._id).lean();
      const currentUsage = currentOrg?.aiSettings?.dailyAiUsage;
      const currentTotal = Number(currentUsage?.totalApiCalls) || 0;
      let currentChannel = 0;

      if (normalizedType === "whatsapp") {
        currentChannel = Number(currentUsage?.whatsappAiCalls ?? currentUsage?.chatApiCalls) || 0;
      } else if (normalizedType === "calls") {
        currentChannel = Number(currentUsage?.callsApiCalls ?? currentUsage?.audioApiCalls) || 0;
      } else if (normalizedType === "biAnalyst") {
        currentChannel = Number(currentUsage?.biAnalystCalls) || 0;
      }

      const channelLabel =
        normalizedType === "whatsapp"
          ? "WhatsApp AI Chat Bot"
          : normalizedType === "calls"
          ? "Call Recording Analysis"
          : "BI Analyst";

      if (currentTotal + count > totalLimit) {
        return {
          allowed: false,
          reason: `Daily organization conversation limit of ${totalLimit} reached for today (${currentTotal}/${totalLimit}). Resets at 00:00 UTC.`,
          channel: normalizedType,
          used: currentTotal,
          limit: totalLimit,
          totalUsed: currentTotal,
          totalLimit,
        };
      }

      return {
        allowed: false,
        reason: `Daily quota limit for ${channelLabel} reached (${currentChannel}/${channelLimit}). Resets at 00:00 UTC.`,
        channel: normalizedType,
        used: currentChannel,
        limit: channelLimit,
        totalUsed: currentTotal,
        totalLimit,
      };
    }

    // Broadcast real-time socket update
    try {
      const io = getIO();
      if (io) {
        io.to(`org_${org._id}`).emit("daily_ai_usage_updated", {
          orgId: org._id.toString(),
          dailyAiUsage: updatedOrg.aiSettings.dailyAiUsage,
        });
      }
    } catch (_) {}

    const resUsage = updatedOrg.aiSettings.dailyAiUsage;
    let reservedChannelUsed = 0;
    if (normalizedType === "whatsapp") {
      reservedChannelUsed = resUsage.whatsappAiCalls;
    } else if (normalizedType === "calls") {
      reservedChannelUsed = resUsage.callsApiCalls;
    } else if (normalizedType === "biAnalyst") {
      reservedChannelUsed = resUsage.biAnalystCalls;
    }

    return {
      allowed: true,
      channel: normalizedType,
      used: reservedChannelUsed,
      limit: channelLimit,
      remainingChannel: channelLimit - reservedChannelUsed,
      totalUsed: resUsage.totalApiCalls,
      totalLimit,
      remainingTotal: totalLimit - resUsage.totalApiCalls,
      dailyAiUsage: resUsage,
    };
  } catch (err) {
    console.error("[AI Usage] Error in reserveAiQuota:", err.message);
    return {
      allowed: false,
      reason: "Daily AI conversation quota verification failed. Please try again shortly.",
      error: err.message,
    };
  }
};

/**
 * Compensatory release of reserved quota if downstream model call fails.
 * @param {string|Object} orgOrId - Organization document or ID
 * @param {'whatsapp'|'chat'|'calls'|'audio'|'biAnalyst'|'assistant'} type - Channel
 * @param {number} count - Units to release (default 1)
 */
export const releaseAiQuota = async (orgOrId, type = "whatsapp", count = 1) => {
  if (!orgOrId || count <= 0) return null;
  const normalizedType =
    type === "chat" ? "whatsapp" : type === "audio" ? "calls" : type === "assistant" ? "biAnalyst" : type;

  try {
    const orgId = orgOrId?._id || orgOrId;
    let Organization = null;
    try {
      const models = getMasterModels();
      Organization = models?.Organization;
    } catch (_) {}

    const isPlainObject =
      typeof orgOrId === "object" &&
      !orgOrId.save &&
      (!orgOrId._id || typeof orgOrId._id === "string" || !orgOrId._id?.getTimestamp);

    if (!Organization || isPlainObject) {
      if (typeof orgOrId === "object" && orgOrId.aiSettings?.dailyAiUsage) {
        const usage = orgOrId.aiSettings.dailyAiUsage;
        if (normalizedType === "whatsapp") {
          usage.whatsappAiCalls = Math.max(0, (usage.whatsappAiCalls || 0) - count);
          usage.chatApiCalls = usage.whatsappAiCalls;
        } else if (normalizedType === "calls") {
          usage.callsApiCalls = Math.max(0, (usage.callsApiCalls || 0) - count);
          usage.audioApiCalls = usage.callsApiCalls;
        } else if (normalizedType === "biAnalyst") {
          usage.biAnalystCalls = Math.max(0, (usage.biAnalystCalls || 0) - count);
        }
        usage.totalApiCalls = Math.max(0, (usage.totalApiCalls || 0) - count);
        return usage;
      }
      return null;
    }

    let channelField = "";
    let legacyField = null;
    if (normalizedType === "whatsapp") {
      channelField = "aiSettings.dailyAiUsage.whatsappAiCalls";
      legacyField = "aiSettings.dailyAiUsage.chatApiCalls";
    } else if (normalizedType === "calls") {
      channelField = "aiSettings.dailyAiUsage.callsApiCalls";
      legacyField = "aiSettings.dailyAiUsage.audioApiCalls";
    } else if (normalizedType === "biAnalyst") {
      channelField = "aiSettings.dailyAiUsage.biAnalystCalls";
    }

    const decUpdates = {
      "aiSettings.dailyAiUsage.totalApiCalls": -count,
      [channelField]: -count,
    };
    if (legacyField) {
      decUpdates[legacyField] = -count;
    }

    const updatedOrg = await Organization.findOneAndUpdate(
      { _id: orgId },
      { $inc: decUpdates },
      { new: true }
    );

    try {
      const io = getIO();
      if (io && updatedOrg) {
        io.to(`org_${orgId}`).emit("daily_ai_usage_updated", {
          orgId: orgId.toString(),
          dailyAiUsage: updatedOrg.aiSettings.dailyAiUsage,
        });
      }
    } catch (_) {}

    return updatedOrg?.aiSettings?.dailyAiUsage || null;
  } catch (err) {
    console.error("[AI Usage] Failed to release AI quota:", err.message);
    return null;
  }
};

/**
 * Records an AI API call usage increment for an organization.
 * @param {string|Object} orgId - The organization ID
 * @param {'whatsapp'|'chat'|'calls'|'audio'|'biAnalyst'|'assistant'} type - Call purpose / type
 * @param {number} count - Number of calls to increment (default: 1)
 */
export const recordAiUsage = async (orgId, type = "whatsapp", count = 1) => {
  if (!orgId) return null;
  try {
    const { Organization } = getMasterModels();
    const org = await Organization.findById(orgId);
    if (!org) return null;

    checkAndResetDailyAiUsage(org);

    const normalizedType =
      type === "chat" ? "whatsapp" : type === "audio" ? "calls" : type === "assistant" ? "biAnalyst" : type;

    if (normalizedType === "whatsapp") {
      org.aiSettings.dailyAiUsage.whatsappAiCalls =
        (org.aiSettings.dailyAiUsage.whatsappAiCalls || 0) + count;
      org.aiSettings.dailyAiUsage.chatApiCalls =
        org.aiSettings.dailyAiUsage.whatsappAiCalls;
    } else if (normalizedType === "calls") {
      org.aiSettings.dailyAiUsage.callsApiCalls =
        (org.aiSettings.dailyAiUsage.callsApiCalls || 0) + count;
      org.aiSettings.dailyAiUsage.audioApiCalls =
        org.aiSettings.dailyAiUsage.callsApiCalls;
    } else if (normalizedType === "biAnalyst") {
      org.aiSettings.dailyAiUsage.biAnalystCalls =
        (org.aiSettings.dailyAiUsage.biAnalystCalls || 0) + count;
    }

    org.aiSettings.dailyAiUsage.totalApiCalls =
      (org.aiSettings.dailyAiUsage.whatsappAiCalls || 0) +
      (org.aiSettings.dailyAiUsage.callsApiCalls || 0) +
      (org.aiSettings.dailyAiUsage.biAnalystCalls || 0);

    org.markModified("aiSettings");
    await org.save();

    console.log(
      `[AI Usage] Recorded +${count} ${normalizedType} API call(s) for org "${org.name || orgId}". Daily total: ${org.aiSettings.dailyAiUsage.totalApiCalls}/${org.aiSettings.dailyAiUsage.dailyQuotaLimit || DEFAULT_DAILY_QUOTA_LIMIT} (WhatsApp: ${org.aiSettings.dailyAiUsage.whatsappAiCalls}, Calls: ${org.aiSettings.dailyAiUsage.callsApiCalls}, BI: ${org.aiSettings.dailyAiUsage.biAnalystCalls})`
    );

    // Emit real-time usage update via Socket.IO
    try {
      const io = getIO();
      if (io) {
        io.to(`org_${orgId}`).emit("daily_ai_usage_updated", {
          orgId: orgId.toString(),
          dailyAiUsage: org.aiSettings.dailyAiUsage,
        });
      }
    } catch (socketErr) {
      // Non-blocking socket emission
    }

    return org.aiSettings.dailyAiUsage;
  } catch (error) {
    console.error("[AI Usage] Failed to record AI usage:", error.message);
    return null;
  }
};
