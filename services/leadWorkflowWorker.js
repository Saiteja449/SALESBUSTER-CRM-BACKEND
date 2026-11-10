import { getMasterModels, getTenantModels } from "./tenantManager.js";
import { getIO } from "../socket/socket.js";

let schedulerInterval = null;

/**
 * Runs the dynamic SLA breach check for an organization
 */
export const checkOrganizationSlaBreaches = async (org) => {
  if (!org.tenantDbName) return;
  const tenantModels = getTenantModels(org.tenantDbName);
  const { Lead, Notification } = tenantModels;
  if (!Lead) return;

  const workflow = org.workflowSettings || {};
  if (workflow.enableAutoAttendanceEscalation === false) return;

  const slaHours = workflow.leadAttendanceSlaHours || 24;
  const cutoff = new Date(Date.now() - slaHours * 60 * 60 * 1000);

  const staleLeads = await Lead.find({
    folder: { $in: ["New Leads", "New"] },
    $or: [
      { "sla.firstActionAt": null },
      { "sla.firstActionAt": { $exists: false } },
    ],
    "sla.enteredNewAt": { $lte: cutoff },
    "sla.slaBreached": { $ne: true },
  });

  if (!staleLeads || staleLeads.length === 0) return;

  const io = getIO();

  for (const lead of staleLeads) {
    lead.folder = "Not Attended";
    lead.status = "Not Attended";
    if (!lead.sla) {
      lead.sla = { enteredNewAt: lead.createdAt || new Date() };
    }
    lead.sla.slaBreached = true;
    lead.sla.breachedAt = new Date();
    await lead.save();

    if (Notification) {
      try {
        await Notification.create({
          title: "Lead Attendance SLA Breached",
          message: `Lead "${lead.name || lead.phone}" was untouched for >${slaHours} hours and has been moved to "Not Attended".`,
          type: "sla_breach",
          targetRoles: ["sales manager"],
          metadata: { leadId: lead._id, phone: lead.phone },
        });
      } catch (notifErr) {
        console.warn("[WorkflowWorker] Notification creation error:", notifErr.message);
      }
    }

    if (io) {
      io.to(`org_${org._id}`).emit("lead_updated", lead.toJSON ? lead.toJSON() : lead);
      io.to(`org_${org._id}`).emit("sla_breach_alert", {
        leadId: lead._id,
        phone: lead.phone,
        name: lead.name,
        slaHours,
      });
    }
  }
};

/**
 * Runs the scheduled follow-up checks & reminders for upcoming followups
 */
export const checkScheduledFollowupReminders = async (org) => {
  if (!org.tenantDbName) return;
  const tenantModels = getTenantModels(org.tenantDbName);
  const { Lead, Notification } = tenantModels;
  if (!Lead) return;

  const workflow = org.workflowSettings || {};
  const reminderMinutes = workflow.callerReminderMinutesBefore !== undefined ? workflow.callerReminderMinutesBefore : 30;
  const overdueMinutes = workflow.callerOverdueThresholdMinutes || 120;

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  // Find leads scheduled for today with follow-up time
  const scheduledLeads = await Lead.find({
    status: { $regex: new RegExp("^follow up$", "i") },
    nextFollowUp: todayStr,
    followupTime: { $exists: true, $ne: "" },
  });

  const io = getIO();

  for (const lead of scheduledLeads) {
    if (!lead.followupTime) continue;
    const [hours, minutes] = lead.followupTime.split(":").map(Number);
    if (isNaN(hours) || isNaN(minutes)) continue;

    const scheduledDate = new Date(now);
    scheduledDate.setHours(hours, minutes, 0, 0);

    const diffMinutes = (scheduledDate.getTime() - now.getTime()) / (1000 * 60);

    // If within the reminder window and not yet reminded today
    if (diffMinutes <= reminderMinutes && diffMinutes >= 0 && !lead.callerReminded) {
      lead.callerReminded = true;
      await lead.save();

      if (Notification && lead.assignedTo && lead.assignedTo !== "Unassigned") {
        try {
          await Notification.create({
            title: "Upcoming Scheduled Follow-up",
            message: `Follow-up with "${lead.name || lead.phone}" is scheduled in ${Math.round(diffMinutes)} minutes (${lead.followupTime}).`,
            type: "followup_reminder",
            userId: lead.assignedTo,
            metadata: { leadId: lead._id, phone: lead.phone, scheduledTime: lead.followupTime },
          });
        } catch (err) {
          console.warn("[WorkflowWorker] Reminder notification failed:", err.message);
        }
      }

      if (io) {
        io.to(`org_${org._id}`).emit("caller_reminder", {
          leadId: lead._id,
          assignedTo: lead.assignedTo,
          phone: lead.phone,
          scheduledTime: lead.followupTime,
        });
      }
    }
  }
};

/**
 * Runs the "Not Responding" cadence (e.g. 5 attempts in 15 days) and Future Leads drip
 */
export const checkCadenceWorkflows = async (org) => {
  if (!org.tenantDbName) return;
  const tenantModels = getTenantModels(org.tenantDbName);
  const { Lead, Notification } = tenantModels;
  if (!Lead) return;

  const workflow = org.workflowSettings || {};
  const maxFollowups = workflow.notRespondingMaxFollowups || 5;
  const intervals = workflow.notRespondingIntervalDays || [1, 3, 6, 10, 15];
  const fallbackFolder = workflow.notRespondingFallbackFolder || "Future Leads";

  const now = new Date();

  // 1. Process active "Not Responding" cadence leads whose next scheduled attempt is due
  const dueCadenceLeads = await Lead.find({
    "cadence.type": "Active_NotResponding",
    "cadence.nextCadenceScheduledAt": { $lte: now },
  });

  const io = getIO();

  for (const lead of dueCadenceLeads) {
    const currentCount = (lead.cadence?.followupCount || 0) + 1;
    lead.cadence.followupCount = currentCount;
    lead.cadence.lastCadenceSentAt = now;

    if (currentCount >= maxFollowups) {
      // Completed all follow-ups without response -> auto-move to Future Leads
      lead.folder = fallbackFolder;
      lead.status = fallbackFolder;
      lead.cadence.type = "Drip_FutureLeads";
      lead.cadence.nextCadenceScheduledAt = new Date(
        now.getTime() + (workflow.futureLeadsDripIntervalDays || 15) * 24 * 60 * 60 * 1000
      );
      await lead.save();

      if (Notification) {
        try {
          await Notification.create({
            title: "Lead Transferred to Future Leads",
            message: `Lead "${lead.name || lead.phone}" completed ${maxFollowups} unanswered follow-ups and has been moved to ${fallbackFolder}.`,
            type: "cadence_completed",
            targetRoles: ["sales manager"],
            metadata: { leadId: lead._id },
          });
        } catch (e) {
          console.warn("[WorkflowWorker] Notification error:", e.message);
        }
      }
    } else {
      // Schedule next interval
      const nextIntervalIndex = Math.min(currentCount, intervals.length - 1);
      const daysToAdd = intervals[nextIntervalIndex] || 3;
      lead.cadence.nextCadenceScheduledAt = new Date(
        now.getTime() + daysToAdd * 24 * 60 * 60 * 1000
      );
      await lead.save();
    }

    if (io) {
      io.to(`org_${org._id}`).emit("lead_updated", lead.toJSON ? lead.toJSON() : lead);
    }
  }
};

/**
 * Master tick function that runs all checks across all active organizations
 */
export const runLeadWorkflowTick = async () => {
  try {
    const { Organization } = getMasterModels();
    const organizations = await Organization.find({ status: "active" });

    for (const org of organizations) {
      try {
        await checkOrganizationSlaBreaches(org);
        await checkScheduledFollowupReminders(org);
        await checkCadenceWorkflows(org);
      } catch (orgErr) {
        console.error(`[WorkflowWorker] Error processing org ${org.name} (${org._id}):`, orgErr);
      }
    }
  } catch (err) {
    console.error("[WorkflowWorker] Master tick error:", err);
  }
};

/**
 * Initializes and starts the background recurring workflow scheduler
 */
export const startLeadWorkflowScheduler = (intervalMs = 5 * 60 * 1000) => {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
  }

  console.log(`[WorkflowWorker] Starting Lead Workflow Scheduler (tick interval: ${intervalMs / 1000}s)...`);

  // Run initial check on startup after 10s delay to allow DB connections to settle
  setTimeout(() => {
    runLeadWorkflowTick();
  }, 10000);

  schedulerInterval = setInterval(() => {
    runLeadWorkflowTick();
  }, intervalMs);

  return schedulerInterval;
};

