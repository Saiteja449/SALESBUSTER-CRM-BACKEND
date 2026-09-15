import mongoose from "mongoose";
import {
  normalizePhoneNumber,
  buildLeadAudienceQuery,
} from "./whatsappCloudController.js";
import { processCampaignQueue } from "../services/whatsappCampaignWorker.js";
import {
  buildCronExpression,
  calculateNextRun,
  executeScheduledRun,
} from "../services/whatsappCronScheduler.js";
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
    const {
      name,
      templateId,
      variableMappings,
      audienceCriteria,
      headerMedia,
      messagesPerSecond,
      autoStart,
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

    if (recipientDocs.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No eligible recipients found matching the audience criteria.",
      });
    }

    // 5. Handle Automated Campaign Setup
    const isAutomated =
      req.body.campaignType === "automated" ||
      (req.body.schedule && req.body.schedule.frequency);

    if (isAutomated) {
      const scheduleInput = req.body.schedule || {};
      const cronExpression = buildCronExpression(scheduleInput);
      const nextRunAt = calculateNextRun(scheduleInput, new Date());

      const campaign = await WhatsAppCampaign.create({
        name: name.trim(),
        campaignType: "automated",
        templateId: template._id,
        templateName: template.name,
        templateLanguage: template.language || "en_US",
        variableMappings: variableMappings || [],
        headerMedia: headerMedia || null,
        audienceCriteria: audienceCriteria || {},
        schedule: {
          startDate: scheduleInput.startDate ? new Date(scheduleInput.startDate) : new Date(),
          timeOfDay: scheduleInput.timeOfDay || "10:00",
          frequency: scheduleInput.frequency || "once",
          daysOfWeek: Array.isArray(scheduleInput.daysOfWeek) ? scheduleInput.daysOfWeek : [1],
          cronExpression,
          dayOfMonth: scheduleInput.dayOfMonth || 1,
          intervalDays: scheduleInput.intervalDays || 1,
          endCondition: scheduleInput.endCondition || "indefinite",
          endDate: scheduleInput.endDate ? new Date(scheduleInput.endDate) : null,
          maxRuns: Number(scheduleInput.maxRuns) || 0,
          currentRunCount: 0,
          nextRunAt,
          lastRunAt: null,
        },
        audiencePolicy: req.body.audiencePolicy || {
          mode: "cooldown",
          cooldownDays: 7,
        },
        status: "Scheduled",
        messagesPerSecond: messagesPerSecond
          ? Math.min(80, Math.max(1, parseInt(messagesPerSecond)))
          : req.organization.whatsappCloudSettings?.messagesPerSecond || 5,
        totalRecipients: recipientDocs.length,
        queuedCount: 0,
        skippedCount,
        startedAt: null,
        createdBy: req.user?._id || null,
        createdByName: req.user?.name || "Agent",
      });

      // If autoStart is requested and nextRunAt is now or past, immediately run first iteration
      if (autoStart && nextRunAt <= new Date()) {
        const orgId = req.organization._id.toString();
        const tenantDb = req.tenantDbName;
        executeScheduledRun(campaign._id, tenantDb, orgId).catch((err) =>
          console.error(`[CampaignController] Auto-start run error for ${campaign._id}:`, err)
        );
      }

      const io = getIO();
      if (io) {
        io.to(`org_${req.organization._id}`).emit("campaign_scheduled", {
          campaignId: campaign._id,
          name: campaign.name,
          nextRunAt,
          frequency: scheduleInput.frequency || "once",
        });
      }

      return res.status(201).json({
        success: true,
        message: `Automated campaign scheduled successfully. Next execution: ${nextRunAt ? nextRunAt.toLocaleString() : "Pending"}`,
        campaign,
      });
    }

    // 6. Create One-Time Campaign Record (Immediate dispatch or draft)
    const shouldStartNow = !!autoStart || req.body.status === "Running";
    const campaignStatus = shouldStartNow ? "Running" : "Draft";
    const startedAt = shouldStartNow ? new Date() : null;

    const campaign = await WhatsAppCampaign.create({
      name: name.trim(),
      campaignType: "one_time",
      templateId: template._id,
      templateName: template.name,
      templateLanguage: template.language || "en_US",
      variableMappings: variableMappings || [],
      headerMedia: headerMedia || null,
      audienceCriteria: audienceCriteria || {},
      status: campaignStatus,
      messagesPerSecond: messagesPerSecond
        ? Math.min(80, Math.max(1, parseInt(messagesPerSecond)))
        : req.organization.whatsappCloudSettings?.messagesPerSecond || 5,
      totalRecipients: recipientDocs.length,
      queuedCount: recipientDocs.length,
      skippedCount,
      startedAt,
      createdBy: req.user?._id || null,
      createdByName: req.user?.name || "Agent",
    });

    // Bulk write recipients attached to campaign._id
    const recipientInsertBatch = recipientDocs.map((r) => ({
      ...r,
      campaignId: campaign._id,
      runNumber: 1,
    }));

    await WhatsAppCampaignRecipient.insertMany(recipientInsertBatch, {
      ordered: false,
    });

    // If autoStart, immediately launch worker
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
    }

    res.status(201).json({
      success: true,
      message: shouldStartNow
        ? `Campaign launched with ${recipientDocs.length} eligible recipients (${skippedCount} skipped/opted-out).`
        : `Campaign saved as draft with ${recipientDocs.length} eligible recipients (${skippedCount} skipped/opted-out).`,
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
 * Manually triggers an immediate run of a scheduled campaign without disrupting its recurring schedule.
 */
export const triggerScheduledRun = async (req, res) => {
  try {
    const { id } = req.params;
    const { WhatsAppCampaign } = req.tenantModels;
    const campaign = await WhatsAppCampaign.findById(id);
    if (!campaign) {
      return res.status(404).json({ success: false, message: "Campaign not found." });
    }

    const tenantDb = req.tenantDbName;
    const orgId = req.organization._id.toString();

    // Trigger execution in background
    executeScheduledRun(campaign._id, tenantDb, orgId).catch((err) =>
      console.error(`[CampaignController] Manual trigger error for ${id}:`, err)
    );

    res.status(200).json({
      success: true,
      message: `Manual run triggered for '${campaign.name}'.`,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Toggles the automated schedule between Scheduled and Paused.
 */
export const togglePauseSchedule = async (req, res) => {
  try {
    const { id } = req.params;
    const { WhatsAppCampaign } = req.tenantModels;
    const campaign = await WhatsAppCampaign.findById(id);
    if (!campaign) {
      return res.status(404).json({ success: false, message: "Campaign not found." });
    }

    if (campaign.status === "Scheduled") {
      campaign.status = "Paused";
      await campaign.save();

      const io = getIO();
      if (io) {
        io.to(`org_${req.organization._id}`).emit("campaign_paused", {
          campaignId: campaign._id,
          name: campaign.name,
        });
      }

      return res.status(200).json({
        success: true,
        message: "Automated schedule paused.",
        data: campaign,
      });
    } else if (campaign.status === "Paused") {
      // Resume schedule and recalculate upcoming nextRunAt
      const nextRun = calculateNextRun(campaign.schedule || {}, new Date());
      campaign.status = "Scheduled";
      if (!campaign.schedule) campaign.schedule = {};
      campaign.schedule.nextRunAt = nextRun;
      await campaign.save();

      const io = getIO();
      if (io) {
        io.to(`org_${req.organization._id}`).emit("campaign_resumed", {
          campaignId: campaign._id,
          name: campaign.name,
          nextRunAt: nextRun,
        });
      }

      return res.status(200).json({
        success: true,
        message: `Automated schedule resumed. Next run: ${nextRun.toLocaleString()}`,
        data: campaign,
      });
    } else {
      return res.status(400).json({
        success: false,
        message: `Cannot toggle schedule for campaign with status '${campaign.status}'.`,
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

