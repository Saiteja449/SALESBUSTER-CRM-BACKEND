import mongoose from "mongoose";
import {
  normalizePhoneNumber,
  buildLeadAudienceQuery,
} from "./whatsappCloudController.js";
import { processCampaignQueue } from "../services/whatsappCampaignWorker.js";
import { computeNextRunDate } from "../services/whatsappCampaignScheduler.js";
import { getIO } from "../socket/socket.js";

/**
 * Renders dynamic parameter values for a single lead based on template variable mappings.
 */
export const renderRecipientParameters = (mappings = [], lead = {}, org = {}) => {
  if (!Array.isArray(mappings) || mappings.length === 0) return [];

  // Sort mappings by paramIndex ("1", "2", etc.)
  const sorted = [...mappings].sort(
    (a, b) => Number(a.paramIndex) - Number(b.paramIndex)
  );

  return sorted.map((m) => {
    let value = "";
    if (m.sourceType === "static_value") {
      value = m.staticValue || m.fallback || "";
    } else if (m.sourceType === "organization_field") {
      value =
        org[m.fieldKey] ||
        org.aiSettings?.[m.fieldKey] ||
        m.fallback ||
        "";
    } else {
      // lead_field
      value = lead[m.fieldKey] || m.fallback || "";
    }
    return String(value).trim();
  });
};

/**
 * Creates a new bulk WhatsApp campaign and initializes its recipient records.
 */
export const createCampaign = async (req, res) => {
  try {
    if (req.user?.role === "sales person" && !req.user?.isOrgOwner) {
      return res.status(403).json({
        success: false,
        message: "Access forbidden: Manager or Administrator privileges required",
      });
    }
    const {
      name,
      templateId,
      variableMappings,
      audienceCriteria,
      headerMedia,
      messagesPerSecond,
      autoStart,
      scheduleType = "immediate",
      scheduledAt = null,
      scheduledDates = [],
      recurringSchedule = null,
      dynamicAudience = true,
      preventDuplicateLeads = true,
    } = req.body;

    const resolvedTemplateId =
      templateId ||
      req.body.templateId ||
      req.body.template?.id ||
      req.body.template?._id ||
      req.body.template?.metaTemplateId;

    if (!name || !resolvedTemplateId) {
      return res.status(400).json({
        success: false,
        message: "Campaign name and templateId are required.",
      });
    }

    const {
      WhatsAppCampaign,
      WhatsAppCampaignRecipient,
      WhatsAppTemplate,
      WhatsAppOptOut,
      Lead,
    } = req.tenantModels;

    // 1. Validate template (support MongoDB _id, metaTemplateId, or name)
    let template = null;
    if (mongoose.Types.ObjectId.isValid(resolvedTemplateId)) {
      template = await WhatsAppTemplate.findById(resolvedTemplateId);
    }
    if (!template) {
      template = await WhatsAppTemplate.findOne({
        $or: [
          { metaTemplateId: String(resolvedTemplateId) },
          { name: String(resolvedTemplateId) },
        ],
      });
    }

    if (!template) {
      return res.status(404).json({
        success: false,
        message: `Template "${resolvedTemplateId}" not found. Please re-sync or select an approved template.`,
      });
    }

    // 2. Fetch opt-out list
    const optOutRecords = await WhatsAppOptOut.find({}).select("phone");
    const optOutSet = new Set(optOutRecords.map((r) => r.phone));

    // 3. Query matching leads
    const leadQuery = buildLeadAudienceQuery(audienceCriteria);
    const leads = await Lead.find(leadQuery).lean();

    // 4. Filter and prepare recipient records (avoid duplicates, unconsented and opted-out leads)
    const requireConsent = audienceCriteria?.requireConsent !== false;
    const phoneSeen = new Set();
    const recipientDocs = [];
    let skippedCount = 0;

    for (const lead of leads) {
      const cleanPhone = normalizePhoneNumber(lead.phone);
      if (!cleanPhone || cleanPhone.length < 10) {
        skippedCount++;
        continue;
      }

      if (phoneSeen.has(cleanPhone)) {
        continue; // deduplicate
      }

      if (lead.isOptedOut || optOutSet.has(cleanPhone)) {
        skippedCount++;
        continue; // exclude opted out
      }

      if (requireConsent && lead.hasWhatsAppConsent === false) {
        skippedCount++;
        continue; // exclude without consent
      }

      phoneSeen.add(cleanPhone);

      const renderedParams = renderRecipientParameters(
        variableMappings,
        lead,
        req.organization
      );

      recipientDocs.push({
        leadId: lead._id,
        recipientPhone: cleanPhone,
        recipientName: lead.name || "Customer",
        renderedParameters: renderedParams,
        status: "Queued",
      });
    }

    const isScheduled =
      scheduleType === "once" ||
      scheduleType === "recurring" ||
      scheduleType === "specific_dates" ||
      req.body.status === "Scheduled";

    // Immediate dispatch requires at least one recipient right now
    if (!isScheduled && recipientDocs.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No eligible recipients found matching the audience criteria.",
      });
    }

    // 5. Determine Campaign Status & Execution Timestamps
    const shouldStartNow = !isScheduled && (!!autoStart || req.body.status === "Running");
    let campaignStatus = "Draft";
    if (shouldStartNow) {
      campaignStatus = "Running";
    } else if (isScheduled) {
      campaignStatus = "Scheduled";
    }

    const startedAt = shouldStartNow ? new Date() : null;

    // Compute nextRunAt for scheduled / recurring campaigns
    let computedNextRunAt = null;
    let safeScheduledAt = scheduledAt ? new Date(scheduledAt) : null;

    if (isScheduled) {
      if (scheduleType === "once") {
        if (!safeScheduledAt || isNaN(safeScheduledAt.getTime())) {
          return res.status(400).json({
            success: false,
            message: "Valid scheduledAt date & time is required for one-time scheduled campaigns.",
          });
        }
        computedNextRunAt = safeScheduledAt;
      } else if (scheduleType === "recurring") {
        const scheduleCfg = recurringSchedule || {};
        computedNextRunAt = computeNextRunDate(scheduleCfg, new Date());
      } else if (scheduleType === "specific_dates") {
        const scheduleCfg = {
          frequency: "custom_dates",
          dates: scheduledDates,
          time: recurringSchedule?.time || req.body.scheduleTime || "10:00",
        };
        computedNextRunAt = computeNextRunDate(scheduleCfg, new Date());
      }
    }

    const campaign = await WhatsAppCampaign.create({
      name: name.trim(),
      templateId: template._id,
      templateName: template.name,
      templateLanguage: template.language || "en_US",
      variableMappings: variableMappings || [],
      headerMedia: headerMedia || null,
      audienceCriteria: audienceCriteria || {},
      status: campaignStatus,
      scheduleType: isScheduled ? scheduleType : "immediate",
      scheduledAt: safeScheduledAt,
      scheduledDates: Array.isArray(scheduledDates)
        ? scheduledDates.map((d) => new Date(d)).filter((d) => !isNaN(d.getTime()))
        : [],
      recurringSchedule: recurringSchedule
        ? {
            frequency: recurringSchedule.frequency || "daily",
            daysOfWeek: Array.isArray(recurringSchedule.daysOfWeek)
              ? recurringSchedule.daysOfWeek
              : [],
            time: recurringSchedule.time || "10:00",
            startDate: recurringSchedule.startDate ? new Date(recurringSchedule.startDate) : null,
            endDate: recurringSchedule.endDate ? new Date(recurringSchedule.endDate) : null,
            lastRunAt: null,
            nextRunAt: computedNextRunAt,
            completedRunsCount: 0,
          }
        : {
            nextRunAt: computedNextRunAt,
          },
      dynamicAudience: dynamicAudience !== false,
      preventDuplicateLeads: preventDuplicateLeads !== false,
      messagesPerSecond: messagesPerSecond
        ? Math.min(80, Math.max(1, parseInt(messagesPerSecond)))
        : req.organization.whatsappCloudSettings?.messagesPerSecond || 5,
      totalRecipients: isScheduled ? 0 : recipientDocs.length,
      queuedCount: isScheduled ? 0 : recipientDocs.length,
      skippedCount: isScheduled ? 0 : skippedCount,
      startedAt,
      createdBy: req.user?._id || null,
      createdByName: req.user?.name || "Agent",
    });

    // 6. Write recipient batch only if immediate launch or static snapshot
    if (!isScheduled && recipientDocs.length > 0) {
      const recipientInsertBatch = recipientDocs.map((r) => ({
        ...r,
        campaignId: campaign._id,
      }));

      await WhatsAppCampaignRecipient.insertMany(recipientInsertBatch, {
        ordered: false,
      });
    }

    // 7. If autoStart, immediately launch worker
    if (shouldStartNow) {
      const orgId = req.organization._id.toString();
      const tenantDb = req.tenantDbName;
      processCampaignQueue(campaign._id, tenantDb, orgId).catch((err) =>
        console.error(`[CampaignController] Error running queue for auto-started ${campaign._id}:`, err)
      );

      const io = getIO();
      if (io) {
        io.to(`org_${orgId}`).emit("campaign_started", {
          campaignId: campaign._id,
          name: campaign.name,
          totalRecipients: campaign.totalRecipients,
        });
      }
    } else if (isScheduled) {
      const io = getIO();
      if (io) {
        io.to(`org_${req.organization._id}`).emit("campaign_scheduled", {
          campaignId: campaign._id,
          name: campaign.name,
          scheduleType,
          nextRunAt: computedNextRunAt,
        });
      }
    }

    let responseMsg = `Campaign saved as draft.`;
    if (shouldStartNow) {
      responseMsg = `Campaign launched with ${recipientDocs.length} eligible recipients (${skippedCount} skipped/opted-out).`;
    } else if (isScheduled) {
      const runTimeFormatted = computedNextRunAt
        ? new Date(computedNextRunAt).toLocaleString()
        : "scheduled date";
      responseMsg = `Campaign scheduled successfully. Will run on ${runTimeFormatted} checking for matching leads.`;
    }

    res.status(201).json({
      success: true,
      message: responseMsg,
      campaign,
    });
  } catch (error) {
    console.error("[CampaignController] Error creating campaign:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Gets paginated list of campaigns for the organization.
 */
export const getCampaigns = async (req, res) => {
  try {
    if (req.user?.role === "sales person" && !req.user?.isOrgOwner) {
      return res.status(403).json({
        success: false,
        message: "Access forbidden: Manager or Administrator privileges required",
      });
    }
    const { WhatsAppCampaign } = req.tenantModels;
    const { page = 1, limit = 10, status, search } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.max(1, parseInt(limit));
    const skip = (pageNum - 1) * limitNum;

    const filter = {};
    if (status && status !== "All") filter.status = status;
    if (search) filter.name = new RegExp(search.trim(), "i");

    const [campaigns, total] = await Promise.all([
      WhatsAppCampaign.find(filter)
        .populate("templateId", "name category status")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      WhatsAppCampaign.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: campaigns,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Gets detailed campaign information by ID.
 */
export const getCampaignById = async (req, res) => {
  try {
    if (req.user?.role === "sales person" && !req.user?.isOrgOwner) {
      return res.status(403).json({
        success: false,
        message: "Access forbidden: Manager or Administrator privileges required",
      });
    }
    const { id } = req.params;
    const { WhatsAppCampaign } = req.tenantModels;

    const campaign = await WhatsAppCampaign.findById(id).populate(
      "templateId"
    );

    if (!campaign) {
      return res.status(404).json({ success: false, message: "Campaign not found." });
    }

    res.status(200).json({ success: true, data: campaign });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Starts immediate execution of a campaign.
 */
export const startCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const { WhatsAppCampaign } = req.tenantModels;

    const campaign = await WhatsAppCampaign.findById(id);
    if (!campaign) {
      return res.status(404).json({ success: false, message: "Campaign not found." });
    }

    if (campaign.status === "Running") {
      return res.status(400).json({ success: false, message: "Campaign is already running." });
    }

    if (campaign.status === "Completed") {
      return res.status(400).json({ success: false, message: "Campaign is already completed." });
    }

    campaign.status = "Running";
    campaign.startedAt = campaign.startedAt || new Date();
    await campaign.save();

    const orgId = req.organization._id.toString();
    const tenantDb = req.tenantDbName;

    // Trigger worker in background
    processCampaignQueue(campaign._id, tenantDb, orgId).catch((err) =>
      console.error(`[CampaignController] Error running queue for ${campaign._id}:`, err)
    );

    const io = getIO();
    if (io) {
      io.to(`org_${orgId}`).emit("campaign_started", {
        campaignId: campaign._id,
        name: campaign.name,
        totalRecipients: campaign.totalRecipients,
      });
    }

    res.status(200).json({
      success: true,
      message: "Campaign started successfully.",
      data: campaign,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Pauses a running campaign.
 */
export const pauseCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const { WhatsAppCampaign } = req.tenantModels;

    const campaign = await WhatsAppCampaign.findByIdAndUpdate(
      id,
      { status: "Paused" },
      { new: true }
    );

    if (!campaign) {
      return res.status(404).json({ success: false, message: "Campaign not found." });
    }

    const io = getIO();
    if (io) {
      io.to(`org_${req.organization._id}`).emit("campaign_paused", {
        campaignId: campaign._id,
        name: campaign.name,
      });
    }

    res.status(200).json({
      success: true,
      message: "Campaign paused successfully.",
      data: campaign,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Resumes a paused campaign.
 */
export const resumeCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const { WhatsAppCampaign } = req.tenantModels;

    const campaign = await WhatsAppCampaign.findById(id);
    if (!campaign) {
      return res.status(404).json({ success: false, message: "Campaign not found." });
    }

    if (campaign.status !== "Paused") {
      return res.status(400).json({
        success: false,
        message: `Cannot resume campaign with status '${campaign.status}'.`,
      });
    }

    campaign.status = "Running";
    await campaign.save();

    const orgId = req.organization._id.toString();
    const tenantDb = req.tenantDbName;

    processCampaignQueue(campaign._id, tenantDb, orgId).catch((err) =>
      console.error(`[CampaignController] Error resuming queue for ${campaign._id}:`, err)
    );

    const io = getIO();
    if (io) {
      io.to(`org_${orgId}`).emit("campaign_resumed", {
        campaignId: campaign._id,
        name: campaign.name,
      });
    }

    res.status(200).json({
      success: true,
      message: "Campaign resumed successfully.",
      data: campaign,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Cancels a campaign and marks remaining queued recipients as Skipped.
 */
export const cancelCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const { WhatsAppCampaign, WhatsAppCampaignRecipient } = req.tenantModels;

    const campaign = await WhatsAppCampaign.findById(id);
    if (!campaign) {
      return res.status(404).json({ success: false, message: "Campaign not found." });
    }

    campaign.status = "Cancelled";
    if (campaign.recurringSchedule) {
      campaign.recurringSchedule.nextRunAt = null;
    }
    await campaign.save();

    // Mark remaining queued recipients as skipped
    const cancelledCount = await WhatsAppCampaignRecipient.updateMany(
      { campaignId: id, status: "Queued" },
      { status: "Skipped", errorMessage: "Campaign cancelled by user" }
    );

    const io = getIO();
    if (io) {
      io.to(`org_${req.organization._id}`).emit("campaign_cancelled", {
        campaignId: campaign._id,
        name: campaign.name,
      });
    }

    res.status(200).json({
      success: true,
      message: `Campaign cancelled. ${cancelledCount.modifiedCount} queued messages cancelled.`,
      data: campaign,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Re-queues failed recipients for another attempt.
 */
export const retryFailedRecipients = async (req, res) => {
  try {
    const { id } = req.params;
    const { WhatsAppCampaign, WhatsAppCampaignRecipient } = req.tenantModels;

    const campaign = await WhatsAppCampaign.findById(id);
    if (!campaign) {
      return res.status(404).json({ success: false, message: "Campaign not found." });
    }

    // Re-queue failed recipients
    const result = await WhatsAppCampaignRecipient.updateMany(
      { campaignId: id, status: "Failed" },
      {
        status: "Queued",
        retryCount: 0,
        lockedAt: null,
        errorCode: null,
        errorMessage: null,
      }
    );

    if (result.modifiedCount === 0) {
      return res.status(400).json({
        success: false,
        message: "No failed recipients available to retry.",
      });
    }

    // Adjust counters
    campaign.queuedCount += result.modifiedCount;
    campaign.failedCount = Math.max(0, campaign.failedCount - result.modifiedCount);
    campaign.status = "Running";
    await campaign.save();

    const orgId = req.organization._id.toString();
    const tenantDb = req.tenantDbName;

    processCampaignQueue(campaign._id, tenantDb, orgId).catch((err) =>
      console.error(`[CampaignController] Error restarting queue on retry for ${campaign._id}:`, err)
    );

    res.status(200).json({
      success: true,
      message: `Successfully re-queued ${result.modifiedCount} failed recipients.`,
      data: campaign,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Gets paginated recipients for a specific campaign.
 */
export const getCampaignRecipients = async (req, res) => {
  try {
    if (req.user?.role === "sales person" && !req.user?.isOrgOwner) {
      return res.status(403).json({
        success: false,
        message: "Access forbidden: Manager or Administrator privileges required",
      });
    }
    const { id } = req.params;
    const { WhatsAppCampaignRecipient } = req.tenantModels;
    const { page = 1, limit = 20, status, search } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.max(1, parseInt(limit));
    const skip = (pageNum - 1) * limitNum;

    const filter = { campaignId: id };
    if (status && status !== "All") filter.status = status;
    if (search) {
      filter.$or = [
        { recipientPhone: new RegExp(search.trim(), "i") },
        { recipientName: new RegExp(search.trim(), "i") },
      ];
    }

    const [recipients, total] = await Promise.all([
      WhatsAppCampaignRecipient.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limitNum),
      WhatsAppCampaignRecipient.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: recipients,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Gets campaign analytics metrics and conversion funnel.
 */
export const getCampaignAnalytics = async (req, res) => {
  try {
    if (req.user?.role === "sales person" && !req.user?.isOrgOwner) {
      return res.status(403).json({
        success: false,
        message: "Access forbidden: Manager or Administrator privileges required",
      });
    }
    const { id } = req.params;
    const { WhatsAppCampaign, WhatsAppCampaignRecipient } = req.tenantModels;

    const campaign = await WhatsAppCampaign.findById(id);
    if (!campaign) {
      return res.status(404).json({ success: false, message: "Campaign not found." });
    }

    const total = campaign.totalRecipients || 1;
    const sent = campaign.sentCount || 0;
    const delivered = campaign.deliveredCount || 0;
    const read = campaign.readCount || 0;
    const failed = campaign.failedCount || 0;

    const deliveryRate = sent > 0 ? Math.min(100, (delivered / sent) * 100) : 0;
    const readRate = delivered > 0 ? Math.min(100, (read / delivered) * 100) : 0;
    const failureRate = total > 0 ? Math.min(100, (failed / total) * 100) : 0;

    // Aggregate error reasons
    const errorAgg = await WhatsAppCampaignRecipient.aggregate([
      { $match: { campaignId: campaign._id, status: "Failed" } },
      {
        $group: {
          _id: "$errorCode",
          count: { $sum: 1 },
          sampleMessage: { $first: "$errorMessage" },
        },
      },
      { $sort: { count: -1 } },
    ]);

    res.status(200).json({
      success: true,
      data: {
        totalRecipients: campaign.totalRecipients,
        queuedCount: campaign.queuedCount,
        sentCount: sent,
        deliveredCount: delivered,
        readCount: read,
        failedCount: failed,
        skippedCount: campaign.skippedCount,
        deliveryRate: Math.round(deliveryRate * 10) / 10,
        readRate: Math.round(readRate * 10) / 10,
        failureRate: Math.round(failureRate * 10) / 10,
        status: campaign.status,
        startedAt: campaign.startedAt,
        completedAt: campaign.completedAt,
        errorBreakdown: errorAgg.map((e) => ({
          code: e._id || "UNKNOWN",
          count: e.count,
          message: e.sampleMessage,
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Reschedules an existing scheduled or draft campaign.
 */
export const rescheduleCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      scheduleType = "once",
      scheduledAt,
      scheduledDates = [],
      recurringSchedule = null,
      preventDuplicateLeads,
    } = req.body;

    const { WhatsAppCampaign } = req.tenantModels;
    const campaign = await WhatsAppCampaign.findById(id);

    if (!campaign) {
      return res.status(404).json({ success: false, message: "Campaign not found." });
    }

    if (campaign.status === "Running" || campaign.status === "Completed") {
      return res.status(400).json({
        success: false,
        message: `Cannot reschedule campaign with status '${campaign.status}'.`,
      });
    }

    let computedNextRunAt = null;
    let safeScheduledAt = scheduledAt ? new Date(scheduledAt) : null;

    if (scheduleType === "once") {
      if (!safeScheduledAt || isNaN(safeScheduledAt.getTime())) {
        return res.status(400).json({
          success: false,
          message: "Valid scheduledAt date & time is required.",
        });
      }
      computedNextRunAt = safeScheduledAt;
    } else if (scheduleType === "recurring") {
      computedNextRunAt = computeNextRunDate(recurringSchedule || {}, new Date());
    } else if (scheduleType === "specific_dates") {
      const cfg = {
        frequency: "custom_dates",
        dates: scheduledDates,
        time: recurringSchedule?.time || req.body.scheduleTime || "10:00",
      };
      computedNextRunAt = computeNextRunDate(cfg, new Date());
    }

    campaign.scheduleType = scheduleType;
    campaign.status = "Scheduled";
    campaign.scheduledAt = safeScheduledAt;
    if (Array.isArray(scheduledDates)) {
      campaign.scheduledDates = scheduledDates
        .map((d) => new Date(d))
        .filter((d) => !isNaN(d.getTime()));
    }
    if (recurringSchedule) {
      campaign.recurringSchedule = {
        frequency: recurringSchedule.frequency || "daily",
        daysOfWeek: Array.isArray(recurringSchedule.daysOfWeek)
          ? recurringSchedule.daysOfWeek
          : [],
        time: recurringSchedule.time || "10:00",
        startDate: recurringSchedule.startDate ? new Date(recurringSchedule.startDate) : null,
        endDate: recurringSchedule.endDate ? new Date(recurringSchedule.endDate) : null,
        lastRunAt: campaign.recurringSchedule?.lastRunAt || null,
        nextRunAt: computedNextRunAt,
        completedRunsCount: campaign.recurringSchedule?.completedRunsCount || 0,
      };
    } else {
      campaign.recurringSchedule = {
        ...(campaign.recurringSchedule?.toJSON ? campaign.recurringSchedule.toJSON() : campaign.recurringSchedule),
        nextRunAt: computedNextRunAt,
      };
    }

    if (typeof preventDuplicateLeads === "boolean") {
      campaign.preventDuplicateLeads = preventDuplicateLeads;
    }

    await campaign.save();

    const io = getIO();
    if (io) {
      io.to(`org_${req.organization._id}`).emit("campaign_rescheduled", {
        campaignId: campaign._id,
        name: campaign.name,
        scheduleType,
        nextRunAt: computedNextRunAt,
      });
    }

    res.status(200).json({
      success: true,
      message: `Campaign schedule updated. Next run: ${computedNextRunAt ? new Date(computedNextRunAt).toLocaleString() : "configured date"}.`,
      data: campaign,
    });
  } catch (error) {
    console.error("[CampaignController] Error rescheduling campaign:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
