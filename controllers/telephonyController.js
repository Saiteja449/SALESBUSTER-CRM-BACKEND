import { getMasterModels, getTenantModels } from "../services/tenantManager.js";
import {
  downloadAndArchiveRecording,
  triggerCallAiAnalysis,
  provisionTelecmiUser,
} from "../services/telephonyService.js";
import { getIO } from "../socket/socket.js";

/**
 * 1. GET /api/telephony/agent-credentials
 * Returns the logged-in agent's TeleCMI SIP credentials and organization virtual number.
 */
export const getAgentCredentials = async (req, res) => {
  try {
    const user = req.user;
    const org = req.organization;

    if (!org) {
      return res.status(400).json({
        success: false,
        message: "Organization context is missing.",
      });
    }

    const isAddonEnabled = Boolean(org.telephony?.isAddonEnabled);
    const isUserCloudEnabled = Boolean(
      isAddonEnabled &&
      user.telephony?.isCloudEnabled &&
      user.telephony?.telecmiUserId &&
      org.telephony?.isConfigured
    );

    res.status(200).json({
      success: true,
      data: {
        isCloudEnabled: isUserCloudEnabled,
        callingMode: isUserCloudEnabled ? "cloud" : "normal",
        telephonyAddonEnabled: isAddonEnabled,
        appId: org.telephony?.telecmiAppId || "",
        sbcUri: org.telephony?.sbcUri || "sbcind.telecmi.com",
        virtualNumber: org.telephony?.virtualNumber || "",
        telecmiUserId: user.telephony?.telecmiUserId || "",
        telecmiPassword: user.telephony?.telecmiPassword || "",
        telecmiExtension: user.telephony?.telecmiExtension || "",
        isConfigured: Boolean(org.telephony?.isConfigured),
      },
    });
  } catch (error) {
    console.error("Error fetching agent credentials:", error);
    res.status(500).json({
      success: false,
      message: "Server error fetching telephony credentials.",
    });
  }
};

/**
 * 2. POST /api/telephony/webhook/cdr
 * Receives CDR (Call Detail Record) from TeleCMI.
 * Webhook returns 200 OK immediately and processes data asynchronously.
 */
export const handleCDRWebhook = async (req, res) => {
  // 1. Immediately acknowledge TeleCMI with 200 OK to prevent retries/timeouts
  res.status(200).json({ status: "received" });

  try {
    const payload = req.body || {};
    const {
      cmiuid,
      duration = 0,
      billedsec = 0,
      filename,
      record,
      from,
      to,
      agent,
      time,
      extra_param,
      status: rawStatus,
    } = payload;

    if (!cmiuid) {
      console.warn("[TelephonyWebhook] CDR received without cmiuid. Skipping.");
      return;
    }

    console.log(`[TelephonyWebhook] Processing CDR for Call UUID: ${cmiuid}`);

    // 2. Parse extra_param (passed from piopiy.call or click-to-call)
    let leadId = null;
    let salespersonId = null;
    let orgId = req.query.orgId || req.params.orgId || null;
    let tenantDbName = null;

    if (extra_param) {
      try {
        const parsed =
          typeof extra_param === "string" ? JSON.parse(extra_param) : extra_param;
        leadId = parsed.leadId || leadId;
        salespersonId = parsed.salespersonId || salespersonId;
        orgId = parsed.orgId || orgId;
        tenantDbName = parsed.tenantDbName || tenantDbName;
      } catch (e) {
        console.warn("[TelephonyWebhook] Failed to parse extra_param:", extra_param);
      }
    }

    // 3. Resolve Organization from Master DB
    const { Organization } = getMasterModels();
    let organization = null;

    if (orgId) {
      organization = await Organization.findById(orgId);
    } else if (tenantDbName) {
      organization = await Organization.findOne({ tenantDbName });
    }

    if (!organization && to) {
      // Try to find organization by virtual number
      organization = await Organization.findOne({
        $or: [
          { "telephony.virtualNumber": to },
          { "telephony.virtualNumber": from },
        ],
      });
    }

    if (!organization) {
      console.warn(
        `[TelephonyWebhook] Could not resolve Organization for call ${cmiuid}. Aborting.`
      );
      return;
    }

    // Verify Add-on is active
    if (!organization.telephony?.isAddonEnabled) {
      console.warn(
        `[TelephonyWebhook] Organization ${organization.name} does not have Telephony Add-on enabled. Ignoring.`
      );
      return;
    }

    tenantDbName = organization.tenantDbName;
    const tenantModels = getTenantModels(tenantDbName);
    const { CallLog, Lead, TelecallerAnalytics, User } = tenantModels;

    // 4. Fallback Lead Matching by Phone Number if leadId not passed
    let leadDoc = null;
    const cleanPhone = (p) => (p ? String(p).replace(/\D/g, "") : "");
    const targetPhone = cleanPhone(to) || cleanPhone(from);

    if (leadId) {
      leadDoc = await Lead.findById(leadId);
    }

    if (!leadDoc && targetPhone && targetPhone.length >= 6) {
      const searchTail = targetPhone.slice(-10);
      leadDoc = await Lead.findOne({
        phone: { $regex: new RegExp(searchTail + "$") },
      });
      if (leadDoc) {
        leadId = leadDoc._id;
      }
    }

    // 5. Fallback Salesperson resolution
    let salespersonName = "";
    if (salespersonId) {
      const userDoc = await User.findById(salespersonId);
      if (userDoc) salespersonName = userDoc.name || "";
    } else if (agent) {
      const userDoc = await User.findOne({
        "telephony.telecmiUserId": String(agent).trim(),
      });
      if (userDoc) {
        salespersonId = userDoc._id;
        salespersonName = userDoc.name || "";
      }
    }

    // 6. Download and Archive Recording (if recorded)
    let archived = null;
    if (filename && filename !== "null" && filename !== "undefined") {
      archived = await downloadAndArchiveRecording(
        organization.telephony?.telecmiAppId,
        organization.telephony?.telecmiSecret,
        filename,
        organization._id.toString(),
        cmiuid
      );
    }

    const durationSec = parseInt(duration) || 0;
    const billedSec = parseInt(billedsec) || 0;
    const isConnected = billedSec > 0;
    const callStatus = isConnected
      ? "connected"
      : rawStatus?.toLowerCase() === "busy"
      ? "busy"
      : rawStatus?.toLowerCase() === "rejected"
      ? "rejected"
      : "not-connected";

    // 7. Save or Upsert CallLog in Tenant DB
    const callTimestamp = time ? new Date(parseInt(time)) : new Date();

    const callLogData = {
      organizationId: organization._id,
      salespersonId: salespersonId || null,
      salespersonName: salespersonName || "Sales Representative",
      leadId: leadId || null,
      leadPhone: to || from || "",
      leadName: leadDoc ? leadDoc.name : "Direct Call",
      cmiuid,
      callSource: "cloud_telecmi",
      callType: "outgoing",
      status: callStatus,
      duration: durationSec,
      talkTime: billedSec,
      recordingFilename: filename || "",
      recordingUrl: archived?.publicUrl || "",
      recordingSize: archived?.fileSize || 0,
      timestamp: callTimestamp,
    };

    const callLogDoc = await CallLog.findOneAndUpdate(
      { cmiuid },
      { $set: callLogData },
      { upsert: true, new: true }
    );

    // 8. Update Daily TelecallerAnalytics in Tenant DB
    if (salespersonId) {
      const dateStr = callTimestamp.toISOString().slice(0, 10);
      await TelecallerAnalytics.findOneAndUpdate(
        { salespersonId, date: dateStr },
        {
          $setOnInsert: {
            salesperson: salespersonName,
            salespersonId,
            date: dateStr,
          },
          $inc: {
            totalCalls: 1,
            outgoing: 1,
            talkTime: billedSec,
            connected: isConnected ? 1 : 0,
            notConnected: isConnected ? 0 : 1,
          },
          $max: { longestCall: billedSec },
        },
        { upsert: true }
      );
    }

    // 9. Update Lead record (Activity, Counters & Recordings array)
    if (leadDoc) {
      const updateLeadDoc = {
        lastContactedAt: callTimestamp,
        lastActivity: callTimestamp,
        $inc: { followUpCount: 1 },
      };

      if (archived?.publicUrl) {
        updateLeadDoc.$push = {
          recordings: {
            name: `TeleCMI Cloud Call (${isConnected ? "Connected" : "No Answer"}) - ${callTimestamp.toLocaleTimeString()}`,
            url: archived.publicUrl,
            duration: billedSec || durationSec,
            uploadedAt: callTimestamp,
            analysisStatus: "pending",
          },
        };
      }

      await Lead.findByIdAndUpdate(leadDoc._id, updateLeadDoc);

      // Trigger Gemini AI Audio Analysis if recording exists
      if (archived?.localPath) {
        triggerCallAiAnalysis({
          localPath: archived.localPath,
          publicUrl: archived.publicUrl,
          leadId: leadDoc._id,
          callLogId: callLogDoc._id,
          organization,
          tenantModels,
        });
      }
    }

    // 10. Broadcast Real-Time Socket Event to Organization
    const io = getIO();
    if (io) {
      io.to(organization._id.toString()).emit("call_completed", {
        callLog: callLogDoc,
        leadId,
        salespersonId,
        status: callStatus,
        duration: durationSec,
        talkTime: billedSec,
        recordingUrl: archived?.publicUrl || "",
      });
    }

    console.log(
      `[TelephonyWebhook] Successfully processed CDR for ${cmiuid} (Status: ${callStatus}, TalkTime: ${billedSec}s)`
    );
  } catch (error) {
    console.error("[TelephonyWebhook] Error processing CDR webhook:", error);
  }
};

/**
 * 3. GET /api/telephony/call-logs
 * Returns paginated call logs for the active organization with filters.
 */
export const getCallLogs = async (req, res) => {
  try {
    const { CallLog } = req.tenantModels;
    const {
      page = 1,
      limit = 20,
      leadId,
      salespersonId,
      status,
      callSource,
      startDate,
      endDate,
      search,
    } = req.query;

    const query = {};

    if (leadId) query.leadId = leadId;
    if (salespersonId) query.salespersonId = salespersonId;
    if (status) query.status = status;
    if (callSource && callSource !== "all") query.callSource = callSource;

    if (startDate || endDate) {
      query.timestamp = {};
      if (startDate) query.timestamp.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.timestamp.$lte = end;
      }
    }

    if (search) {
      query.$or = [
        { leadPhone: { $regex: search, $options: "i" } },
        { leadName: { $regex: search, $options: "i" } },
        { salespersonName: { $regex: search, $options: "i" } },
        { disposition: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await CallLog.countDocuments(query);
    const callLogs = await CallLog.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    res.status(200).json({
      success: true,
      data: callLogs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Error retrieving call logs:", error);
    res.status(500).json({
      success: false,
      message: "Server error retrieving call logs.",
    });
  }
};

/**
 * 4. GET /api/telephony/analytics
 * Returns aggregated telephony KPIs, volume trends, outcome distributions, and rep leaderboards.
 */
export const getTelephonyAnalytics = async (req, res) => {
  try {
    const { CallLog, TelecallerAnalytics, User } = req.tenantModels;
    const { startDate, endDate, salespersonId, callSource } = req.query;

    const dateQuery = {};
    if (startDate || endDate) {
      dateQuery.timestamp = {};
      if (startDate) dateQuery.timestamp.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        dateQuery.timestamp.$lte = end;
      }
    }

    if (salespersonId) {
      dateQuery.salespersonId = salespersonId;
    }

    if (callSource && callSource !== "all") {
      dateQuery.callSource = callSource;
    }

    // 1. Overall KPIs
    const callLogs = await CallLog.find(dateQuery).lean();
    const totalCalls = callLogs.length;
    let connectedCalls = 0;
    let totalTalkTime = 0;
    let totalDuration = 0;
    let cloudCalls = 0;
    let manualCalls = 0;

    const dispositionCounts = {};
    const hourlyCounts = Array(24).fill(0);
    const repStatsMap = {};

    callLogs.forEach((log) => {
      totalDuration += log.duration || 0;
      totalTalkTime += log.talkTime || 0;
      if (log.status === "connected") connectedCalls++;

      if (log.callSource === "manual") {
        manualCalls++;
      } else {
        cloudCalls++;
      }

      // Dispositions
      const disp = log.disposition || (log.status === "connected" ? "Answered (No disposition)" : "Not Answered");
      dispositionCounts[disp] = (dispositionCounts[disp] || 0) + 1;

      // Hourly Distribution
      if (log.timestamp) {
        const hour = new Date(log.timestamp).getHours();
        hourlyCounts[hour] = (hourlyCounts[hour] || 0) + 1;
      }

      // Leaderboard by salesperson
      const repKey = log.salespersonId ? String(log.salespersonId) : "Unassigned";
      if (!repStatsMap[repKey]) {
        repStatsMap[repKey] = {
          salespersonId: log.salespersonId,
          salespersonName: log.salespersonName || "Unassigned",
          totalCalls: 0,
          connectedCalls: 0,
          talkTime: 0,
        };
      }
      repStatsMap[repKey].totalCalls++;
      if (log.status === "connected") repStatsMap[repKey].connectedCalls++;
      repStatsMap[repKey].talkTime += log.talkTime || 0;
    });

    const connectionRate = totalCalls > 0 ? Math.round((connectedCalls / totalCalls) * 100) : 0;
    const averageHandleTime = connectedCalls > 0 ? Math.round(totalTalkTime / connectedCalls) : 0;

    // Leaderboard Array
    const leaderboard = Object.values(repStatsMap)
      .map((rep) => ({
        ...rep,
        connectionRate: rep.totalCalls > 0 ? Math.round((rep.connectedCalls / rep.totalCalls) * 100) : 0,
        aht: rep.connectedCalls > 0 ? Math.round(rep.talkTime / rep.connectedCalls) : 0,
      }))
      .sort((a, b) => b.talkTime - a.talkTime);

    // Format hourly volume for charts
    const hourlyTrend = hourlyCounts.map((count, hour) => ({
      hour: `${hour.toString().padStart(2, "0")}:00`,
      calls: count,
    }));

    // Format dispositions for donut chart
    const dispositionChart = Object.keys(dispositionCounts).map((key) => ({
      name: key,
      value: dispositionCounts[key],
    }));

    res.status(200).json({
      success: true,
      data: {
        kpis: {
          totalCalls,
          cloudCalls,
          manualCalls,
          connectedCalls,
          missedCalls: totalCalls - connectedCalls,
          connectionRate,
          totalTalkTime, // in seconds
          totalDuration, // in seconds
          averageHandleTime, // in seconds
        },
        hourlyTrend,
        dispositionChart,
        leaderboard,
      },
    });
  } catch (error) {
    console.error("Error generating telephony analytics:", error);
    res.status(500).json({
      success: false,
      message: "Server error generating telephony analytics.",
    });
  }
};

/**
 * 5. POST /api/telephony/call-disposition
 * Updates disposition, notes, and tags on CallLog and Lead.
 */
export const updateCallDisposition = async (req, res) => {
  try {
    const { callLogId, leadId, disposition, notes, nextFollowUp, followupTime } = req.body;
    const { CallLog, Lead } = req.tenantModels;

    if (!callLogId && !leadId) {
      return res.status(400).json({
        success: false,
        message: "Either callLogId or leadId must be provided.",
      });
    }

    if (callLogId) {
      await CallLog.findByIdAndUpdate(callLogId, {
        disposition: disposition || "",
        notes: notes || "",
      });
    }

    if (leadId) {
      const updateData = {};
      if (notes) updateData.notes = notes;
      if (nextFollowUp) updateData.nextFollowUp = nextFollowUp;
      if (followupTime) updateData.followupTime = followupTime;
      if (disposition) {
        updateData.$addToSet = { tags: disposition };
      }
      await Lead.findByIdAndUpdate(leadId, updateData);
    }

    res.status(200).json({
      success: true,
      message: "Call disposition and lead updated successfully.",
    });
  } catch (error) {
    console.error("Error updating call disposition:", error);
    res.status(500).json({
      success: false,
      message: "Server error updating call disposition.",
    });
  }
};

/**
 * 5.5. POST /api/telephony/manual-call-log
 * Records a call made by a salesperson using their normal phone dialer.
 * Automatically creates a CallLog with callSource='manual', increments
 * TelecallerAnalytics, updates Lead status & tags, and broadcasts via socket.
 */
export const recordManualCallLog = async (req, res) => {
  try {
    const user = req.user;
    const org = req.organization;
    const { CallLog, Lead, TelecallerAnalytics } = req.tenantModels;

    const {
      leadId,
      leadPhone,
      leadName,
      status = "connected", // "connected", "not-connected", "missed", "rejected", "busy"
      duration = 0, // duration in seconds
      disposition,
      notes,
      timestamp,
      nextFollowUp,
      followupTime,
    } = req.body;

    if (!leadPhone && !leadId) {
      return res.status(400).json({
        success: false,
        message: "leadId or leadPhone is required.",
      });
    }

    let leadDoc = null;
    if (leadId) {
      leadDoc = await Lead.findById(leadId);
    }
    if (!leadDoc && leadPhone) {
      const cleanPhone = String(leadPhone).replace(/\D/g, "");
      const searchTail = cleanPhone.slice(-10);
      leadDoc = await Lead.findOne({
        phone: { $regex: new RegExp(searchTail + "$") },
      });
    }

    const durationSec = parseInt(duration) || 0;
    const isConnected = status === "connected" && durationSec > 0;
    const callTimestamp = timestamp ? new Date(timestamp) : new Date();
    const manualUid = `manual_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    // 1. Create CallLog entry
    const callLogDoc = await CallLog.create({
      organizationId: org?._id || user.organizationId,
      salespersonId: user._id,
      salespersonName: user.name || "Sales Representative",
      leadId: leadDoc ? leadDoc._id : leadId || null,
      leadPhone: leadPhone || (leadDoc ? leadDoc.phone : ""),
      leadName: leadName || (leadDoc ? leadDoc.name : "Direct Call"),
      cmiuid: manualUid,
      callSource: "manual",
      callType: "outgoing",
      status: status || "connected",
      duration: durationSec,
      talkTime: durationSec,
      disposition: disposition || "",
      notes: notes || "",
      recordingFilename: "",
      recordingUrl: "",
      recordingSize: 0,
      timestamp: callTimestamp,
    });

    // 2. Update Daily TelecallerAnalytics
    const dateStr = callTimestamp.toISOString().slice(0, 10);
    await TelecallerAnalytics.findOneAndUpdate(
      { salespersonId: user._id, date: dateStr },
      {
        $setOnInsert: {
          salesperson: user.name,
          salespersonId: user._id,
          date: dateStr,
        },
        $inc: {
          totalCalls: 1,
          outgoing: 1,
          talkTime: durationSec,
          connected: isConnected ? 1 : 0,
          notConnected: isConnected ? 0 : 1,
        },
        $max: { longestCall: durationSec },
      },
      { upsert: true }
    );

    // 3. Update Lead
    if (leadDoc) {
      const leadUpdate = {
        lastContactedAt: callTimestamp,
        lastActivity: callTimestamp,
        $inc: { followUpCount: 1 },
      };
      if (notes) leadUpdate.notes = notes;
      if (nextFollowUp) leadUpdate.nextFollowUp = nextFollowUp;
      if (followupTime) leadUpdate.followupTime = followupTime;
      if (disposition) {
        leadUpdate.$addToSet = { tags: disposition };
      }
      await Lead.findByIdAndUpdate(leadDoc._id, leadUpdate);
    }

    // 4. Socket Broadcast
    const io = getIO();
    const orgTargetId = (org?._id || user.organizationId)?.toString();
    if (io && orgTargetId) {
      io.to(orgTargetId).emit("call_completed", {
        callLog: callLogDoc,
        leadId: leadDoc?._id || leadId,
        salespersonId: user._id,
        status,
        duration: durationSec,
        talkTime: durationSec,
        callSource: "manual",
      });
    }

    res.status(201).json({
      success: true,
      message: "Normal phone call logged successfully.",
      data: callLogDoc,
    });
  } catch (error) {
    console.error("Error logging manual call:", error);
    res.status(500).json({
      success: false,
      message: "Server error while recording manual call log.",
    });
  }
};

/**
 * 6. PUT /api/telephony/settings/organization
 * Allows Org Admin to configure TeleCMI keys, Virtual Number, and SBC settings.
 */
export const updateOrganizationTelephonySettings = async (req, res) => {
  try {
    const { Organization } = getMasterModels();
    const orgId = req.organization?._id;

    if (!orgId) {
      return res.status(400).json({
        success: false,
        message: "Organization not found.",
      });
    }

    const {
      telecmiAppId,
      telecmiSecret,
      sbcUri,
      virtualNumber,
      webhookSecret,
      recordingStorageType,
    } = req.body;

    const isConfigured = Boolean(telecmiAppId && telecmiSecret);

    const updatedOrg = await Organization.findByIdAndUpdate(
      orgId,
      {
        $set: {
          "telephony.telecmiAppId": telecmiAppId || "",
          "telephony.telecmiSecret": telecmiSecret || "",
          "telephony.sbcUri": sbcUri || "sbcind.telecmi.com",
          "telephony.virtualNumber": virtualNumber || "",
          "telephony.webhookSecret": webhookSecret || "",
          "telephony.recordingStorageType": recordingStorageType || "local",
          "telephony.isConfigured": isConfigured,
        },
      },
      { new: true }
    );

    res.status(200).json({
      success: true,
      message: "Organization telephony configuration updated.",
      data: updatedOrg.telephony,
    });
  } catch (error) {
    console.error("Error updating telephony organization settings:", error);
    res.status(500).json({
      success: false,
      message: "Server error updating organization telephony configuration.",
    });
  }
};

/**
 * 7. PUT /api/telephony/settings/agent/:userId
 * Allows Org Admin to assign a TeleCMI SIP User ID, Password, and toggle Cloud vs Normal calling mode.
 */
export const updateUserTelephonySettings = async (req, res) => {
  try {
    const { userId } = req.params;
    const { telecmiUserId, telecmiPassword, telecmiExtension, isActive, isCloudEnabled } = req.body;
    const { User } = req.tenantModels;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found in tenant organization.",
      });
    }

    user.telephony = {
      telecmiUserId: telecmiUserId !== undefined ? telecmiUserId : user.telephony?.telecmiUserId || "",
      telecmiPassword: telecmiPassword !== undefined ? telecmiPassword : user.telephony?.telecmiPassword || "",
      telecmiExtension: telecmiExtension !== undefined ? telecmiExtension : user.telephony?.telecmiExtension || "",
      isActive: isActive !== undefined ? isActive : (user.telephony?.isActive ?? true),
      isCloudEnabled: isCloudEnabled !== undefined ? Boolean(isCloudEnabled) : (user.telephony?.isCloudEnabled ?? false),
    };

    await user.save();

    res.status(200).json({
      success: true,
      message: "Agent telephony extension updated successfully.",
      data: {
        userId: user._id,
        name: user.name,
        telephony: user.telephony,
      },
    });
  } catch (error) {
    console.error("Error updating user telephony settings:", error);
    res.status(500).json({
      success: false,
      message: "Server error updating user telephony settings.",
    });
  }
};

/**
 * 8. POST /api/telephony/settings/agent/:userId/auto-provision
 * Automatically provisions an existing agent in TeleCMI via v3 API and saves credentials.
 */
export const autoProvisionAgentExtension = async (req, res) => {
  try {
    const { userId } = req.params;
    const { User } = req.tenantModels;
    const org = req.organization;

    if (!org.telephony?.isAddonEnabled || !org.telephony?.isConfigured) {
      return res.status(400).json({
        success: false,
        message:
          "TeleCMI credentials (App ID & Secret) are not configured for this organization.",
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found in tenant organization.",
      });
    }

    let ext = req.body?.extension;
    if (!ext) {
      const existingUsers = await User.find({
        "telephony.telecmiExtension": { $exists: true, $ne: "" },
      }).select("telephony.telecmiExtension");
      const exts = existingUsers
        .map((u) => parseInt(u.telephony?.telecmiExtension, 10))
        .filter((n) => !isNaN(n));
      ext = exts.length > 0 ? Math.max(...exts) + 1 : 101;
    }

    const password =
      req.body?.password ||
      user.telephony?.telecmiPassword ||
      `SipPass@${Math.floor(1000 + Math.random() * 9000)}`;

    const telecmiResult = await provisionTelecmiUser({
      name: user.name,
      phone: user.phone || user.mobile,
      password: password,
      extension: ext,
      organization: org,
    });

    if (!telecmiResult) {
      return res.status(502).json({
        success: false,
        message:
          "Failed to auto-provision agent in TeleCMI. Please verify your App ID & Secret.",
      });
    }

    user.telephony = {
      telecmiUserId: telecmiResult.telecmiUserId,
      telecmiPassword: telecmiResult.telecmiPassword,
      telecmiExtension: telecmiResult.telecmiExtension,
      isActive: true,
      isCloudEnabled: true,
    };
    await user.save();

    res.status(200).json({
      success: true,
      message: `Agent ${user.name} successfully auto-provisioned in TeleCMI with extension ${ext}.`,
      data: {
        userId: user._id,
        name: user.name,
        telephony: user.telephony,
      },
    });
  } catch (error) {
    console.error("Error auto-provisioning agent extension:", error);
    res.status(500).json({
      success: false,
      message: "Server error auto-provisioning agent extension.",
    });
  }
};
