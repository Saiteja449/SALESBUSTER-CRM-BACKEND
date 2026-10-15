import mongoose from "mongoose";
import { getMasterModels, getTenantModels } from "./tenantManager.js";
import { buildLeadAudienceQuery } from "../controllers/whatsappCloudController.js";
import { normalizePhoneNumber } from "../controllers/whatsappCloudController.js";
import { renderRecipientParameters } from "../controllers/whatsappCampaignController.js";
import { processCampaignQueue } from "./whatsappCampaignWorker.js";
import { getIO } from "../socket/socket.js";

let schedulerInterval = null;
let isSchedulerRunning = false;

/**
 * Calculates the next occurrence date/time for a schedule configuration.
 *
 * @param {Object} schedule - Schedule configuration object
 * @param {Date} fromDate - Starting reference time (defaults to now)
 * @returns {Date|null} - Next scheduled execution Date or null if expired
 */
export const computeNextRunDate = (schedule = {}, fromDate = new Date()) => {
  const base = new Date(fromDate);
  const timeStr = schedule.time || "10:00";
  const [hours, minutes] = timeStr.split(":").map(Number);
  const safeHours = Number.isInteger(hours) && hours >= 0 && hours <= 23 ? hours : 10;
  const safeMinutes = Number.isInteger(minutes) && minutes >= 0 && minutes <= 59 ? minutes : 0;

  // Normalize end-date boundary to the end of that day (23:59:59.999)
  let endOfEndDay = null;
  if (schedule.endDate) {
    endOfEndDay = new Date(schedule.endDate);
    if (!isNaN(endOfEndDay.getTime())) {
      endOfEndDay.setHours(23, 59, 59, 999);
    }
  }

  // Custom list of specific dates
  if (schedule.frequency === "custom_dates" || Array.isArray(schedule.dates)) {
    const datesList = schedule.dates || [];
    const futureDates = datesList
      .map((d) => {
        const dateObj = new Date(d);
        dateObj.setHours(safeHours, safeMinutes, 0, 0);
        return dateObj;
      })
      .filter((d) => {
        if (isNaN(d.getTime()) || d.getTime() <= base.getTime()) return false;
        if (endOfEndDay && d.getTime() > endOfEndDay.getTime()) return false;
        return true;
      })
      .sort((a, b) => a.getTime() - b.getTime());

    return futureDates.length > 0 ? futureDates[0] : null;
  }

  // Daily frequency
  if (schedule.frequency === "daily") {
    const candidate = new Date(base);
    candidate.setHours(safeHours, safeMinutes, 0, 0);

    // If today's scheduled time has already passed, advance to tomorrow
    if (candidate.getTime() <= base.getTime()) {
      candidate.setDate(candidate.getDate() + 1);
    }

    if (endOfEndDay && candidate.getTime() > endOfEndDay.getTime()) {
      return null;
    }
    return candidate;
  }

  // Weekly frequency
  if (schedule.frequency === "weekly") {
    const targetDays =
      Array.isArray(schedule.daysOfWeek) && schedule.daysOfWeek.length > 0
        ? schedule.daysOfWeek
        : [1]; // Default to Monday

    for (let dayOffset = 0; dayOffset <= 14; dayOffset++) {
      const candidate = new Date(base);
      candidate.setDate(candidate.getDate() + dayOffset);
      candidate.setHours(safeHours, safeMinutes, 0, 0);

      const dayOfWeek = candidate.getDay(); // 0 = Sun, 1 = Mon ...
      if (targetDays.includes(dayOfWeek) && candidate.getTime() > base.getTime()) {
        if (endOfEndDay && candidate.getTime() > endOfEndDay.getTime()) {
          return null;
        }
        return candidate;
      }
    }
    return null;
  }

  return null;
};

/**
 * Executes dynamic audience lookup and queues leads for a scheduled campaign check.
 */
export const runScheduledCampaignCheck = async (campaign, tenantModels, org) => {
  const { WhatsAppCampaign, WhatsAppCampaignRecipient, WhatsAppOptOut, Lead } = tenantModels;
  const orgId = org._id ? org._id.toString() : "";
  const tenantDbName = org.tenantDbName;

  try {
    console.log(`[CampaignScheduler] Executing scheduled run for campaign "${campaign.name}" (${campaign._id})`);

    // 1. Fetch live opt-outs
    const optOutRecords = await WhatsAppOptOut.find({}).select("phone").lean();
    const optOutSet = new Set(optOutRecords.map((r) => r.phone));

    // 2. Fetch already-targeted phone numbers if preventDuplicateLeads is enabled
    const previouslyMessagedSet = new Set();
    if (campaign.preventDuplicateLeads !== false) {
      const existingRecipients = await WhatsAppCampaignRecipient.find({
        campaignId: campaign._id,
      })
        .select("recipientPhone")
        .lean();

      existingRecipients.forEach((r) => {
        if (r.recipientPhone) previouslyMessagedSet.add(r.recipientPhone);
      });
    }

    // 3. Dynamic query matching lead status, service, and other criteria
    const leadQuery = buildLeadAudienceQuery(campaign.audienceCriteria || {});
    const matchingLeads = await Lead.find(leadQuery).lean();

    // 4. Filter and build recipient batch
    const requireConsent = campaign.audienceCriteria?.requireConsent !== false;
    const recipientBatch = [];
    const phoneSeenInRun = new Set();

    for (const lead of matchingLeads) {
      const cleanPhone = normalizePhoneNumber(lead.phone);
      if (!cleanPhone || cleanPhone.length < 10) continue;

      if (phoneSeenInRun.has(cleanPhone)) continue;
      phoneSeenInRun.add(cleanPhone);

      // Exclude opted-out
      if (lead.isOptedOut || optOutSet.has(cleanPhone)) continue;

      // Exclude unconsented
      if (requireConsent && lead.hasWhatsAppConsent === false) continue;

      // Exclude duplicate leads already messaged by this campaign
      if (previouslyMessagedSet.has(cleanPhone)) continue;

      const renderedParams = renderRecipientParameters(
        campaign.variableMappings || [],
        lead,
        org
      );

      recipientBatch.push({
        campaignId: campaign._id,
        leadId: lead._id,
        recipientPhone: cleanPhone,
        recipientName: lead.name || "Customer",
        renderedParameters: renderedParams,
        status: "Queued",
      });
    }

    console.log(
      `[CampaignScheduler] Found ${matchingLeads.length} leads matching status/service criteria; ${recipientBatch.length} new eligible recipients queued for campaign ${campaign._id}`
    );

    // 5. Insert new recipients if any
    if (recipientBatch.length > 0) {
      await WhatsAppCampaignRecipient.insertMany(recipientBatch, { ordered: false });
    }

    // 6. Update campaign state
    const isRecurring =
      campaign.scheduleType === "recurring" || campaign.scheduleType === "specific_dates";

    const updateFields = {
      $inc: {
        totalRecipients: recipientBatch.length,
        queuedCount: recipientBatch.length,
      },
    };

    if (isRecurring) {
      const nextRun = computeNextRunDate(
        {
          ...(campaign.recurringSchedule?.toJSON ? campaign.recurringSchedule.toJSON() : campaign.recurringSchedule),
          dates: campaign.scheduledDates,
        },
        new Date()
      );

      updateFields.$set = {
        "recurringSchedule.lastRunAt": new Date(),
        "recurringSchedule.nextRunAt": nextRun,
        "recurringSchedule.completedRunsCount":
          (campaign.recurringSchedule?.completedRunsCount || 0) + 1,
      };

      if (recipientBatch.length > 0) {
        // Active recipients queued: transition to Running so worker processes them
        updateFields.$set.status = "Running";
        updateFields.$set.startedAt = campaign.startedAt || new Date();
      } else if (!nextRun) {
        // No future runs remaining and 0 new recipients: mark completed
        updateFields.$set.status = "Completed";
        updateFields.$set.completedAt = new Date();
      } else {
        // No new leads found in this check, but future runs exist: keep Scheduled
        updateFields.$set.status = "Scheduled";
      }
    } else {
      // One-time schedule transitions to Running
      updateFields.$set = {
        status: recipientBatch.length > 0 ? "Running" : "Completed",
        startedAt: campaign.startedAt || new Date(),
        completedAt: recipientBatch.length === 0 ? new Date() : null,
      };
    }

    const updatedCampaign = await WhatsAppCampaign.findByIdAndUpdate(
      campaign._id,
      updateFields,
      { new: true }
    );

    // 7. Trigger the campaign worker to process the newly queued recipients
    if (recipientBatch.length > 0) {
      processCampaignQueue(campaign._id, tenantDbName, orgId).catch((err) =>
        console.error(
          `[CampaignScheduler] Error executing queue worker for scheduled campaign ${campaign._id}:`,
          err
        )
      );
    }

    // 8. Emit Socket.IO notification to tenant room
    const io = getIO();
    if (io) {
      io.to(`org_${orgId}`).emit("campaign_scheduled_run", {
        campaignId: campaign._id,
        name: campaign.name,
        newRecipientsCount: recipientBatch.length,
        totalRecipients: updatedCampaign?.totalRecipients || 0,
        nextRunAt: updatedCampaign?.recurringSchedule?.nextRunAt || null,
        status: updatedCampaign?.status || "Scheduled",
      });
    }
  } catch (err) {
    console.error(
      `[CampaignScheduler] Error executing scheduled campaign ${campaign._id}:`,
      err
    );
  }
};

/**
 * Scans all tenant organizations for due scheduled campaigns and triggers them.
 */
export const checkAndRunScheduledCampaigns = async () => {
  if (isSchedulerRunning) return;
  isSchedulerRunning = true;

  try {
    const { Organization } = getMasterModels();
    const organizations = await Organization.find({
      "whatsappCloudSettings.isConfigured": true,
    }).lean();

    const now = new Date();

    for (const org of organizations) {
      if (!org.tenantDbName) continue;
      try {
        const tenantModels = getTenantModels(org.tenantDbName);
        const { WhatsAppCampaign } = tenantModels;

        // Query campaigns that are Scheduled and due to run
        const dueCampaigns = await WhatsAppCampaign.find({
          status: "Scheduled",
          $or: [
            { scheduledAt: { $ne: null, $lte: now } },
            { "recurringSchedule.nextRunAt": { $ne: null, $lte: now } },
          ],
        });

        for (const camp of dueCampaigns) {
          await runScheduledCampaignCheck(camp, tenantModels, org);
        }
      } catch (tenantErr) {
        console.warn(
          `[CampaignScheduler] Error scanning tenant ${org.tenantDbName}:`,
          tenantErr.message
        );
      }
    }
  } catch (err) {
    console.error("[CampaignScheduler] Error in checkAndRunScheduledCampaigns:", err);
  } finally {
    isSchedulerRunning = false;
  }
};

/**
 * Starts the campaign scheduler background polling loop (every 30s).
 */
export const startCampaignScheduler = (intervalMs = 30000) => {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
  }

  console.log(`[CampaignScheduler] Starting campaign scheduler (polling interval: ${intervalMs}ms)`);

  // Run initial check shortly after boot (5s)
  setTimeout(() => {
    checkAndRunScheduledCampaigns().catch((err) =>
      console.error("[CampaignScheduler] Error in initial check:", err)
    );
  }, 5000);

  schedulerInterval = setInterval(() => {
    checkAndRunScheduledCampaigns().catch((err) =>
      console.error("[CampaignScheduler] Error in interval check:", err)
    );
  }, intervalMs);

  return schedulerInterval;
};

/**
 * Stops the campaign scheduler background loop.
 */
export const stopCampaignScheduler = () => {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log("[CampaignScheduler] Campaign scheduler stopped.");
  }
};
