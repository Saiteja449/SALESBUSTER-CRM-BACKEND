import mongoose from "mongoose";
import Lead from "../models/Lead.js";
import User from "../models/User.js";
import AssignmentState from "../models/AssignmentState.js";
import Followup from "../models/Followup.js";
import Notification from "../models/Notification.js";
import Conversation from "../models/Conversation.js";
import Message from "../models/Message.js";
import AILog from "../models/AILog.js";
import SystemSettings from "../models/SystemSettings.js";
import WhatsAppSession from "../models/WhatsAppSession.js";
import { getMasterModels } from "../services/tenantManager.js";
import { getIO } from "../socket/socket.js";
import fs from "fs";
import path from "path";
import { processAudioUpload } from "../utils/audioConverter.js";
import { analyzeAudioFile } from "../services/audioAnalysisService.js";
import { sendWelcomeEnquiryMessage, sendMessageFromCRM, getWhatsAppStatus } from "../whatsapp/whatsappService.js";
import { decryptApiKey } from "../utils/encryption.js";
import { recordAiUsage } from "../services/aiUsageService.js";
import * as XLSX from "xlsx";

// Feature toggle for AI Call Analysis & Transcription
const ENABLE_AI_AUDIO_ANALYSIS =
  process.env.ENABLE_AI_AUDIO_ANALYSIS !== "false"; // Defaults to true unless explicitly disabled

// Model resolver for multi-tenancy
const getModels = (req) => ({
  LeadModel: req?.tenantModels?.Lead || Lead,
  UserModel: req?.tenantModels?.User || User,
  AssignmentStateModel: req?.tenantModels?.AssignmentState || AssignmentState,
  FollowupModel: req?.tenantModels?.Followup || Followup,
  NotificationModel: req?.tenantModels?.Notification || Notification,
  ConversationModel: req?.tenantModels?.Conversation || Conversation,
  MessageModel: req?.tenantModels?.Message || Message,
  AILogModel: req?.tenantModels?.AILog || AILog,
  SystemSettingsModel: req?.tenantModels?.SystemSettings || SystemSettings,
  WhatsAppSessionModel: req?.tenantModels?.WhatsAppSession || WhatsAppSession,
});

// Helper to verify lead assignment for sales representatives
const isLeadAssignedToUser = (lead, user) => {
  if (!lead || !user) return false;
  const assigned = String(lead.assignedTo || "").trim();
  const userId = String(user._id || user.id || "").trim();
  const userName = user.name ? user.name.trim().toLowerCase() : "";
  if (assigned === userId) return true;
  if (userName && assigned.toLowerCase() === userName) return true;
  return false;
};

// Helper for background audio transcription & analysis
const triggerAudioAnalysis = async (
  leadId,
  recordingId,
  filePath,
  mimeType,
  LeadModel = Lead,
  orgApiKey = null,
  orgId = null,
) => {
  if (!ENABLE_AI_AUDIO_ANALYSIS) {
    console.log(
      `[AudioAnalysis] AI Audio Analysis is disabled. Skipping analysis for recording ${recordingId}`,
    );
    return;
  }
  try {
    console.log(
      `[AudioAnalysis] Starting background transcription and analysis for lead ${leadId}, recording ${recordingId}`,
    );
    const result = await analyzeAudioFile(filePath, mimeType, orgApiKey);

    let transcription = "";
    let analysis = "";

    if (result && typeof result === "object") {
      transcription = result.transcription || "";
      analysis = result.analysis || result.fullText || "";
    } else if (typeof result === "string") {
      analysis = result;
      const match = result.match(
        /## Call Transcription\s*([\s\S]*?)(?=\n## Short Summary|\n## |$)/i,
      );
      transcription = match ? match[1].trim() : "";
    }

    const updateSet = {
      "recordings.$.analysis": analysis,
      "recordings.$.transcription": transcription,
      "recordings.$.analysisStatus": "completed",
    };

    await LeadModel.updateOne(
      { _id: leadId, "recordings._id": recordingId },
      { $set: updateSet },
    );

    console.log(
      `[AudioAnalysis] Successfully completed transcription & analysis for recording ${recordingId}`,
    );

    // Broadcast real-time update via Socket.IO
    const io = getIO();
    if (io) {
      const payload = {
        leadId: leadId.toString(),
        recordingId: recordingId.toString(),
        transcription,
        analysis,
        analysisStatus: "completed",
      };
      if (orgId) {
        io.to(`org_${orgId}`).emit("recording_analyzed", payload);
      }
      io.emit("recording_analyzed", payload);
    }

    if (orgId) {
      recordAiUsage(orgId, "audio", 1).catch((err) =>
        console.warn("[AudioAnalysis] Failed recording audio usage:", err.message),
      );
    }
  } catch (error) {
    console.error(
      `[AudioAnalysis] Failed to analyze recording ${recordingId}:`,
      error,
    );
    await LeadModel.updateOne(
      { _id: leadId, "recordings._id": recordingId },
      {
        $set: {
          "recordings.$.analysisStatus": "failed",
          "recordings.$.analysisError": error.message,
        },
      },
    );

    const io = getIO();
    if (io) {
      const payload = {
        leadId: leadId.toString(),
        recordingId: recordingId.toString(),
        analysisStatus: "failed",
        analysisError: error.message,
      };
      if (orgId) {
        io.to(`org_${orgId}`).emit("recording_analyzed", payload);
      }
      io.emit("recording_analyzed", payload);
    }
  }
};

export const getLeads = async (req, res) => {
  try {
    const { LeadModel } = getModels(req);
    let query = {};
    if (req.user?.role === "sales person") {
      const repId = req.user._id || req.user.id;
      const repName = req.user.name;
      const matchArray = [String(repId)];
      if (mongoose.Types.ObjectId.isValid(repId)) {
        matchArray.push(new mongoose.Types.ObjectId(repId));
      }
      if (repName) {
        matchArray.push(new RegExp("^" + repName + "$", "i"));
      }
      query.assignedTo = { $in: matchArray };
    }
    const leads = await LeadModel.find(query);
    res.json({ success: true, data: leads });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getPaginatedLeads = async (req, res) => {
  try {
    const {
      page = 0,
      limit = 10,
      search = "",
      service = "All",
      salesperson = "All",
      salespersonId = "",
      status = "All",
      leadTypeTab = "New",
      clientDate = "",
    } = req.query;

    const { LeadModel, UserModel } = getModels(req);

    const pageNum = parseInt(page) || 0;
    const isAll = limit === "All" || limit === "all";
    const limitNum = isAll ? 0 : parseInt(limit) || 10;

    let query = {};

    // Determine effective sales rep filter condition (supports ID with fallback to legacy name)
    const activeSalesRepFilter = salespersonId || (salesperson !== "All" ? salesperson : null);
    let assigneeMatchConditions = null;

    // Strict role check: Sales Representatives ONLY see their own assigned leads.
    // Client-supplied role or user ID overrides are strictly ignored.
    const isSalesRepUser = req.user?.role === "sales person";
    const effectiveUserId = req.user?._id || req.userTokenData?.id;
    const effectiveUserName = req.user?.name;

    if (isSalesRepUser && (effectiveUserId || effectiveUserName)) {
      const matchArray = [];
      if (effectiveUserId) {
        matchArray.push(String(effectiveUserId));
        if (mongoose.Types.ObjectId.isValid(effectiveUserId)) {
          matchArray.push(new mongoose.Types.ObjectId(effectiveUserId));
        }
      }
      if (effectiveUserName) {
        matchArray.push(new RegExp("^" + effectiveUserName + "$", "i"));
      }
      assigneeMatchConditions = matchArray.length === 1 ? matchArray[0] : { $in: matchArray };
    } else if (activeSalesRepFilter && activeSalesRepFilter !== "All") {
      const matchArray = [String(activeSalesRepFilter)];
      if (mongoose.Types.ObjectId.isValid(activeSalesRepFilter)) {
        matchArray.push(new mongoose.Types.ObjectId(activeSalesRepFilter));
        try {
          const matchedUser = await UserModel.findById(activeSalesRepFilter).select("name");
          if (matchedUser?.name) {
            matchArray.push(new RegExp("^" + matchedUser.name + "$", "i"));
          }
        } catch (uErr) {}
      } else {
        matchArray.push(new RegExp("^" + activeSalesRepFilter + "$", "i"));
      }
      assigneeMatchConditions = matchArray.length === 1 ? matchArray[0] : { $in: matchArray };
    }

    if (assigneeMatchConditions) {
      query.assignedTo = assigneeMatchConditions;
    }

    if (search) {
      const searchRegex = new RegExp(search, "i");
      const searchConditions = [
        { name: searchRegex },
        { company: searchRegex },
        { phone: searchRegex },
        { email: searchRegex },
        { service: searchRegex },
        { city: searchRegex },
        { "aiQualification.city": searchRegex },
        { "aiQualification.intent": searchRegex },
      ];

      const qualFields = req.organization?.aiSettings?.qualificationFields;
      if (Array.isArray(qualFields) && qualFields.length > 0) {
        for (const f of qualFields) {
          if (f.key && !["city", "intent"].includes(f.key)) {
            searchConditions.push({ [`aiQualification.${f.key}`]: searchRegex });
          }
        }
      } else {
        searchConditions.push(
          { "aiQualification.liftType": searchRegex },
          { "aiQualification.propertyType": searchRegex },
          { "aiQualification.issueDescription": searchRegex },
        );
      }

      query.$or = searchConditions;
    }

    if (service !== "All") query.service = service;
    if (status !== "All") query.status = status;

    // Determine today's date in YYYY-MM-DD: prioritize valid clientDate, otherwise organization timezone or Asia/Kolkata
    let todayStr = clientDate && /^\d{4}-\d{2}-\d{2}$/.test(clientDate) ? clientDate : "";
    if (!todayStr) {
      const orgTimezone = req.organization?.timezone || "Asia/Kolkata";
      try {
        todayStr = new Date().toLocaleDateString("en-CA", { timeZone: orgTimezone });
      } catch (err) {
        todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      }
    }

    const applyTabFilter = (q, tab) => {
      if (tab === "OldLeads") {
        q.isOldLead = true;
        q.status = { $regex: new RegExp("^new$", "i") };
      } else {
        if (tab === "New") {
          q.isOldLead = { $ne: true };
          q.status = { $regex: new RegExp("^new$", "i") };
        } else if (tab === "TodayFollowup") {
          q.status = { $regex: new RegExp("^follow up$", "i") };
          q.$or = [
            ...(q.$or || []),
            { nextFollowUp: null },
            { nextFollowUp: "" },
            { nextFollowUp: { $lte: todayStr } },
          ];
        } else if (tab === "UpcomingFollowup") {
          q.status = { $regex: new RegExp("^follow up$", "i") };
          q.nextFollowUp = { $gt: todayStr };
        } else if (tab === "Converted") {
          q.status = { $regex: new RegExp("^converted$", "i") };
        } else if (tab === "Lost") {
          q.status = {
            $in: [
              new RegExp("^price issue$", "i"),
              new RegExp("^not interested$", "i"),
            ],
          };
        } else if (tab === "NotAttended") {
          q.status = { $regex: new RegExp("^not attended$", "i") };
        } else if (tab === "MissedCalls") {
          q.status = { $regex: new RegExp("^missed call$", "i") };
        }
      }
    };

    applyTabFilter(query, leadTypeTab);

    const totalCount = await LeadModel.countDocuments(query);
    let leadsQuery = LeadModel.find(query).sort({ createdAt: -1 });
    if (!isAll) {
      leadsQuery = leadsQuery.skip(pageNum * limitNum).limit(limitNum);
    }
    const leads = await leadsQuery;

    const baseCountQuery = {};
    if (assigneeMatchConditions) {
      baseCountQuery.assignedTo = assigneeMatchConditions;
    }
    if (search) {
      const searchRegex = new RegExp(search, "i");
      const searchConditions = [
        { name: searchRegex },
        { company: searchRegex },
        { phone: searchRegex },
        { email: searchRegex },
        { service: searchRegex },
        { city: searchRegex },
        { "aiQualification.city": searchRegex },
        { "aiQualification.intent": searchRegex },
      ];

      const qualFields = req.organization?.aiSettings?.qualificationFields;
      if (Array.isArray(qualFields) && qualFields.length > 0) {
        for (const f of qualFields) {
          if (f.key && !["city", "intent"].includes(f.key)) {
            searchConditions.push({ [`aiQualification.${f.key}`]: searchRegex });
          }
        }
      } else {
        searchConditions.push(
          { "aiQualification.liftType": searchRegex },
          { "aiQualification.propertyType": searchRegex },
          { "aiQualification.issueDescription": searchRegex },
        );
      }

      baseCountQuery.$or = searchConditions;
    }
    if (service !== "All") baseCountQuery.service = service;
    if (status !== "All") baseCountQuery.status = status;

    const facetCounts = await LeadModel.aggregate([
      { $match: baseCountQuery },
      {
        $facet: {
          OldLeads: [
            {
              $match: {
                isOldLead: true,
                status: { $regex: new RegExp("^new$", "i") },
              },
            },
            { $count: "count" },
          ],
          New: [
            {
              $match: {
                isOldLead: { $ne: true },
                status: { $regex: new RegExp("^new$", "i") },
              },
            },
            { $count: "count" },
          ],
          TodayFollowup: [
            {
              $match: {
                status: { $regex: new RegExp("^follow up$", "i") },
                $or: [
                  { nextFollowUp: null },
                  { nextFollowUp: "" },
                  { nextFollowUp: { $lte: todayStr } },
                ],
              },
            },
            { $count: "count" },
          ],
          UpcomingFollowup: [
            {
              $match: {
                status: { $regex: new RegExp("^follow up$", "i") },
                nextFollowUp: { $gt: todayStr },
              },
            },
            { $count: "count" },
          ],
          Converted: [
            {
              $match: {
                status: { $regex: new RegExp("^converted$", "i") },
              },
            },
            { $count: "count" },
          ],
          NotAttended: [
            {
              $match: {
                status: { $regex: new RegExp("^not attended$", "i") },
              },
            },
            { $count: "count" },
          ],
          Lost: [
            {
              $match: {
                status: {
                  $in: [
                    new RegExp("^price issue$", "i"),
                    new RegExp("^not interested$", "i"),
                  ],
                },
              },
            },
            { $count: "count" },
          ],
          MissedCalls: [
            {
              $match: {
                status: { $regex: new RegExp("^missed call$", "i") },
              },
            },
            { $count: "count" },
          ],
        },
      },
    ]);

    const counts = {
      OldLeads: facetCounts[0]?.OldLeads?.[0]?.count || 0,
      New: facetCounts[0]?.New?.[0]?.count || 0,
      TodayFollowup: facetCounts[0]?.TodayFollowup?.[0]?.count || 0,
      UpcomingFollowup: facetCounts[0]?.UpcomingFollowup?.[0]?.count || 0,
      Converted: facetCounts[0]?.Converted?.[0]?.count || 0,
      NotAttended: facetCounts[0]?.NotAttended?.[0]?.count || 0,
      Lost: facetCounts[0]?.Lost?.[0]?.count || 0,
      MissedCalls: facetCounts[0]?.MissedCalls?.[0]?.count || 0,
    };

    res.json({
      success: true,
      leads,
      totalCount,
      totalPages: isAll ? 1 : Math.ceil(totalCount / (limitNum || 10)),
      currentPage: pageNum,
      tabCounts: counts,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const createLead = async (req, res) => {
  console.log("\n==================== [createLead] START ====================");
  console.log(`[createLead] [Step 1] Request received at ${new Date().toISOString()}`);
  console.log("[createLead] [Step 1] Authenticated User:", {
    id: req.user?._id || req.user?.id,
    name: req.user?.name,
    email: req.user?.email,
    role: req.user?.role,
    organizationId: req.user?.organizationId || req.organization?._id,
  });
  console.log("[createLead] [Step 1] Request Body:", JSON.stringify(req.body, null, 2));

  if (req.file) {
    console.log("[createLead] [Step 1] Audio recording attached:", {
      originalname: req.file.originalname,
      filename: req.file.filename,
      mimetype: req.file.mimetype,
      size: `${(req.file.size / 1024).toFixed(2)} KB`,
      path: req.file.path,
    });
  } else {
    console.log("[createLead] [Step 1] No audio recording attached in request.");
  }

  try {
    const {
      LeadModel,
      UserModel,
      AssignmentStateModel,
      NotificationModel,
    } = getModels(req);
    console.log("[createLead] [Step 2] Models resolved for tenant:", {
      LeadModel: LeadModel.modelName,
      UserModel: UserModel.modelName,
      AssignmentStateModel: AssignmentStateModel.modelName,
      NotificationModel: NotificationModel.modelName,
    });

    // Subscription expiry check
    console.log("[createLead] [Step 3] Checking organization subscription status...");
    if (req.organization?.subscriptionEndDate) {
      const isExpired =
        new Date() > new Date(req.organization.subscriptionEndDate);
      console.log(`[createLead] [Step 3] Subscription end date: ${req.organization.subscriptionEndDate} (Expired: ${isExpired})`);
      if (isExpired) {
        console.warn(`[createLead] [Step 3] REJECTED: Organization subscription expired on ${req.organization.subscriptionEndDate}`);
        console.log("==================== [createLead] EXPIRED ====================\n");
        return res.status(403).json({
          success: false,
          subscriptionExpired: true,
          message: `Your organization's subscription expired on ${new Date(
            req.organization.subscriptionEndDate
          ).toLocaleDateString("en-IN")}. Please renew to create new leads.`,
        });
      }
    } else {
      console.log("[createLead] [Step 3] No subscription end date limit configured. Proceeding.");
    }

    const leadData = req.body || {};

    // Duplicate check
    console.log("[createLead] [Step 4] Checking for duplicate leads by phone or email...");
    if (leadData.phone || leadData.email) {
      const rawPhone = leadData.phone ? String(leadData.phone).trim() : "";
      const cleanDigits = rawPhone.replace(/\D/g, "");
      const last10Digits =
        cleanDigits.length >= 10 ? cleanDigits.slice(-10) : cleanDigits;
      let normalizedPhone = cleanDigits;
      if (normalizedPhone.length > 10 && normalizedPhone.startsWith("91")) {
        normalizedPhone = normalizedPhone.substring(2);
      }

      console.log("[createLead] [Step 4] Contact details parsed for duplicate search:", {
        rawPhone,
        cleanDigits,
        last10Digits,
        normalizedPhone,
        email: leadData.email,
      });

      const orConditions = [];
      if (rawPhone) orConditions.push({ phone: rawPhone });
      if (cleanDigits) orConditions.push({ phone: cleanDigits });
      if (normalizedPhone) orConditions.push({ phone: normalizedPhone });
      if (last10Digits.length >= 7) {
        orConditions.push({ phone: new RegExp(last10Digits + "$") });
      }
      if (
        leadData.email &&
        typeof leadData.email === "string" &&
        leadData.email.trim()
      ) {
        orConditions.push({
          email: new RegExp("^" + leadData.email.trim() + "$", "i"),
        });
      }

      if (orConditions.length > 0) {
        console.log("[createLead] [Step 4] Querying database with conditions:", JSON.stringify(orConditions));
        const existingLead = await LeadModel.findOne({ $or: orConditions });
        if (existingLead) {
          console.warn("[createLead] [Step 4] REJECTED: Duplicate lead found:", {
            existingId: existingLead._id,
            name: existingLead.name,
            phone: existingLead.phone,
            email: existingLead.email,
          });
          console.log("==================== [createLead] DUPLICATE ====================\n");
          return res.status(400).json({
            success: false,
            message: "A lead with this phone number or email already exists.",
          });
        }
        console.log("[createLead] [Step 4] Duplicate check passed. No existing lead matched.");
      }
    } else {
      console.log("[createLead] [Step 4] Neither phone nor email provided, skipping duplicate check.");
    }

    // Lead assignment logic
    console.log(`[createLead] [Step 5] Resolving lead assignment. User role: "${req.user?.role}", Requested assignedTo: "${leadData.assignedTo}"`);
    if (req.user?.role === "sales person") {
      leadData.assignedTo = (req.user._id || req.user.id).toString();
      console.log(`[createLead] [Step 5] Creator is sales person. Auto-assigned to self (${leadData.assignedTo})`);
    } else if (!leadData.assignedTo || leadData.assignedTo === "Unassigned") {
      console.log("[createLead] [Step 5] Lead assignedTo is empty or 'Unassigned'. Checking round-robin distribution...");
      const reps = await UserModel.find({ role: "sales person" }).sort({
        _id: 1,
      });
      console.log(`[createLead] [Step 5] Found ${reps ? reps.length : 0} eligible sales representatives.`);
      if (reps && reps.length > 0) {
        let state = await AssignmentStateModel.findOne({
          key: "leadAssignment",
        });
        if (!state) {
          console.log("[createLead] [Step 5] Initializing AssignmentState for 'leadAssignment'.");
          state = await AssignmentStateModel.create({
            key: "leadAssignment",
            lastAssignedIndex: -1,
          });
        }

        let nextIndex = state.lastAssignedIndex + 1;
        if (nextIndex >= reps.length) {
          nextIndex = 0;
        }

        leadData.assignedTo = reps[nextIndex]._id.toString();
        state.lastAssignedIndex = nextIndex;
        await state.save();
        console.log(`[createLead] [Step 5] Round-robin assigned to: ${reps[nextIndex].name} (ID: ${leadData.assignedTo}, index: ${nextIndex})`);
      } else {
        console.log("[createLead] [Step 5] No sales representatives available. Leaving lead Unassigned.");
      }
    } else {
      console.log(`[createLead] [Step 5] Preserving explicitly provided assignedTo: "${leadData.assignedTo}"`);
    }

    if (!leadData.joinedAt) {
      leadData.joinedAt = new Date();
      console.log(`[createLead] [Step 6] Assigned default joinedAt timestamp: ${leadData.joinedAt.toISOString()}`);
    } else {
      console.log(`[createLead] [Step 6] Retaining provided joinedAt: ${leadData.joinedAt}`);
    }

    // Audio upload handling
    if (req.file) {
      console.log(`[createLead] [Step 7] Processing uploaded audio: ${req.file.originalname}`);
      await processAudioUpload(req.file);
      const host = req.get("host") || "";
      const basePath = "/uploads/";
      const protocol =
        req.headers["x-forwarded-proto"] ||
        (host && !host.includes("localhost") ? "https" : req.protocol);
      const fileUrl = `${protocol}://${host}${basePath}${req.file.filename}`;
      console.log(`[createLead] [Step 7] Audio processing complete. File URL: ${fileUrl}`);
      leadData.recordings = [
        {
          name: req.body.recordingName || req.file.originalname,
          url: fileUrl,
          analysisStatus: ENABLE_AI_AUDIO_ANALYSIS ? "pending" : "paused",
          uploadedAt: new Date(),
        },
      ];
      console.log("[createLead] [Step 7] Recording record created:", leadData.recordings[0]);
    }

    // Save lead document
    console.log("[createLead] [Step 8] Saving new lead to database...");
    const lead = await LeadModel.create(leadData);
    console.log(`[createLead] [Step 8] Lead saved successfully. ID: ${lead._id}, Name: "${lead.name}", Status: "${lead.status}"`);

    // AI Audio analysis trigger
    if (req.file && ENABLE_AI_AUDIO_ANALYSIS && lead.recordings?.length > 0) {
      const newRecording = lead.recordings[0];
      const orgApiKey = decryptApiKey(req.organization?.aiSettings?.geminiApiKey);
      const orgId = req.organization?._id || req.user?.organizationId;
      console.log(`[createLead] [Step 9] Triggering background AI audio analysis for recording ${newRecording._id}...`);
      triggerAudioAnalysis(
        lead._id,
        newRecording._id,
        req.file.path,
        req.file.mimetype,
        LeadModel,
        orgApiKey,
        orgId,
      ).catch((err) =>
        console.error("[AudioAnalysis] Background analysis error (createLead):", err),
      );
    } else {
      console.log(`[createLead] [Step 9] Skipping audio analysis (file present: ${!!req.file}, AI enabled: ${ENABLE_AI_AUDIO_ANALYSIS})`);
    }

    // Send automated WhatsApp welcome enquiry message for non-manual and non-call sources (Web Form, Email, Meta Ads, etc.)
    const normalizedLeadSource = (lead.source || "").trim().toLowerCase();
    console.log(`[createLead] [Step 10] Evaluating automated WhatsApp welcome message for source: "${lead.source}"`);
    if (
      lead.source &&
      normalizedLeadSource !== "manual entry" &&
      !normalizedLeadSource.includes("call")
    ) {
      const orgId = req.user?.organizationId || req.organization?._id || null;
      console.log(`[createLead] [Step 10] Triggering sendWelcomeEnquiryMessage for lead ${lead._id} (source: ${lead.source}, orgId: ${orgId})`);
      sendWelcomeEnquiryMessage(lead, {
        tenantModels: req.tenantModels,
        organizationId: orgId,
      }).catch((err) =>
        console.error("Error in sendWelcomeEnquiryMessage (createLead):", err),
      );
    } else {
      console.log(`[createLead] [Step 10] Skipped WhatsApp welcome message (source is "${lead.source || 'Manual Entry'}")`);
    }

    // Notification handling
    console.log("[createLead] [Step 11] Resolving assigned rep details for notification...");
    let assignedUserName = "sales representative";
    let targetUsers = [];
    if (lead.assignedTo && lead.assignedTo !== "Unassigned") {
      if (mongoose.Types.ObjectId.isValid(lead.assignedTo)) {
        targetUsers = [lead.assignedTo];
        const assignedUser = await UserModel.findById(lead.assignedTo).select("name");
        if (assignedUser) {
          assignedUserName = assignedUser.name;
          console.log(`[createLead] [Step 11] Matched user by ObjectId: ${assignedUserName} (${lead.assignedTo})`);
        }
      } else {
        const assignedUser = await UserModel.findOne({ name: lead.assignedTo });
        if (assignedUser) {
          targetUsers = [assignedUser._id];
          assignedUserName = assignedUser.name;
          console.log(`[createLead] [Step 11] Matched user by name: ${assignedUserName} (${assignedUser._id})`);
        } else {
          assignedUserName = lead.assignedTo;
          console.log(`[createLead] [Step 11] No user record found by name "${lead.assignedTo}". Using raw string.`);
        }
      }
    }

    console.log("[createLead] [Step 11] Creating in-app notification...");
    const newNotification = await NotificationModel.create({
      title: "New Lead Added",
      message: `Lead ${lead.name} has been added and assigned to ${assignedUserName}.`,
      type: "new_lead",
      targetRoles: ["sales manager"],
      targetUsers: targetUsers,
    });
    console.log(`[createLead] [Step 11] Notification created. ID: ${newNotification._id}, targetUsers:`, targetUsers);

    console.log(`[createLead] [Step 12] Responding with HTTP 201 Created for lead ID: ${lead._id}`);
    console.log("==================== [createLead] SUCCESS ====================\n");
    res.status(201).json({ success: true, data: lead });
  } catch (error) {
    console.error("[createLead] [ERROR] Exception caught during lead creation:", {
      message: error.message,
      stack: error.stack,
    });
    console.log("==================== [createLead] FAILED ====================\n");
    res.status(400).json({ success: false, message: error.message });
  }
};

export const updateLead = async (req, res) => {
  const { id } = req.params;
  console.log("\n==================== [updateLead] START ====================");
  console.log(`[updateLead] [Step 1] Request received at ${new Date().toISOString()} for Lead ID: ${id}`);
  console.log("[updateLead] [Step 1] Authenticated User:", {
    id: req.user?._id || req.user?.id,
    name: req.user?.name,
    email: req.user?.email,
    role: req.user?.role,
    organizationId: req.user?.organizationId || req.organization?._id,
  });
  console.log("[updateLead] [Step 1] Update Payload:", JSON.stringify(req.body, null, 2));

  if (req.file) {
    console.log("[updateLead] [Step 1] Audio recording attached:", {
      originalname: req.file.originalname,
      filename: req.file.filename,
      mimetype: req.file.mimetype,
      size: `${(req.file.size / 1024).toFixed(2)} KB`,
      path: req.file.path,
    });
  } else {
    console.log("[updateLead] [Step 1] No audio recording attached in update request.");
  }

  try {
    const { LeadModel, NotificationModel } = getModels(req);
    const updateData = req.body || {};

    console.log(`[updateLead] [Step 2] Finding existing lead with ID: ${id}...`);
    const lead = await LeadModel.findById(id);

    if (!lead) {
      console.warn(`[updateLead] [Step 2] REJECTED: Lead with ID ${id} not found.`);
      console.log("==================== [updateLead] NOT FOUND ====================\n");
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    }

    console.log("[updateLead] [Step 2] Existing lead located:", {
      id: lead._id,
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      status: lead.status,
      assignedTo: lead.assignedTo,
    });

    // Role check: sales reps can only update leads assigned to them and cannot reassign
    console.log(`[updateLead] [Step 3] Checking role permissions for user role: "${req.user?.role}"...`);
    if (req.user?.role === "sales person") {
      const isAssigned = isLeadAssignedToUser(lead, req.user);
      console.log(`[updateLead] [Step 3] Sales representative assignment check: ${isAssigned}`);
      if (!isAssigned) {
        console.warn(`[updateLead] [Step 3] REJECTED: Sales rep ${req.user?._id} (${req.user?.name}) attempted to update unassigned lead ${id}`);
        console.log("==================== [updateLead] FORBIDDEN ====================\n");
        return res.status(403).json({
          success: false,
          message: "Access forbidden: You can only update leads assigned to you",
        });
      }
      if (updateData.assignedTo !== undefined) {
        console.log(`[updateLead] [Step 3] Stripping 'assignedTo' (${updateData.assignedTo}) from update payload as sales reps cannot reassign leads.`);
        delete updateData.assignedTo;
      }
    } else {
      console.log(`[updateLead] [Step 3] User role "${req.user?.role}" authorized for all fields.`);
    }

    // Handle name field: optional. If non-empty, update it. If empty ("" or whitespace) or null, keep previous name.
    console.log("[updateLead] [Step 4] Checking name field update...");
    if (updateData.name !== undefined) {
      const trimmedName = String(updateData.name || "").trim();
      if (trimmedName) {
        updateData.name = trimmedName;
        console.log(`[updateLead] [Step 4] Name field will be updated to: "${trimmedName}"`);
      } else {
        console.log(`[updateLead] [Step 4] Provided name was empty/whitespace. Retaining existing name: "${lead.name}"`);
        delete updateData.name;
      }
    } else {
      console.log("[updateLead] [Step 4] Name field not present in update payload.");
    }

    // Handle file upload
    if (req.file) {
      console.log(`[updateLead] [Step 5] Processing audio upload: ${req.file.originalname}`);
      await processAudioUpload(req.file);
      const host = req.get("host") || "";
      const basePath = "/uploads/";
      const protocol =
        req.headers["x-forwarded-proto"] ||
        (host && !host.includes("localhost") ? "https" : req.protocol);
      const fileUrl = `${protocol}://${host}${basePath}${req.file.filename}`;
      console.log(`[updateLead] [Step 5] Audio file ready at URL: ${fileUrl}`);

      const recordingObj = {
        name: req.body.recordingName || req.file.originalname,
        url: fileUrl,
        analysisStatus: ENABLE_AI_AUDIO_ANALYSIS ? "pending" : "paused",
        uploadedAt: new Date(),
      };
      if (!lead.recordings) {
        lead.recordings = [];
      }
      lead.recordings.push(recordingObj);
      console.log("[updateLead] [Step 5] Attached new recording to lead:", recordingObj);
    } else {
      console.log("[updateLead] [Step 5] No recording file to process.");
    }

    const previousStatus = lead.status;
    console.log("[updateLead] [Step 6] Applying update fields to lead model:", updateData);
    lead.set(updateData);
    await lead.save();
    console.log(`[updateLead] [Step 6] Lead document saved to DB. ID: ${lead._id}, Previous Status: "${previousStatus}", Current Status: "${lead.status}"`);

    // AI Audio analysis trigger for newly uploaded recording
    if (req.file && ENABLE_AI_AUDIO_ANALYSIS) {
      const newRecording = lead.recordings[lead.recordings.length - 1];
      if (newRecording) {
        console.log(`[updateLead] [Step 7] Triggering background AI audio analysis for recording ${newRecording._id}...`);
        const orgApiKey = decryptApiKey(req.organization?.aiSettings?.geminiApiKey);
        triggerAudioAnalysis(
          lead._id,
          newRecording._id,
          req.file.path,
          req.file.mimetype,
          LeadModel,
          orgApiKey,
          req.organization?._id || req.user?.organizationId,
        ).catch((err) =>
          console.error("[AudioAnalysis] Background analysis error (updateLead):", err),
        );
      }
    } else {
      console.log(`[updateLead] [Step 7] Skipping audio analysis (file present: ${!!req.file}, AI enabled: ${ENABLE_AI_AUDIO_ANALYSIS})`);
    }

    // Status change notification
    if (updateData.status) {
      console.log(`[updateLead] [Step 8] Status changed ("${previousStatus}" -> "${lead.status}"). Creating notification for sales managers...`);
      const statusNotif = await NotificationModel.create({
        title: "Lead Status Updated",
        message: `Lead ${lead.name || lead.phone || "Lead"} status updated to ${lead.status}.`,
        type: "lead_update",
        targetRoles: ["sales manager"],
      });
      console.log(`[updateLead] [Step 8] Status update notification created. ID: ${statusNotif._id}`);
    } else {
      console.log("[updateLead] [Step 8] Status field not modified. Skipping status update notification.");
    }

    // When a human user updates this lead, mark any pending AI follow-ups as handled/done
    console.log("[updateLead] [Step 9] Checking pending AI follow-ups to mark as done...");
    try {
      const { FollowupModel } = getModels(req);
      const fuResult = await FollowupModel.updateMany(
        { leadId: id, author: "AI Agent", done: false },
        { $set: { done: true } }
      );
      console.log("[updateLead] [Step 9] Pending AI follow-ups updated:", fuResult);
    } catch (fuErr) {
      console.warn("[updateLead] [Step 9] Error marking pending AI follow-up as done:", fuErr.message);
    }

    console.log(`[updateLead] [Step 10] Responding with HTTP 200 OK for updated lead ID: ${lead._id}`);
    console.log("==================== [updateLead] SUCCESS ====================\n");
    res.json({ success: true, data: lead });
  } catch (error) {
    console.error(`[updateLead] [ERROR] Exception caught during lead update for ID ${id}:`, {
      message: error.message,
      stack: error.stack,
    });
    console.log("==================== [updateLead] FAILED ====================\n");
    res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteLead = async (req, res) => {
  try {
    if (req.user?.role === "sales person") {
      return res.status(403).json({
        success: false,
        message: "Access forbidden: Only sales managers and administrators can delete leads",
      });
    }

    const { LeadModel } = getModels(req);
    const { id } = req.params;

    const lead = await LeadModel.findByIdAndDelete(id);

    if (!lead) {
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    }

    res.json({
      success: true,
      message: "Lead deleted successfully",
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const updateStatusByWebhook = async (req, res) => {
  try {
    // Webhook secret verification
    const configuredSecret =
      process.env.LEAD_WEBHOOK_SECRET && process.env.LEAD_WEBHOOK_SECRET.trim();
    const providedSecret =
      (req.headers && (req.headers["x-webhook-secret"] || req.headers["x-secret-key"])) ||
      (req.query && req.query.secret);

    if (
      !configuredSecret ||
      !providedSecret ||
      providedSecret !== configuredSecret
    ) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: Invalid or missing webhook secret.",
      });
    }

    const { LeadModel, NotificationModel } = getModels(req);
    const { phone, email, event } = req.body;

    if (!phone && !email) {
      return res.status(400).json({
        success: false,
        message: "Either phone or email is required.",
      });
    }

    if (!event) {
      return res
        .status(400)
        .json({ success: false, message: "Event is required." });
    }

    let status = "";
    if (event === "converted") {
      status = "Converted";
    } else {
      return res
        .status(400)
        .json({ success: false, message: "Invalid event type." });
    }

    let lead = null;

    if (phone) {
      const cleanPhone = phone.replace(/\D/g, "");
      const last10Digits = cleanPhone.slice(-10);
      lead = await LeadModel.findOne({
        $or: [
          { phone: cleanPhone },
          { phone: new RegExp(last10Digits + "$") },
        ],
      });
    }

    if (!lead && email) {
      lead = await LeadModel.findOne({
        email: new RegExp("^" + email.trim() + "$", "i"),
      });
    }

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found matching the criteria.",
      });
    }

    const funnelOrder = ["New", "Converted"];
    const currentRank = funnelOrder.indexOf(lead.status);
    const targetRank = funnelOrder.indexOf(status);

    if (currentRank !== -1 && targetRank !== -1 && currentRank >= targetRank) {
      return res.status(200).json({
        success: true,
        message: `Lead is already at status "${lead.status}" (requested: "${status}"). No update needed.`,
        data: lead,
      });
    }

    lead.status = status;
    await lead.save();

    await NotificationModel.create({
      title: "Lead Status Webhook Update",
      message: `Lead ${lead.name} status updated to "${status}" via external booking app webhook event: ${event}.`,
      type: "lead_update",
      targetRoles: ["sales manager", "sales person"],
    });

    const io = getIO();
    if (io) {
      const orgId =
        req.user?.organizationId ||
        req.organization?._id ||
        lead.organizationId ||
        lead.organization ||
        null;
      const payload = {
        leadId: lead._id,
        status,
        lead,
      };
      if (orgId) {
        io.to(`org_${orgId}`).emit("conversation_updated", payload);
      } else {
        io.emit("conversation_updated", payload);
      }
    }

    res.status(200).json({
      success: true,
      message: `Status successfully updated to "${status}" for lead ${lead.name}.`,
      data: lead,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const analyzeRecording = async (req, res) => {
  if (!ENABLE_AI_AUDIO_ANALYSIS) {
    return res.json({
      success: false,
      message: "AI Call Analysis is temporarily disabled.",
    });
  }
  try {
    const { LeadModel } = getModels(req);
    const { id, recordingId } = req.params;
    const lead = await LeadModel.findById(id);
    if (!lead)
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });

    // Role check: sales reps can only trigger analysis for leads assigned to them
    if (req.user?.role === "sales person" && !isLeadAssignedToUser(lead, req.user)) {
      return res.status(403).json({
        success: false,
        message: "Access forbidden: You can only analyze recordings for leads assigned to you",
      });
    }

    const recording = lead.recordings.id(recordingId);
    if (!recording)
      return res
        .status(404)
        .json({ success: false, message: "Recording not found" });

    let filename = recording.url.split("/uploads/")[1];
    if (!filename)
      return res
        .status(400)
        .json({ success: false, message: "Invalid recording URL" });

    try {
      filename = decodeURIComponent(filename);
    } catch (e) {
      // Ignored
    }

    const filePath = path.join(process.cwd(), "uploads", filename);

    if (!fs.existsSync(filePath)) {
      return res
        .status(404)
        .json({ success: false, message: "Audio file not found on disk" });
    }

    recording.analysisStatus = "pending";
    await lead.save();

    // Trigger in background
    const orgApiKey = decryptApiKey(req.organization?.aiSettings?.geminiApiKey);
    const orgId = req.organization?._id || req.user?.organizationId;
    triggerAudioAnalysis(
      id,
      recordingId,
      filePath,
      "audio/mpeg",
      LeadModel,
      orgApiKey,
      orgId,
    ).catch((err) =>
      console.error("[AudioAnalysis] Background analysis error (analyzeRecording):", err),
    );

    res.json({
      success: true,
      message: "Transcription and audio analysis queued successfully.",
      recording,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Upload an audio recording file directly to a lead
 * @route   POST /api/leads/:id/recordings
 * @access  Protected
 */
export const uploadRecordingForLead = async (req, res) => {
  try {
    const { LeadModel } = getModels(req);
    const { id } = req.params;

    let lead = null;
    if (id && mongoose.Types.ObjectId.isValid(id)) {
      lead = await LeadModel.findById(id);
    }

    // Fallback: If id is a temp ID (e.g. temp-...) or invalid, try finding by phone from req.body or filename
    if (!lead && req.body?.phone) {
      const cleanPhone = String(req.body.phone).replace(/\D/g, "");
      const phoneSuffix = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;
      if (phoneSuffix.length >= 7) {
        lead = await LeadModel.findOne({ phone: { $regex: phoneSuffix + "$" } }).sort({ createdAt: -1 });
      }
    }

    if (!lead && req.file?.originalname) {
      const fileDigits = req.file.originalname.replace(/\D/g, "");
      if (fileDigits.length >= 10) {
        const potentialPhone = fileDigits.slice(-10);
        lead = await LeadModel.findOne({ phone: { $regex: potentialPhone + "$" } }).sort({ createdAt: -1 });
      }
    }

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    // Role check: sales reps can only upload recordings for leads assigned to them
    if (req.user?.role === "sales person" && !isLeadAssignedToUser(lead, req.user)) {
      return res.status(403).json({
        success: false,
        message: "Access forbidden: You can only upload recordings for leads assigned to you",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No audio file provided. Please attach a recording file.",
      });
    }

    await processAudioUpload(req.file);

    const host = req.get("host") || "";
    const basePath = "/uploads/";
    const protocol =
      req.headers["x-forwarded-proto"] ||
      (host && !host.includes("localhost") ? "https" : req.protocol);
    const fileUrl = `${protocol}://${host}${basePath}${req.file.filename}`;
    const recordingName =
      req.body.recordingName || req.file.originalname || `Recording_${Date.now()}`;

    const recordingObj = {
      name: recordingName,
      url: fileUrl,
      analysisStatus: ENABLE_AI_AUDIO_ANALYSIS ? "pending" : "paused",
      uploadedAt: new Date(),
    };

    if (!lead.recordings) {
      lead.recordings = [];
    }
    lead.recordings.push(recordingObj);
    await lead.save();

    const newRecording = lead.recordings[lead.recordings.length - 1];

    if (ENABLE_AI_AUDIO_ANALYSIS && newRecording) {
      const orgApiKey = decryptApiKey(req.organization?.aiSettings?.geminiApiKey);
      const orgId = req.organization?._id || req.user?.organizationId;
      triggerAudioAnalysis(
        lead._id,
        newRecording._id,
        req.file.path,
        req.file.mimetype,
        LeadModel,
        orgApiKey,
        orgId,
      ).catch((err) =>
        console.error("[AudioAnalysis] Background analysis error (uploadRecordingForLead):", err),
      );
    }

    const io = getIO();
    if (io) {
      const orgId = req.organization?._id || req.user?.organizationId;
      const payload = {
        leadId: lead._id.toString(),
        recording: newRecording,
      };
      if (orgId) {
        io.to(`org_${orgId}`).emit("recording_uploaded", payload);
      }
      io.emit("recording_uploaded", payload);
    }

    res.status(201).json({
      success: true,
      message: "Recording uploaded successfully. Transcription & analysis started.",
      data: newRecording,
      lead,
    });
  } catch (error) {
    console.error("[UploadRecording] Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Bulk imports leads from Excel (.xlsx, .xls) or CSV into Old Leads
 * @route   POST /api/leads/import-excel
 * @access  Protected / Tenant-scoped
 */
export const importExcelLeads = async (req, res) => {
  if (req.user?.role === "sales person") {
    return res.status(403).json({
      success: false,
      message: "Access forbidden: Only sales managers and administrators can bulk import leads",
    });
  }
  let uploadedFilePath = null;
  try {
    const { LeadModel, UserModel, AssignmentStateModel } = getModels(req);
    let rows = [];

    // 1. Process from uploaded file or from JSON array
    if (req.file) {
      uploadedFilePath = req.file.path;
      const workbook = XLSX.readFile(uploadedFilePath, { cellDates: true });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      rows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });
    } else if (Array.isArray(req.body.leads) && req.body.leads.length > 0) {
      rows = req.body.leads;
    } else {
      return res.status(400).json({
        success: false,
        message: "No Excel/CSV file or leads array provided.",
      });
    }

    if (rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "The uploaded spreadsheet contains no data rows.",
      });
    }

    if (rows.length > 300) {
      return res.status(400).json({
        success: false,
        message: `Maximum batch limit exceeded: Only up to 300 leads can be imported at once (found ${rows.length} rows). Please split your file and try again.`,
      });
    }

    const batchTag =
      req.body.batchTag?.trim() ||
      `Excel-Import-${new Date().toISOString().slice(0, 10)}`;
    const skipDuplicates = req.body.skipDuplicates !== false;
    const defaultService = req.body.defaultService || "General Enquiry";

    // Detect column name helper
    const findValue = (row, candidates) => {
      for (const key of Object.keys(row)) {
        const cleanKey = key.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
        for (const c of candidates) {
          const cleanCand = c.toLowerCase().replace(/[^a-z0-9]/g, "");
          if (cleanKey === cleanCand) {
            return row[key];
          }
        }
      }
      return "";
    };

    const validDocs = [];
    const duplicateRows = [];
    const invalidRows = [];
    const seenPhonesInFile = new Set();
    const candidatePhones = [];

    // First pass: validate and extract candidate phones
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowIndex = i + 2; // Accounting for 1-based index and header row

      const rawName = String(
        findValue(row, ["name", "fullname", "customername", "leadname", "clientname"]) || ""
      ).trim();

      const rawPhone = String(
        findValue(row, ["phone", "mobile", "mobilenumber", "contact", "contactnumber", "phonenumber", "whatsappnumber"]) || ""
      ).trim();

      const rawEmail = String(
        findValue(row, ["email", "emailaddress"]) || ""
      ).trim();

      const rawService = String(
        findValue(row, ["service", "product", "serviceproduct", "category"]) || ""
      ).trim();

      const rawCity = String(
        findValue(row, ["city", "location", "area"]) || ""
      ).trim();

      const rawCompany = String(
        findValue(row, ["company", "organization", "business", "companyname"]) || ""
      ).trim();

      const rawNotes = String(
        findValue(row, ["notes", "remarks", "comment", "description"]) || ""
      ).trim();

      const cleanDigits = rawPhone.replace(/\D/g, "");
      if (!cleanDigits || cleanDigits.length < 10) {
        invalidRows.push({
          row: rowIndex,
          name: rawName,
          phone: rawPhone,
          reason: "Invalid phone number (must contain at least 10 digits).",
        });
        continue;
      }

      const formattedPhone = cleanDigits;

      if (seenPhonesInFile.has(formattedPhone)) {
        duplicateRows.push({
          row: rowIndex,
          name: rawName,
          phone: formattedPhone,
          reason: "Duplicate number within the same spreadsheet.",
        });
        continue;
      }

      seenPhonesInFile.add(formattedPhone);
      candidatePhones.push(formattedPhone);

      const allowedSources = LeadModel.schema?.path("source")?.enumValues || [];
      const leadSource = allowedSources.includes("Excel Import") ? "Excel Import" : "Manual Entry";

      validDocs.push({
        name: rawName || `Lead ${formattedPhone.slice(-4)}`,
        phone: formattedPhone,
        email: rawEmail || undefined,
        service: rawService || defaultService,
        city: rawCity,
        company: rawCompany,
        notes: rawNotes,
        source: leadSource,
        status: "New",
        isOldLead: true, // Key requirement: added to Old Leads
        hasWhatsAppConsent: true,
        consentSource: "Excel Import",
        assignedTo: req.body.assignedTo || "Unassigned",
        tags: ["Excel Import", batchTag],
        joinedAt: new Date(),
        lastActivity: new Date(),
      });
    }

    // Second pass: Deduplicate against database if skipDuplicates is enabled
    let finalDocsToInsert = validDocs;
    if (skipDuplicates && candidatePhones.length > 0) {
      const last10s = candidatePhones.map((p) => p.slice(-10));
      const existingInDb = await LeadModel.find({
        $or: [
          { phone: { $in: candidatePhones } },
          { phone: { $in: last10s } },
        ],
      }).select("phone");

      const existingPhoneSet = new Set();
      for (const ex of existingInDb) {
        const clean = String(ex.phone || "").replace(/\D/g, "");
        if (clean) {
          existingPhoneSet.add(clean);
          existingPhoneSet.add(clean.slice(-10));
        }
      }

      finalDocsToInsert = [];
      for (const doc of validDocs) {
        const p = doc.phone;
        const p10 = p.slice(-10);
        if (existingPhoneSet.has(p) || existingPhoneSet.has(p10)) {
          duplicateRows.push({
            name: doc.name,
            phone: doc.phone,
            reason: "Lead already exists in CRM database.",
          });
        } else {
          finalDocsToInsert.push(doc);
        }
      }
    }

    // 3. Round-robin assignment if assignedTo is not specified
    if (finalDocsToInsert.length > 0 && (!req.body.assignedTo || req.body.assignedTo === "Unassigned")) {
      const reps = await UserModel.find({ role: "sales person" }).sort({ _id: 1 });
      if (reps && reps.length > 0) {
        let state = await AssignmentStateModel.findOne({ key: "leadAssignment" });
        if (!state) {
          state = await AssignmentStateModel.create({
            key: "leadAssignment",
            lastAssignedIndex: -1,
          });
        }
        let currentIndex = state.lastAssignedIndex;
        for (const doc of finalDocsToInsert) {
          currentIndex = (currentIndex + 1) % reps.length;
          doc.assignedTo = reps[currentIndex]._id.toString();
        }
        state.lastAssignedIndex = currentIndex;
        await state.save();
      }
    }

    // 4. Batch insert into Tenant Lead Collection with resilient fallback
    let insertedDocs = [];
    if (finalDocsToInsert.length > 0) {
      try {
        insertedDocs = await LeadModel.insertMany(finalDocsToInsert, {
          ordered: false,
        });
      } catch (insertErr) {
        console.warn("[leadController] insertMany encountered an error:", insertErr.message);
        if (Array.isArray(insertErr.insertedDocs) && insertErr.insertedDocs.length > 0) {
          insertedDocs = insertErr.insertedDocs;
        }
      }

      // If insertMany inserted 0 or was rejected, insert one-by-one with retry
      if (insertedDocs.length === 0 && finalDocsToInsert.length > 0) {
        for (const doc of finalDocsToInsert) {
          try {
            const created = await LeadModel.create(doc);
            if (created) insertedDocs.push(created);
          } catch (singleErr) {
            console.error(`[leadController] Failed to create lead ${doc.phone}:`, singleErr.message);
            if (singleErr.message?.includes("source")) {
              try {
                const retryDoc = { ...doc, source: "Manual Entry" };
                const createdRetry = await LeadModel.create(retryDoc);
                if (createdRetry) {
                  insertedDocs.push(createdRetry);
                  continue;
                }
              } catch (retryErr) {
                // fall through
              }
            }
            invalidRows.push({
              name: doc.name,
              phone: doc.phone,
              reason: singleErr.message,
            });
          }
        }
      }
    }

    // 5. Notify via Socket.IO
    const io = getIO();
    if (io && req.organization?._id) {
      io.to(`org_${req.organization._id}`).emit("leads_imported", {
        count: insertedDocs.length,
        isOldLead: true,
      });
    }

    res.status(200).json({
      success: true,
      message: `Successfully imported ${insertedDocs.length} leads into Old Leads (${duplicateRows.length} duplicates skipped, ${invalidRows.length} invalid).`,
      importedCount: insertedDocs.length,
      skippedDuplicates: duplicateRows.length,
      invalidCount: invalidRows.length,
      totalRows: rows.length,
      duplicates: duplicateRows.slice(0, 10),
      invalids: invalidRows.slice(0, 10),
    });
  } catch (error) {
    console.error("[LeadController] Error importing Excel leads:", error);
    res.status(500).json({
      success: false,
      message: `Failed to import leads: ${error.message}`,
    });
  } finally {
    if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
      try {
        fs.unlinkSync(uploadedFilePath);
      } catch (e) {
        // Ignored
      }
    }
  }
};

// @desc    Process missed call automatically in background (puts into Today's Follow-up & dispatches WhatsApp welcome message)
// @route   POST /api/leads/missed-call
// @access  Protected
export const handleMissedCall = async (req, res) => {
  try {
    const {
      phone,
      number,
      name,
      callTimestamp,
      durationSeconds = 0,
      customMessage,
      sendWhatsApp = true,
      service = "General Enquiry",
    } = req.body;

    console.log(`[Missed Call] Received POST /api/leads/missed-call:`, {
      caller: phone,
      receivedSim: number,
      name,
      simSlot: req.body.simSlot ?? req.body.slotIndex ?? req.body.simIndex ?? null,
      isDifferentSim: req.body.isDifferentSim ?? req.body.isDifferentNumber ?? null,
      hasCustomMessage: Boolean(customMessage && customMessage.trim()),
      user: req.user ? { id: req.user._id || req.user.id, role: req.user.role, phone: req.user.phone } : null,
    });

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required for missed call processing.",
      });
    }

    if (!number || !String(number).trim()) {
      return res.status(400).json({
        success: false,
        message: "Received SIM phone number ('number') is required.",
      });
    }

    const {
      LeadModel,
      FollowupModel,
      MessageModel,
      UserModel,
      WhatsAppSessionModel,
    } = getModels(req);

    let orgId = req.user?.organizationId
      ? req.user.organizationId.toString()
      : req.organization?._id
        ? req.organization._id.toString()
        : null;

    // Clean and normalize caller phone number
    const rawPhone = String(phone).trim();
    const cleanDigits = rawPhone.replace(/\D/g, "");
    const last10Digits =
      cleanDigits.length >= 10 ? cleanDigits.slice(-10) : cleanDigits;
    let normalizedPhone = cleanDigits;
    if (normalizedPhone.length > 10 && normalizedPhone.startsWith("91")) {
      normalizedPhone = normalizedPhone.substring(2);
    }

    // Clean and normalize received SIM number
    const cleanReceived = String(number).replace(/\D/g, "");
    const receivedLast10 =
      cleanReceived.length >= 10 ? cleanReceived.slice(-10) : cleanReceived;

    // Build flexible phone query matching
    const orConditions = [];
    if (rawPhone) orConditions.push({ phone: rawPhone });
    if (cleanDigits) orConditions.push({ phone: cleanDigits });
    if (cleanDigits && !cleanDigits.startsWith("+")) orConditions.push({ phone: `+${cleanDigits}` });
    if (normalizedPhone) orConditions.push({ phone: normalizedPhone });
    if (last10Digits.length >= 7) {
      orConditions.push({ phone: new RegExp(last10Digits + "$") });
    }

    const orgTimezone = req.organization?.timezone || "Asia/Kolkata";
    let todayStr = (req.body?.clientDate && /^\d{4}-\d{2}-\d{2}$/.test(req.body.clientDate))
      ? req.body.clientDate
      : "";
    if (!todayStr) {
      try {
        todayStr = new Date().toLocaleDateString("en-CA", { timeZone: orgTimezone });
      } catch (err) {
        todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      }
    }
    const missedTime = callTimestamp ? new Date(callTimestamp) : new Date();
    const timeFormatted = missedTime.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });

    // Schedule follow-up 30 minutes after the missed call
    const followupDate = new Date(missedTime.getTime() + 30 * 60 * 1000);
    const followupTimeFormatted = followupDate.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });

    let lead = await LeadModel.findOne({ $or: orConditions });

    // ================================================================
    // SALES REP RESOLUTION
    // Resolve the receiving sales representative:
    // 1) Explicit rep ID in request body (salesRepId, salesPersonId, repId, userId)
    // 2) Received SIM phone matching UserModel phone
    // 3) Received SIM phone matching WhatsAppSession connectedPhone
    // 4) Auth token user (if role is sales person)
    // 5) Existing lead assignedTo (if assigned to a sales person)
    // ================================================================
    const normalizedUserRole = String(req.user?.role || "").toLowerCase().trim();
    const isRepUser =
      normalizedUserRole === "sales person" ||
      normalizedUserRole === "sales rep" ||
      normalizedUserRole === "sales representative" ||
      normalizedUserRole === "rep" ||
      Boolean(req.user?.isSalesPerson);

    let resolvedRep = null;
    if (isRepUser) {
      resolvedRep = req.user;
    }

    const canQueryUsers = Boolean(req?.tenantModels?.User || (mongoose.connection?.readyState === 1 && UserModel));
    const canQuerySessions = Boolean(
      req?.tenantModels?.WhatsAppSession ||
      (mongoose.connection?.readyState === 1 && (WhatsAppSessionModel || WhatsAppSession))
    );

    const rawRepIdentifier = String(
      req.body.salesRepId ||
      req.body.salesrepId ||
      req.body.salesPersonId ||
      req.body.salespersonId ||
      req.body.salesRep ||
      req.body.repId ||
      ""
    ).trim();

    if (!resolvedRep && rawRepIdentifier && canQueryUsers) {
      if (mongoose.Types.ObjectId.isValid(rawRepIdentifier)) {
        resolvedRep = await UserModel.findById(rawRepIdentifier)
          .select("name email phone role organizationId")
          .lean();
      }
      if (!resolvedRep) {
        resolvedRep = await UserModel.findOne({
          $or: [
            { name: new RegExp("^" + rawRepIdentifier + "$", "i") },
            { email: new RegExp("^" + rawRepIdentifier + "$", "i") },
          ],
        })
          .select("name email phone role organizationId")
          .lean();
      }
    }

    if (!resolvedRep && receivedLast10 && canQueryUsers) {
      resolvedRep = await UserModel.findOne({
        phone: { $regex: receivedLast10 + "$" },
        role: { $in: ["sales person", "sales rep", "rep"] },
      })
        .select("name email phone role organizationId")
        .lean();

      if (!resolvedRep) {
        const anyUser = await UserModel.findOne({
          phone: { $regex: receivedLast10 + "$" },
        })
          .select("name email phone role organizationId")
          .lean();
        if (anyUser && !["super_admin", "admin", "sales manager"].includes(anyUser.role)) {
          resolvedRep = anyUser;
        }
      }
    }

    if (!resolvedRep && receivedLast10 && (canQuerySessions || typeof getWhatsAppStatus === "function")) {
      try {
        if (canQuerySessions) {
          const SessionModel =
            WhatsAppSessionModel ||
            req?.tenantModels?.WhatsAppSession ||
            (mongoose.connection?.readyState === 1 ? WhatsAppSession : null);
          if (SessionModel) {
            const matchingSession = await SessionModel.findOne({
              sessionId: { $regex: "_user_" },
              connectedPhone: { $regex: receivedLast10 + "$" },
            }).lean();
            if (matchingSession && matchingSession.sessionId && canQueryUsers) {
              const repMatch = matchingSession.sessionId.match(/_user_([a-fA-F0-9]{24})/);
              if (repMatch && UserModel) {
                resolvedRep = await UserModel.findById(repMatch[1])
                  .select("name email phone role organizationId")
                  .lean();
              }
            }
          }
        }
        if (!resolvedRep && typeof getWhatsAppStatus === "function") {
          const memStatuses = getWhatsAppStatus(orgId) || [];
          const memMatch = memStatuses.find(
            (m) =>
              m.sessionId?.includes("_user_") &&
              String(m.connectedPhone || "").replace(/\D/g, "").endsWith(receivedLast10)
          );
          if (memMatch && memMatch.sessionId && canQueryUsers) {
            const repMatch = memMatch.sessionId.match(/_user_([a-fA-F0-9]{24})/);
            if (repMatch && UserModel) {
              resolvedRep = await UserModel.findById(repMatch[1])
                .select("name email phone role organizationId")
                .lean();
            }
          }
        }
      } catch (sessFindErr) {
        console.warn("[Missed Call] Error resolving rep from WhatsAppSession:", sessFindErr.message);
      }
    }

    if (!resolvedRep && lead?.assignedTo && canQueryUsers) {
      if (mongoose.Types.ObjectId.isValid(lead.assignedTo)) {
        const assignedDoc = await UserModel.findById(lead.assignedTo)
          .select("name email phone role organizationId")
          .lean();
        if (assignedDoc && ["sales person", "sales rep", "rep"].includes(assignedDoc.role)) {
          resolvedRep = assignedDoc;
        }
      }
    }

    if (!orgId && resolvedRep?.organizationId) {
      orgId = resolvedRep.organizationId.toString();
    }

    const resolvedRepId = resolvedRep ? (resolvedRep._id || resolvedRep.id)?.toString() : null;
    const resolvedRepName = resolvedRep?.name || null;
    const isRepOwnedMissedCall = Boolean(resolvedRep);

    let isNewLead = false;
    const assignedUserId =
      resolvedRepId ||
      (isRepUser ? (req.user._id || req.user.id)?.toString() : "") ||
      (req.user?._id || req.user?.id || "").toString();

    let callerName = name && name.trim() ? name.trim() : "";
    if (lead) {
      if (!callerName) callerName = lead.name || `Caller ${last10Digits.slice(-4)}`;
      // Existing Lead: Update notes and set status to Missed Call if not already converted
      if (lead.status !== "Converted") {
        lead.status = "Missed Call";
      }
      if (assignedUserId && (!lead.assignedTo || lead.assignedTo === "Unassigned")) {
        lead.assignedTo = assignedUserId;
      }

      const missedNote = `[Missed Call] Received on ${missedTime.toLocaleDateString()} at ${timeFormatted}.`;
      lead.notes = lead.notes ? `${missedNote}\n${lead.notes}` : missedNote;
      await lead.save();
    } else {
      // New Lead: Create fresh lead directly into Missed Calls
      isNewLead = true;
      if (!callerName) callerName = `Caller ${last10Digits.slice(-4)}`;

      lead = await LeadModel.create({
        name: callerName,
        phone: rawPhone.startsWith("+") ? rawPhone : `+91${last10Digits}`,
        source: "Call",
        service: service || "General Enquiry",
        status: "Missed Call",
        nextFollowUp: todayStr,
        followupTime: followupTimeFormatted,
        preferredContactMethod: "Call",
        priority: "High",
        assignedTo: assignedUserId || "Unassigned",
        joinedAt: missedTime,
        notes: `New lead created from missed call received on ${missedTime.toLocaleDateString()} at ${timeFormatted}.`,
      });
    }

    // Upsert Followup record in Followup collection for reference
    try {
      await FollowupModel.create({
        leadId: lead._id,
        leadName: lead.name,
        type: "Call",
        date: todayStr,
        time: followupTimeFormatted,
        priority: "High",
        notes: `Missed call received at ${timeFormatted}.`,
        author: resolvedRepName || req.user?.name || "Mobile App",
        done: false,
      });
    } catch (fErr) {
      console.warn("[Missed Call] Note creating Followup entry:", fErr.message);
    }

    // Broadcast lead update via Socket.IO
    const io = getIO();
    if (io) {
      const room = orgId ? `org_${orgId}` : null;
      if (room) {
        io.to(room).emit("lead_updated", { leadId: lead._id, lead });
      }
    }

    // Automated Background WhatsApp Welcome Message Dispatch
    let whatsappSent = false;
    let whatsappError = null;
    let dispatchedMessageText = "";
    let isSameNumberResult = null;
    let activeConnectedPhoneResult = "";

    if (sendWhatsApp) {
      try {
        // Anti-spam guard: Check if an outgoing WhatsApp message was sent to this lead within the last 5 minutes
        const recentMessage = await MessageModel.findOne({
          leadId: lead._id,
          direction: "outgoing",
          timestamp: { $gte: new Date(Date.now() - 5 * 60 * 1000) },
        });

        if (recentMessage) {
          console.log(
            `[Missed Call] Outgoing message was already sent to lead ${lead._id} in the last 5 minutes. Skipping duplicate WhatsApp welcome.`
          );
        } else {
          // Retrieve missed call configuration from tenant SystemSettings or Organization
          let missedCallEnabled = true;
          let sameNumberTemplate = "";
          let differentNumberTemplate = "";

          try {
            const SystemSettingsModel = req?.tenantModels?.SystemSettings;
            if (SystemSettingsModel || (mongoose.connection?.readyState === 1 && SystemSettings)) {
              const TargetSysModel = SystemSettingsModel || SystemSettings;
              const resSys = TargetSysModel.findOne();
              const sysSettings = typeof resSys?.lean === "function" ? await resSys.lean() : await resSys;
              if (sysSettings) {
                if (sysSettings.missedCallMessageEnabled !== undefined) {
                  missedCallEnabled = sysSettings.missedCallMessageEnabled;
                }
                if (sysSettings.missedCallMessageTemplate) {
                  sameNumberTemplate = sysSettings.missedCallMessageTemplate;
                }
                if (sysSettings.missedCallDifferentNumberTemplate) {
                  differentNumberTemplate = sysSettings.missedCallDifferentNumberTemplate;
                }
              }
            }
            if (orgId && mongoose.connection?.readyState === 1 && (!sameNumberTemplate || !differentNumberTemplate)) {
              const { Organization } = getMasterModels();
              const orgDoc = await Organization.findById(orgId).select("aiSettings name").lean();
              if (orgDoc?.aiSettings) {
                if (orgDoc.aiSettings.missedCallMessageEnabled !== undefined && sameNumberTemplate === "") {
                  missedCallEnabled = orgDoc.aiSettings.missedCallMessageEnabled;
                }
                if (!sameNumberTemplate && orgDoc.aiSettings.missedCallMessageTemplate) {
                  sameNumberTemplate = orgDoc.aiSettings.missedCallMessageTemplate;
                }
                if (!differentNumberTemplate && orgDoc.aiSettings.missedCallDifferentNumberTemplate) {
                  differentNumberTemplate = orgDoc.aiSettings.missedCallDifferentNumberTemplate;
                }
              }
            }
          } catch (sErr) {
            console.warn("[Missed Call] Error fetching missed call settings:", sErr.message);
          }

          if (!missedCallEnabled) {
            console.log(
              `[Missed Call] Automated missed call messages are disabled in organization settings. Skipping WhatsApp.`
            );
          } else {
            const senderName = resolvedRepName || req.user?.name || "Sales Team";

            // Target session determination:
            // If this call belongs to a Sales Rep, strictly route to rep's personal session!
            let targetSessionId = null;
            if (resolvedRepId) {
              targetSessionId = orgId ? `org_${orgId}_user_${resolvedRepId}` : `user_${resolvedRepId}`;
            } else if (isRepUser) {
              const uId = (req.user._id || req.user.id).toString();
              targetSessionId = orgId ? `org_${orgId}_user_${uId}` : `user_${uId}`;
            } else if (orgId) {
              targetSessionId = `org_${orgId}`;
            }

            // Determine active connected phone number for the target session
            let activeConnectedPhone = "";
            try {
              if (typeof getWhatsAppStatus === "function") {
                const memoryStatuses = getWhatsAppStatus(orgId) || [];
                const mem = memoryStatuses.find((m) => m.sessionId === targetSessionId);
                if (mem?.connectedPhone) {
                  activeConnectedPhone = mem.connectedPhone;
                }
              }
              if (!activeConnectedPhone && targetSessionId) {
                const SessionModel =
                  WhatsAppSessionModel ||
                  req.tenantModels?.WhatsAppSession ||
                  (mongoose.connection?.readyState === 1 ? WhatsAppSession : null);
                if (SessionModel) {
                  const q = SessionModel.findOne({ sessionId: targetSessionId });
                  const dbSession = typeof q?.lean === "function" ? await q.lean() : await q;
                  if (dbSession?.connectedPhone) {
                    activeConnectedPhone = dbSession.connectedPhone;
                  }
                }
              }
            } catch (pErr) {
              console.warn("[Missed Call] Error retrieving active WhatsApp connected phone:", pErr.message);
            }

            // Normalize both numbers to compare digits
            const cleanConnected = String(activeConnectedPhone || "").replace(/\D/g, "");
            const connectedLast10 = cleanConnected.length >= 10 ? cleanConnected.slice(-10) : cleanConnected;

            const simSlotVal = req.body.simSlot ?? req.body.slotIndex ?? req.body.simIndex ?? null;
            const isExplicitDifferentSim = Boolean(
              req.body.isDifferentNumber ||
              req.body.isDifferentSim ||
              req.body.differentSim ||
              (simSlotVal !== null && (Number(simSlotVal) === 2 || String(simSlotVal).toLowerCase() === "sim 2" || String(simSlotVal).toLowerCase() === "sim2"))
            );

            let isSameNumber = Boolean(receivedLast10 && connectedLast10 && receivedLast10 === connectedLast10);
            if (isExplicitDifferentSim) {
              isSameNumber = false;
            }
            isSameNumberResult = isSameNumber;
            activeConnectedPhoneResult = activeConnectedPhone;

            console.log(`[Missed Call Template Selection]`, {
              receivedSimInPayload: number,
              receivedLast10,
              whatsAppConnectedPhone: activeConnectedPhone,
              connectedLast10,
              simSlotVal,
              isExplicitDifferentSim,
              isSameNumber,
              hasCustomMessage: Boolean(customMessage && customMessage.trim()),
              templateChosen: (customMessage && customMessage.trim())
                ? "CUSTOM_MESSAGE"
                : (isSameNumber ? "SAME_NUMBER" : "DIFFERENT_NUMBER"),
            });

            let welcomeText = "";
            if (customMessage && customMessage.trim()) {
              welcomeText = customMessage.trim();
            } else if (isSameNumber) {
              // Same number: Do NOT include/attach the secondary number
              const rawTpl =
                sameNumberTemplate ||
                `Hello {{name}}! 👋 We have received your call, but we couldn't connect. We will call you back shortly. In the meantime, if you have any questions, you can ask right here! 💬`;
              welcomeText = rawTpl
                .replace(/\{\{\s*name\s*\}\}/gi, callerName || "there")
                .replace(/\{\{\s*company\s*\}\}/gi, req.organization?.name || "Our Team")
                .replace(/\{\{\s*service\s*\}\}/gi, service || "General Enquiry");
            } else {
              // Different number: Mention that the customer contacted this number and this is also my/our number
              const formattedNumber = String(number).trim().startsWith("+")
                ? String(number).trim()
                : (cleanReceived.length === 10 ? `+91 ${cleanReceived}` : String(number).trim());

              const rawTpl =
                differentNumberTemplate ||
                `Hello {{name}}! 👋 You have contacted {{number}}, this is also my number. We couldn't connect right now, but we will call you back shortly. Feel free to message us right here on WhatsApp! 💬`;
              welcomeText = rawTpl
                .replace(/\{\{\s*name\s*\}\}/gi, callerName || "there")
                .replace(/\{\{\s*number\s*\}\}/gi, formattedNumber)
                .replace(/\{\{\s*company\s*\}\}/gi, req.organization?.name || "Our Team")
                .replace(/\{\{\s*service\s*\}\}/gi, service || "General Enquiry");
            }

            dispatchedMessageText = welcomeText;

            try {
              await sendMessageFromCRM(
                lead._id,
                welcomeText,
                senderName,
                {
                  organizationId: orgId,
                  tenantModels: req.tenantModels,
                  sessionId: targetSessionId,
                }
              );
              whatsappSent = true;
            } catch (sessionErr) {
              // Strictly do NOT fall back to the Sales Manager / organization line if this call belongs to a Sales Rep!
              if (isRepOwnedMissedCall || (targetSessionId && targetSessionId.includes("_user_"))) {
                console.warn(
                  `[Missed Call] Rep personal session ${targetSessionId} failed/offline: ${sessionErr.message}. Strictly preventing fallback to manager line org_${orgId}.`
                );
                whatsappError = sessionErr.message;
                whatsappSent = false;
              } else {
                throw sessionErr;
              }
            }
          }
        }
      } catch (waErr) {
        console.warn(`[Missed Call] WhatsApp automated dispatch error:`, waErr.message);
        whatsappError = waErr.message;
      }
    }

    return res.status(200).json({
      success: true,
      message: "Missed call processed successfully. Lead is scheduled in Today's Follow-up.",
      data: {
        lead,
        isNewLead,
        todayFollowupDate: todayStr,
        whatsappSent,
        whatsappError,
        dispatchedMessageText,
        isSameNumber: isSameNumberResult,
        activeConnectedPhone: activeConnectedPhoneResult,
        receivedSimNumber: number,
        templateType: (customMessage && customMessage.trim()) ? "custom" : (isSameNumberResult ? "same_number" : "different_number"),
      },
    });
  } catch (error) {
    console.error("[Missed Call] Error processing missed call:", error);
    return res.status(500).json({
      success: false,
      message: `Failed to process missed call: ${error.message}`,
    });
  }
};

// @desc    Assign sales rep to lead by phone number if he is not already the assigned sales rep
// @route   POST /api/leads/inbound-call
// @access  Protected
export const handleInboundCall = async (req, res) => {
  console.log("\n==================== [handleInboundCall] START ====================");
  console.log(`[handleInboundCall] [Step 1] Request received at ${new Date().toISOString()}`);
  console.log("[handleInboundCall] [Step 1] Request Body:", JSON.stringify(req.body, null, 2));
  console.log("[handleInboundCall] [Step 1] Auth User from Token:", req.user ? {
    id: req.user._id || req.user.id,
    name: req.user.name,
    email: req.user.email,
    role: req.user.role,
  } : "None");

  try {
    const { LeadModel, UserModel, NotificationModel, FollowupModel } = getModels(req);

    // 1. Extract phone number (accepts phone, number, or phoneNumber)
    const rawPhone = String(req.body.phone || req.body.number || req.body.phoneNumber || "").trim();

    if (!rawPhone) {
      console.warn("[handleInboundCall] [Step 1] REJECTED: Phone number is required.");
      console.log("==================== [handleInboundCall] FAILED ====================\n");
      return res.status(400).json({
        success: false,
        message: "Phone number (phone or number) is required.",
      });
    }

    // 2. Resolve target sales rep (supports salesRepId, salesPersonId, salesRep, repId, userId, id, name, email, or Bearer token)
    const rawRepIdentifier = String(
      req.body.salesRepId ||
      req.body.salesrepId ||
      req.body.salesPersonId ||
      req.body.salespersonId ||
      req.body.salesRep ||
      req.body.salesrep ||
      req.body.salesPerson ||
      req.body.salesperson ||
      req.body.repId ||
      req.body.userId ||
      req.body.id ||
      req.user?._id ||
      req.user?.id ||
      ""
    ).trim();

    if (!rawRepIdentifier) {
      console.warn("[handleInboundCall] [Step 1] REJECTED: Sales rep ID or Bearer token is required.");
      console.log("==================== [handleInboundCall] FAILED ====================\n");
      return res.status(400).json({
        success: false,
        message: "Sales rep identification is required (pass salesRepId/salesRep in body or Authorization token in header).",
      });
    }

    // Fetch user details for target sales rep by ID, Name, or Email
    let targetRepDoc = null;
    if (mongoose.Types.ObjectId.isValid(rawRepIdentifier)) {
      targetRepDoc = await UserModel.findById(rawRepIdentifier).select("name email role");
    }
    if (!targetRepDoc) {
      targetRepDoc = await UserModel.findOne({
        $or: [
          { name: new RegExp("^" + rawRepIdentifier + "$", "i") },
          { email: new RegExp("^" + rawRepIdentifier + "$", "i") },
        ],
      }).select("name email role");
    }
    if (!targetRepDoc && req.user) {
      targetRepDoc = req.user;
    }

    const targetRepId = targetRepDoc ? (targetRepDoc._id || targetRepDoc.id).toString() : rawRepIdentifier;
    const targetRepName = targetRepDoc?.name || "Sales Representative";

    console.log(`[handleInboundCall] [Step 2] Resolved Target Sales Rep: "${targetRepName}" (ID: ${targetRepId})`);

    // 3. Normalize phone number for search (match last 10 digits)
    const cleanDigits = rawPhone.replace(/\D/g, "");
    const last10Digits = cleanDigits.length >= 10 ? cleanDigits.slice(-10) : cleanDigits;
    let normalizedPhone = cleanDigits;
    if (normalizedPhone.length > 10 && normalizedPhone.startsWith("91")) {
      normalizedPhone = normalizedPhone.substring(2);
    }

    const orConditions = [];
    if (rawPhone) orConditions.push({ phone: rawPhone });
    if (cleanDigits) orConditions.push({ phone: cleanDigits });
    if (cleanDigits && !cleanDigits.startsWith("+")) orConditions.push({ phone: `+${cleanDigits}` });
    if (normalizedPhone) orConditions.push({ phone: normalizedPhone });
    if (last10Digits.length >= 7) {
      orConditions.push({ phone: new RegExp(last10Digits + "$") });
    }

    console.log(`[handleInboundCall] [Step 3] Looking up lead matching phone: "${rawPhone}" (clean10: "${last10Digits}")...`);
    let lead = await LeadModel.findOne({ $or: orConditions });

    if (!lead) {
      console.warn(`[handleInboundCall] [Step 3] NOT FOUND: No lead found with phone: ${rawPhone}`);
      console.log("==================== [handleInboundCall] NOT FOUND ====================\n");
      return res.status(404).json({
        success: false,
        message: `Lead not found with phone number ${rawPhone}.`,
      });
    }

    console.log("[handleInboundCall] [Step 4] Lead located:", {
      id: lead._id,
      name: lead.name,
      phone: lead.phone,
      currentAssignedTo: lead.assignedTo,
      status: lead.status,
    });

    const currentAssigneeRaw = String(lead.assignedTo || "").trim();

    // 4. Check if lead is ALREADY assigned to this sales rep
    const isAlreadyAssigned =
      currentAssigneeRaw === targetRepId ||
      (targetRepName && currentAssigneeRaw.toLowerCase() === targetRepName.toLowerCase());

    if (isAlreadyAssigned) {
      console.log(`[handleInboundCall] [Step 5] Lead is ALREADY assigned to ${targetRepName} (${targetRepId}). No reassignment needed.`);
      console.log("==================== [handleInboundCall] ALREADY ASSIGNED ====================\n");
      return res.status(200).json({
        success: true,
        isReassigned: false,
        previousAssignee: null,
        currentAssignee: {
          id: targetRepId,
          name: targetRepName,
        },
        message: `Lead is already assigned to ${targetRepName}.`,
        data: lead,
      });
    }

    // 5. Sales rep is NOT the current sales rep -> REASSIGN TO THIS SALES REP!
    console.log(`[handleInboundCall] [Step 5] Sales rep is NOT current assignee (${currentAssigneeRaw}). Reassigning to ${targetRepName} (${targetRepId})...`);

    let prevRepName = currentAssigneeRaw || "Unassigned";
    let prevRepId = currentAssigneeRaw;

    if (currentAssigneeRaw && currentAssigneeRaw !== "Unassigned") {
      if (mongoose.Types.ObjectId.isValid(currentAssigneeRaw)) {
        const prevUser = await UserModel.findById(currentAssigneeRaw).select("name");
        if (prevUser) {
          prevRepName = prevUser.name;
          prevRepId = prevUser._id.toString();
        }
      } else {
        const prevUser = await UserModel.findOne({ name: currentAssigneeRaw }).select("name");
        if (prevUser) {
          prevRepId = prevUser._id.toString();
        }
      }
    }

    // Format transfer note
    const now = new Date();
    const dateFormatted = now.toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
    const timeFormatted = now.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
    const transferNote = `[Inbound Call Reassignment] Lead reassigned from ${prevRepName} to ${targetRepName} on ${dateFormatted} at ${timeFormatted}.`;
    const updatedNotes = lead.notes ? `${transferNote}\n${lead.notes}` : transferNote;

    // Use direct atomic findByIdAndUpdate with $set to guarantee MongoDB Mixed type persistence
    const updatedLead = await LeadModel.findByIdAndUpdate(
      lead._id,
      {
        $set: {
          assignedTo: targetRepId,
          notes: updatedNotes,
        },
      },
      { new: true }
    );

    console.log(`[handleInboundCall] [Step 5] Lead ${updatedLead._id} atomically updated in MongoDB: assignedTo = ${updatedLead.assignedTo}`);

    // Notify previous rep & sales managers
    try {
      const notifTargetUsers = [];
      if (mongoose.Types.ObjectId.isValid(prevRepId) && prevRepId !== targetRepId) {
        notifTargetUsers.push(prevRepId);
      }

      await NotificationModel.create({
        title: "Lead Reassigned (Customer Inbound Call)",
        message: `Lead ${updatedLead.name || updatedLead.phone} was reassigned to ${targetRepName}.`,
        type: "lead_reassigned",
        targetRoles: ["sales manager"],
        targetUsers: notifTargetUsers,
      });
      console.log(`[handleInboundCall] [Step 5] Notification dispatched for reassignment.`);
    } catch (nErr) {
      console.warn("[handleInboundCall] Notification warning:", nErr.message);
    }

    // Record activity in Followup timeline
    try {
      await FollowupModel.create({
        leadId: updatedLead._id,
        leadName: updatedLead.name,
        type: "Lead Reassigned",
        date: now.toISOString().split("T")[0],
        time: timeFormatted,
        priority: "Medium",
        notes: `Inbound touchpoint: Lead ownership reassigned from ${prevRepName} to ${targetRepName}.`,
        author: targetRepName,
        done: true,
      });
      console.log(`[handleInboundCall] [Step 5] Followup activity log recorded.`);
    } catch (fErr) {
      console.warn("[handleInboundCall] Followup log warning:", fErr.message);
    }

    // Broadcast real-time update via Socket.IO
    const io = getIO();
    if (io) {
      const orgId = req.user?.organizationId || req.organization?._id;
      const payload = {
        leadId: updatedLead._id.toString(),
        newAssignee: targetRepId,
        newAssigneeName: targetRepName,
        previousAssignee: prevRepId,
        previousAssigneeName: prevRepName,
        lead: updatedLead,
      };
      if (orgId) {
        io.to(`org_${orgId}`).emit("lead_reassigned", payload);
        io.to(`org_${orgId}`).emit("lead_updated", { leadId: updatedLead._id, lead: updatedLead });
      } else {
        io.emit("lead_reassigned", payload);
        io.emit("lead_updated", { leadId: updatedLead._id, lead: updatedLead });
      }
      console.log("[handleInboundCall] [Step 5] Socket.IO broadcast emitted.");
    }

    console.log(`[handleInboundCall] [Step 6] Responding with HTTP 200 OK for reassigned lead ID: ${updatedLead._id}`);
    console.log("==================== [handleInboundCall] SUCCESS ====================\n");

    return res.status(200).json({
      success: true,
      isReassigned: true,
      previousAssignee: {
        id: prevRepId,
        name: prevRepName,
      },
      currentAssignee: {
        id: targetRepId,
        name: targetRepName,
      },
      message: `Lead ${updatedLead.name || updatedLead.phone} successfully reassigned from ${prevRepName} to ${targetRepName}.`,
      data: updatedLead,
    });
  } catch (error) {
    console.error("[handleInboundCall] [ERROR]:", error);
    console.log("==================== [handleInboundCall] FAILED ====================\n");
    return res.status(500).json({
      success: false,
      message: `Failed to process inbound call reassignment: ${error.message}`,
    });
  }
};

