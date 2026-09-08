import { getMasterModels } from "./tenantManager.js";

/**
 * Returns today's UTC date string in YYYY-MM-DD format
 */
export const getTodayDateString = () => {
  return new Date().toISOString().slice(0, 10);
};

/**
 * Ensures dailyAiUsage counters are up-to-date for today.
 * If the recorded date is before today, resets chat, audio, and total calls to 0.
 * @param {Object} org - Organization mongoose document or plain object
 * @returns {Object} normalized dailyAiUsage object
 */
export const checkAndResetDailyAiUsage = (org) => {
  if (!org) return null;
  const today = getTodayDateString();

  if (!org.aiSettings) {
    org.aiSettings = {};
  }

  if (!org.aiSettings.dailyAiUsage) {
    org.aiSettings.dailyAiUsage = {
      date: today,
      chatApiCalls: 0,
      audioApiCalls: 0,
      totalApiCalls: 0,
      dailyQuotaLimit: 1500,
      lastResetAt: new Date(),
    };
    return org.aiSettings.dailyAiUsage;
  }

  // If stored date does not match today's date, refresh and reset everyday!
  if (org.aiSettings.dailyAiUsage.date !== today) {
    org.aiSettings.dailyAiUsage.date = today;
    org.aiSettings.dailyAiUsage.chatApiCalls = 0;
    org.aiSettings.dailyAiUsage.audioApiCalls = 0;
    org.aiSettings.dailyAiUsage.totalApiCalls = 0;
    org.aiSettings.dailyAiUsage.dailyQuotaLimit =
      org.aiSettings.dailyAiUsage.dailyQuotaLimit || 1500;
    org.aiSettings.dailyAiUsage.lastResetAt = new Date();
  }

  return org.aiSettings.dailyAiUsage;
};

/**
 * Records an AI API call usage increment for an organization.
 * @param {string|Object} orgId - The organization ID
 * @param {'chat'|'audio'} type - Call purpose / type
 * @param {number} count - Number of calls to increment (default: 1)
 */
export const recordAiUsage = async (orgId, type = "chat", count = 1) => {
  if (!orgId) return null;
  try {
    const { Organization } = getMasterModels();
    const org = await Organization.findById(orgId);
    if (!org) return null;

    checkAndResetDailyAiUsage(org);

    if (type === "chat") {
      org.aiSettings.dailyAiUsage.chatApiCalls =
        (org.aiSettings.dailyAiUsage.chatApiCalls || 0) + count;
    } else if (type === "audio") {
      org.aiSettings.dailyAiUsage.audioApiCalls =
        (org.aiSettings.dailyAiUsage.audioApiCalls || 0) + count;
    }

    org.aiSettings.dailyAiUsage.totalApiCalls =
      (org.aiSettings.dailyAiUsage.chatApiCalls || 0) +
      (org.aiSettings.dailyAiUsage.audioApiCalls || 0);

    org.markModified("aiSettings");
    await org.save();

    console.log(
      `[AI Usage] Recorded +${count} ${type} API call(s) for org "${org.name || orgId}". Daily total: ${org.aiSettings.dailyAiUsage.totalApiCalls}/${org.aiSettings.dailyAiUsage.dailyQuotaLimit || 1500} (Chats: ${org.aiSettings.dailyAiUsage.chatApiCalls}, Audio: ${org.aiSettings.dailyAiUsage.audioApiCalls})`
    );

    return org.aiSettings.dailyAiUsage;
  } catch (error) {
    console.error("[AI Usage] Failed to record AI usage:", error.message);
    return null;
  }
};
