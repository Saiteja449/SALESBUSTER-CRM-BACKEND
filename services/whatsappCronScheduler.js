import cron from "node-cron";
import { getMasterModels, getTenantModels } from "./tenantManager.js";
import { processCampaignQueue } from "./whatsappCampaignWorker.js";
import { renderRecipientParameters } from "../controllers/whatsappCampaignController.js";
import {
  normalizePhoneNumber,
  buildLeadAudienceQuery,
} from "../controllers/whatsappCloudController.js";
import { getIO } from "../socket/socket.js";

const activeExecutionLocks = new Set();

/**
 * Builds a standard 5-part cron expression from a schedule configuration.
 * Format: minute hour dayOfMonth month dayOfWeek
 */
export const buildCronExpression = (schedule = {}) => {
  const { frequency, timeOfDay = "10:00", daysOfWeek = [1], dayOfMonth = 1 } = schedule;

  const [hourStr, minStr] = String(timeOfDay).split(":");
  const hour = parseInt(hourStr, 10) || 0;
  const minute = parseInt(minStr, 10) || 0;

  switch (frequency) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly": {
      const days = Array.isArray(daysOfWeek) && daysOfWeek.length > 0
        ? [...new Set(daysOfWeek)].sort().join(",")
        : "1"; // Default Monday
      return `${minute} ${hour} * * ${days}`;
    }
    case "monthly": {
      const dom = Math.min(31, Math.max(1, parseInt(dayOfMonth, 10) || 1));
      return `${minute} ${hour} ${dom} * *`;
    }
    case "once":
    case "custom":
    default:
      return `${minute} ${hour} * * *`;
  }
};

/**
 * Pure helper to calculate the next execution Date object for a schedule.
 */
export const calculateNextRun = (schedule = {}, fromDate = new Date()) => {
  const now = new Date(fromDate);
  const [hourStr, minStr] = String(schedule.timeOfDay || "10:00").split(":");
  const targetHour = parseInt(hourStr, 10) || 0;
  const targetMinute = parseInt(minStr, 10) || 0;

  const frequency = schedule.frequency || "once";

  if (frequency === "once") {
    if (schedule.startDate) {
      const target = new Date(schedule.startDate);
      target.setHours(targetHour, targetMinute, 0, 0);
      return target;
    }
    const target = new Date(now);
    target.setHours(targetHour, targetMinute, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return target;
  }

  if (frequency === "daily") {
    const next = new Date(now);
    next.setHours(targetHour, targetMinute, 0, 0);
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }

  if (frequency === "weekly") {
    const rawDays = Array.isArray(schedule.daysOfWeek) && schedule.daysOfWeek.length > 0
      ? schedule.daysOfWeek
      : [1]; // default Monday
    const validDays = [...new Set(rawDays.map((d) => Number(d) % 7))].sort((a, b) => a - b);

    // Check upcoming days starting today through next 7 days
    for (let offset = 0; offset <= 7; offset++) {
      const candidate = new Date(now);
      candidate.setDate(candidate.getDate() + offset);
      candidate.setHours(targetHour, targetMinute, 0, 0);

      const candidateDay = candidate.getDay();
      if (validDays.includes(candidateDay)) {
        if (candidate > now) {
          return candidate;
        }
      }
    }

    // Fallback: 7 days from now
    const fallback = new Date(now);
    fallback.setDate(fallback.getDate() + 7);
    fallback.setHours(targetHour, targetMinute, 0, 0);
    return fallback;
  }

  if (frequency === "monthly") {
    const dom = Math.min(28, Math.max(1, parseInt(schedule.dayOfMonth, 10) || 1));
    const next = new Date(now);
    next.setDate(dom);
    next.setHours(targetHour, targetMinute, 0, 0);
    if (next <= now) {
      next.setMonth(next.getMonth() + 1);
    }
    return next;
  }

  if (frequency === "custom") {
    const interval = Math.max(1, parseInt(schedule.intervalDays, 10) || 1);
    const next = new Date(now);
    next.setDate(next.getDate() + interval);
    next.setHours(targetHour, targetMinute, 0, 0);
    return next;
  }

  const fallback = new Date(now);
  fallback.setDate(fallback.getDate() + 1);
  fallback.setHours(targetHour, targetMinute, 0, 0);
  return fallback;
};

/**
 * Evaluates leads for a scheduled campaign iteration according to its audience criteria and delivery policy.
 */
export const evaluateAudienceForRun = async (campaign, tenantModels, org) => {
  const { Lead, WhatsAppOptOut, WhatsAppCampaignRecipient } = tenantModels;

  const leadQuery = buildLeadAudienceQuery(campaign.audienceCriteria || {});
  const allMatchingLeads = await Lead.find(leadQuery).lean();

  if (!allMatchingLeads || allMatchingLeads.length === 0) {
    return [];
  }

  // 1. Exclude opted-out phone numbers
  const optOutRecords = await WhatsAppOptOut.find({}).select("phone");
  const optOutSet = new Set(optOutRecords.map((r) => r.phone));

  const requireConsent = campaign.audienceCriteria?.requireConsent !== false;
  const policyMode = campaign.audiencePolicy?.mode || "cooldown";
  const cooldownDays = Number(campaign.audiencePolicy?.cooldownDays) || 7;

  // 2. Identify recently contacted recipients if cooldown policy applies
  let excludedPhoneSet = new Set();
  if (policyMode === "cooldown" && cooldownDays > 0) {
    const cooldownThreshold = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000);
    const recentRecipients = await WhatsAppCampaignRecipient.find({
      campaignId: campaign._id,
      createdAt: { $gte: cooldownThreshold },
    }).select("recipientPhone");
    excludedPhoneSet = new Set(recentRecipients.map((r) => r.recipientPhone));
  }

  const lastRunAt = campaign.schedule?.lastRunAt
    ? new Date(campaign.schedule.lastRunAt)
    : null;

  const runNumber = (campaign.schedule?.currentRunCount || 0) + 1;
  const phoneSeen = new Set();
  const recipientDocs = [];

  for (const lead of allMatchingLeads) {
    const cleanPhone = normalizePhoneNumber(lead.phone);
    if (!cleanPhone || cleanPhone.length < 10) continue;
    if (phoneSeen.has(cleanPhone)) continue;

    if (lead.isOptedOut || optOutSet.has(cleanPhone)) continue;
    if (requireConsent && lead.hasWhatsAppConsent === false) continue;

    // Delivery Rule 1: New leads only
    if (policyMode === "new_leads_only" && lastRunAt) {
      const leadCreated = lead.createdAt ? new Date(lead.createdAt) : null;
      if (leadCreated && leadCreated <= lastRunAt) {
        continue;
      }
    }

    // Delivery Rule 2: Cooldown protection
    if (policyMode === "cooldown" && excludedPhoneSet.has(cleanPhone)) {
      continue;
    }

    phoneSeen.add(cleanPhone);

    const renderedParams = renderRecipientParameters(
      campaign.variableMappings || [],
      lead,
      org
    );

    recipientDocs.push({
      campaignId: campaign._id,
      leadId: lead._id,
      recipientPhone: cleanPhone,
      recipientName: lead.name || "Customer",
      renderedParameters: renderedParams,
      runNumber,
      status: "Queued",
    });
  }

  return recipientDocs;
};

/**
 * Executes a single scheduled iteration for a campaign.
 */
export const executeScheduledRun = async (campaignId, tenantDbName, orgId) => {
  const lockKey = `${tenantDbName}_${campaignId}`;
  if (activeExecutionLocks.has(lockKey)) {
    console.log(`[CronScheduler] Campaign ${campaignId} is already executing.`);
    return;
  }

  activeExecutionLocks.add(lockKey);
  console.log(`[CronScheduler] Executing scheduled run for campaign ${campaignId} (Tenant: ${tenantDbName})`);

  try {
    const tenantModels = getTenantModels(tenantDbName);
    const { WhatsAppCampaign, WhatsAppCampaignRecipient } = tenantModels;
    const { Organization } = getMasterModels();

    const [campaign, org] = await Promise.all([
      WhatsAppCampaign.findById(campaignId),
      Organization.findById(orgId),
    ]);

    if (!campaign) {
      console.warn(`[CronScheduler] Campaign ${campaignId} not found.`);
      return;
    }

    if (campaign.status !== "Scheduled" && campaign.status !== "Running") {
      console.log(`[CronScheduler] Campaign ${campaignId} status is '${campaign.status}'. Skipping.`);
      return;
    }

    // 1. Evaluate audience for this run
    const recipientDocs = await evaluateAudienceForRun(campaign, tenantModels, org);
    const runNumber = (campaign.schedule?.currentRunCount || 0) + 1;

    console.log(
      `[CronScheduler] Campaign ${campaign.name} (Run #${runNumber}): Found ${recipientDocs.length} eligible recipients.`
    );

    if (recipientDocs.length > 0) {
      // Bulk insert recipients tagged with runNumber
      await WhatsAppCampaignRecipient.insertMany(recipientDocs, { ordered: false });

      // Update counters
      campaign.totalRecipients = (campaign.totalRecipients || 0) + recipientDocs.length;
      campaign.queuedCount = (campaign.queuedCount || 0) + recipientDocs.length;
    }

    // 2. Advance schedule counters & timestamps
    const now = new Date();
    campaign.schedule.currentRunCount = runNumber;
    campaign.schedule.lastRunAt = now;
    campaign.startedAt = campaign.startedAt || now;

    // 3. Compute next run timestamp
    const nextRun = calculateNextRun(campaign.schedule, now);
    const endCondition = campaign.schedule.endCondition || "indefinite";
    const maxRuns = campaign.schedule.maxRuns || 0;
    const endDate = campaign.schedule.endDate ? new Date(campaign.schedule.endDate) : null;
    const frequency = campaign.schedule.frequency || "once";

    let isFinished = false;
    if (frequency === "once") {
      isFinished = true;
    } else if (endCondition === "max_runs" && maxRuns > 0 && runNumber >= maxRuns) {
      isFinished = true;
    } else if (endCondition === "until_date" && endDate && nextRun > endDate) {
      isFinished = true;
    }

    if (isFinished) {
      campaign.schedule.nextRunAt = null;
      // If no recipients to send, complete immediately. Otherwise complete after worker finishes.
      if (recipientDocs.length === 0) {
        campaign.status = "Completed";
        campaign.completedAt = now;
      }
    } else {
      campaign.schedule.nextRunAt = nextRun;
      campaign.status = "Scheduled";
    }

    await campaign.save();

    // 4. Trigger worker queue if recipients were added
    if (recipientDocs.length > 0) {
      processCampaignQueue(campaign._id, tenantDbName, orgId).catch((err) =>
        console.error(`[CronScheduler] Worker error for campaign ${campaign._id}:`, err)
      );
    }

    // 5. Emit real-time Socket.IO notification
    const io = getIO();
    if (io) {
      io.to(`org_${orgId}`).emit("campaign_automated_trigger", {
        campaignId: campaign._id,
        name: campaign.name,
        runNumber,
        recipientCount: recipientDocs.length,
        nextRunAt: campaign.schedule.nextRunAt,
        status: campaign.status,
      });
    }
  } catch (error) {
    console.error(`[CronScheduler] Error during scheduled iteration for ${campaignId}:`, error);
  } finally {
    activeExecutionLocks.delete(lockKey);
  }
};

/**
 * Initializes the node-cron scheduler service.
 * Runs every minute (* * * * *) to inspect active tenant organizations for due campaigns.
 */
export const initCronScheduler = () => {
  console.log("[CronScheduler] Initializing node-cron automated campaign scheduler (runs every minute)...");

  cron.schedule("* * * * *", async () => {
    try {
      const { Organization } = getMasterModels();
      const activeOrgs = await Organization.find({
        status: "active",
        "whatsappCloudSettings.isConfigured": true,
      }).select("_id tenantDbName");

      const now = new Date();

      for (const org of activeOrgs) {
        if (!org.tenantDbName) continue;

        try {
          const tenantModels = getTenantModels(org.tenantDbName);
          const { WhatsAppCampaign } = tenantModels;

          // Find scheduled campaigns whose nextRunAt has arrived
          const dueCampaigns = await WhatsAppCampaign.find({
            status: "Scheduled",
            "schedule.nextRunAt": { $lte: now },
          });

          for (const campaign of dueCampaigns) {
            executeScheduledRun(campaign._id, org.tenantDbName, org._id.toString()).catch(
              (err) => console.error(`[CronScheduler] Failed running ${campaign._id}:`, err)
            );
          }
        } catch (tenantErr) {
          console.warn(`[CronScheduler] Error scanning tenant ${org.tenantDbName}:`, tenantErr.message);
        }
      }
    } catch (err) {
      console.error("[CronScheduler] Scheduler master tick error:", err);
    }
  });
};
