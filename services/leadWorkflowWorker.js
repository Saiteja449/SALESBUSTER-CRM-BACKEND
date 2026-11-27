import { getMasterModels, getTenantModels } from "./tenantManager.js";
import { getIO } from "../socket/socket.js";
import { decryptApiKey } from "../utils/encryption.js";
import { sendTextMessage, sendTemplateMessage } from "./whatsappCloudService.js";
import { generateAIResponse } from "../ai/aiService.js";

let schedulerInterval = null;

/**
 * Resolves WhatsApp Cloud credentials for a lead/organization and sends an
 * automated AI text (if within 24h window) or approved template (if outside 24h window).
 * Persists the outgoing message to Message & Conversation so Auto-Reply AI has full context.
 */
export const sendAutomatedLeadWhatsAppMessage = async ({
  lead,
  org,
  tenantModels,
  stage = "followup",
  customInstruction = "",
}) => {
  try {
    if (!lead || !lead.phone || !org) return { sent: false, reason: "missing_context" };
    if (
      lead.isOptedOut ||
      lead.status === "DND" ||
      lead.folder === "DND" ||
      lead.disableAI ||
      lead.aiEnabled === false
    ) {
      return { sent: false, reason: "opted_out_or_ai_disabled" };
    }

    const { WAAccount, WATemplate, Template, Message, Conversation } = tenantModels || {};
    const { WAAccount: MasterWA } = getMasterModels();

    // Resolve WhatsApp Cloud credentials (rep line -> org line -> org.whatsappCloudSettings)
    let waAccount = null;
    const accountModel = WAAccount || MasterWA;
    if (accountModel && typeof accountModel.findOne === "function") {
      if (lead.assignedTo && lead.assignedTo !== "Unassigned") {
        waAccount = await accountModel
          .findOne({ organizationId: org._id, userId: lead.assignedTo, status: { $ne: "disconnected" } })
          .lean()
          .catch(() => null);
      }
      if (!waAccount) {
        waAccount = await accountModel
          .findOne({ organizationId: org._id, status: { $ne: "disconnected" } })
          .sort({ userId: 1 })
          .lean()
          .catch(() => null);
      }
    }

    const phoneNumberId = waAccount?.phoneNumberId || org.whatsappCloudSettings?.phoneNumberId;
    const encryptedToken = waAccount?.accessTokenEncrypted || org.whatsappCloudSettings?.accessTokenEncrypted;
    const accessToken = encryptedToken ? decryptApiKey(encryptedToken) : "";

    if (!phoneNumberId || !accessToken) {
      return { sent: false, reason: "no_whatsapp_credentials" };
    }

    const now = new Date();
    const toPhone = lead.phoneNormalized || lead.phone;
    const in24hWindow =
      lead.serviceWindowExpiresAt && new Date(lead.serviceWindowExpiresAt).getTime() > now.getTime();

    const defaultPrompts = {
      new_lead: `Send a warm, concise welcome message to ${lead.name || "the prospect"} thanking them for their interest in ${lead.service || "our services"} and asking how we can help.`,
      not_attended: `Send a polite check-in message to ${lead.name || "the prospect"} apologizing for any delay and asking if they are still looking for ${lead.service || "assistance"}.`,
      followup: `Send a friendly scheduled follow-up message to ${lead.name || "the prospect"} regarding ${lead.service || "their enquiry"} and ask if they are ready to connect.`,
      not_responding: `Send a brief, helpful follow-up message (attempt ${(lead.cadence?.followupCount || 0) + 1}) to ${lead.name || "the prospect"} checking if they still need help with ${lead.service || "our services"}.`,
      marketing_drip: `Send a friendly 15-day check-in / promotional update to ${lead.name || "the prospect"} sharing value about ${lead.service || "our services"} and inviting them to reply if interested.`,
    };

    let sentText = "";
    let metaMessageId = null;
    let messageType = "text";

    if (in24hWindow) {
      let aiText = "";
      try {
        const aiRes = await generateAIResponse(
          lead._id,
          customInstruction || defaultPrompts[stage] || defaultPrompts.followup,
          tenantModels,
          org
        );
        aiText = typeof aiRes === "object" && aiRes !== null ? aiRes.reply : aiRes;
      } catch (aiErr) {
        console.warn(`[WorkflowWorker] AI generation fallback (${stage}):`, aiErr.message);
      }

      sentText =
        (aiText && aiText.trim()) ||
        `Hi ${lead.name || "there"}, just checking in regarding ${lead.service || "your enquiry"}! Please reply here if you have any questions.`;

      const sendRes = await sendTextMessage({
        phoneNumberId,
        accessToken,
        toPhone,
        textBody: sentText,
      });
      metaMessageId = sendRes?.metaMessageId || null;
    } else {
      // Outside 24h window: Meta requires an approved template
      const TemplateModel = WATemplate || Template;
      const workflow = org.workflowSettings || {};
      const preferredName =
        stage === "marketing_drip"
          ? workflow.marketingTemplateName
          : stage === "new_lead" || stage === "not_attended"
          ? workflow.autoMsgTemplateName
          : workflow.followupTemplateName;

      let tpl = null;
      if (TemplateModel && typeof TemplateModel.findOne === "function") {
        if (preferredName) {
          tpl = await TemplateModel.findOne({ name: preferredName, status: "APPROVED" }).lean().catch(() => null);
        }
        if (!tpl && stage === "marketing_drip") {
          tpl = await TemplateModel.findOne({ status: "APPROVED", category: "MARKETING" }).lean().catch(() => null);
        }
        if (!tpl) {
          tpl = await TemplateModel.findOne({ status: "APPROVED" }).lean().catch(() => null);
        }
      }

      if (!tpl) {
        console.log(
          `[WorkflowWorker] Skipping ${stage} for lead ${lead._id} (${toPhone}): outside 24h window and no APPROVED template found.`
        );
        return { sent: false, reason: "no_approved_template" };
      }

      const bodyComp = Array.isArray(tpl.components)
        ? tpl.components.find((c) => String(c.type || "").toUpperCase() === "BODY")
        : null;
      const bodyText = bodyComp?.text || `[Template: ${tpl.name}]`;
      const hasVar1 = /\{\{1\}\}/.test(bodyText);
      const components = hasVar1
        ? [{ type: "body", parameters: [{ type: "text", text: lead.name || "there" }] }]
        : [];

      const sendRes = await sendTemplateMessage({
        phoneNumberId,
        accessToken,
        toPhone,
        templateName: tpl.name,
        languageCode: tpl.language || "en_US",
        components,
      });
      metaMessageId = sendRes?.metaMessageId || null;
      messageType = "template";
      sentText = hasVar1 ? bodyText.replace(/\{\{1\}\}/g, lead.name || "there") : bodyText;
    }

    if (Message && typeof Message.create === "function") {
      const msgRecord = await Message.create({
        messageId: metaMessageId || `auto_${stage}_${lead._id}_${Date.now()}`,
        wamid: metaMessageId || null,
        leadId: lead._id,
        sender: "AI Agent",
        senderName: org.aiSettings?.agentPersona || "SalesBuster AI",
        direction: "outgoing",
        messageType,
        text: sentText,
        timestamp: now,
        aiGenerated: true,
        source: "ai_agent",
        status: "sent",
      }).catch(() => null);

      const io = getIO();
      if (io && msgRecord) {
        io.to(lead._id.toString()).emit("new_message", msgRecord);
      }
    }

    if (Conversation && typeof Conversation.findOneAndUpdate === "function") {
      await Conversation.findOneAndUpdate(
        { leadId: lead._id },
        {
          $set: {
            lastMessage: sentText,
            lastMessageTime: now,
            unreadCount: 0,
          },
        },
        { upsert: true }
      ).catch(() => {});

      const io = getIO();
      if (io) {
        io.to(`org_${org._id}`).emit("conversation_updated", {
          leadId: lead._id,
          lastMessage: sentText,
          lastMessageTime: now,
        });
      }
    }

    return { sent: true, messageId: metaMessageId, text: sentText };
  } catch (err) {
    console.warn(`[WorkflowWorker] Automated WhatsApp (${stage}) warning for lead ${lead?._id}:`, err.message);
    return { sent: false, reason: err.message };
  }
};

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

    // Send Not Attended Auto Msg (non-blocking)
    sendAutomatedLeadWhatsAppMessage({
      lead,
      org,
      tenantModels,
      stage: "not_attended",
    }).catch(() => {});

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

      // Trigger AI Followup with Client alongside caller reminder
      sendAutomatedLeadWhatsAppMessage({
        lead,
        org,
        tenantModels,
        stage: "followup",
      }).catch(() => {});

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
  const processedNotRespondingIds = new Set();

  for (const lead of dueCadenceLeads) {
    if (lead._id) processedNotRespondingIds.add(String(lead._id));
    // Send AI follow-up message for this Not Responding cadence attempt
    await sendAutomatedLeadWhatsAppMessage({
      lead,
      org,
      tenantModels,
      stage: "not_responding",
    });

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

  // 2. Process "Future Leads" 15-day recurring marketing drip
  const dripIntervalDays = workflow.futureLeadsDripIntervalDays || 15;
  const dueDripLeads = await Lead.find({
    "cadence.type": "Drip_FutureLeads",
    "cadence.nextCadenceScheduledAt": { $lte: now },
    isOptedOut: { $ne: true },
    status: { $ne: "DND" },
  });

  if (Array.isArray(dueDripLeads)) {
    for (const lead of dueDripLeads) {
      if (lead._id && processedNotRespondingIds.has(String(lead._id))) continue;
      if (lead.cadence?.type !== "Drip_FutureLeads") continue;
      await sendAutomatedLeadWhatsAppMessage({
        lead,
        org,
        tenantModels,
        stage: "marketing_drip",
      });

      if (!lead.cadence) lead.cadence = { type: "Drip_FutureLeads" };
      lead.cadence.followupCount = (lead.cadence.followupCount || 0) + 1;
      lead.cadence.lastCadenceSentAt = now;
      lead.cadence.nextCadenceScheduledAt = new Date(
        now.getTime() + dripIntervalDays * 24 * 60 * 60 * 1000
      );
      await lead.save();

      if (io) {
        io.to(`org_${org._id}`).emit("lead_updated", lead.toJSON ? lead.toJSON() : lead);
      }
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

