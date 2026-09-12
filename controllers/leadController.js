import mongoose from "mongoose";
import Lead from "../models/Lead.js";
import User from "../models/User.js";
import AssignmentState from "../models/AssignmentState.js";
import Followup from "../models/Followup.js";
import Notification from "../models/Notification.js";
import Conversation from "../models/Conversation.js";
import Message from "../models/Message.js";
import AILog from "../models/AILog.js";
import { getIO } from "../socket/socket.js";
import fs from "fs";
import path from "path";
import { analyzeAudioFile } from "../services/audioAnalysisService.js";
import { sendWelcomeEnquiryMessage } from "../whatsapp/whatsappService.js";
import { decryptApiKey } from "../utils/encryption.js";
import { recordAiUsage } from "../services/aiUsageService.js";
import * as XLSX from "xlsx";

// Feature toggle to pause AI Call Analysis temporarily
const ENABLE_AI_AUDIO_ANALYSIS =
  process.env.ENABLE_AI_AUDIO_ANALYSIS === "true"; // Defaults to false (paused)

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
});

// Helper for background audio analysis
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
      `[AudioAnalysis] AI Audio Analysis is temporarily paused. Skipping analysis for recording ${recordingId}`,
    );
    return;
  }
  try {
    console.log(
      `[AudioAnalysis] Starting background analysis for lead ${leadId}, recording ${recordingId}`,
    );
    const analysis = await analyzeAudioFile(filePath, mimeType, orgApiKey);
    await LeadModel.updateOne(
      { _id: leadId, "recordings._id": recordingId },
      {
        $set: {
          "recordings.$.analysis": analysis,
          "recordings.$.analysisStatus": "completed",
        },
      },
    );
    console.log(
      `[AudioAnalysis] Successfully updated analysis for recording ${recordingId}`,
    );
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
        },
      },
    );
  }
};

export const getLeads = async (req, res) => {
  try {
    const { LeadModel } = getModels(req);
    const leads = await LeadModel.find({});
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
      currentUserRole = "",
      currentUserName = "",
      currentUserId = "",
    } = req.query;

    const { LeadModel, UserModel } = getModels(req);

    const pageNum = parseInt(page) || 0;
    const isAll = limit === "All" || limit === "all";
    const limitNum = isAll ? 0 : parseInt(limit) || 10;

    let query = {};

    // Determine effective sales rep filter condition (supports ID with fallback to legacy name)
    const activeSalesRepFilter = salespersonId || (salesperson !== "All" ? salesperson : null);
    let assigneeMatchConditions = null;

    const isSalesRepUser =
      currentUserRole === "Sales Representative" ||
      currentUserRole === "sales person" ||
      req.user?.role === "sales person";
    const effectiveUserId = currentUserId || req.userTokenData?.id || req.user?._id;

    if (isSalesRepUser && (effectiveUserId || currentUserName)) {
      const matchArray = [];
      if (effectiveUserId) {
        matchArray.push(String(effectiveUserId));
        if (mongoose.Types.ObjectId.isValid(effectiveUserId)) {
          matchArray.push(new mongoose.Types.ObjectId(effectiveUserId));
        }
      }
      if (currentUserName) {
        matchArray.push(new RegExp("^" + currentUserName + "$", "i"));
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

    const todayStr = new Date().toISOString().split("T")[0];

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
        },
      },
    ]);

    const counts = {
      OldLeads: facetCounts[0].OldLeads[0]?.count || 0,
      New: facetCounts[0].New[0]?.count || 0,
      TodayFollowup: facetCounts[0].TodayFollowup[0]?.count || 0,
      UpcomingFollowup: facetCounts[0].UpcomingFollowup[0]?.count || 0,
      Converted: facetCounts[0].Converted[0]?.count || 0,
      NotAttended: facetCounts[0].NotAttended[0]?.count || 0,
      Lost: facetCounts[0].Lost[0]?.count || 0,
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
  try {
    const {
      LeadModel,
      UserModel,
      AssignmentStateModel,
      NotificationModel,
    } = getModels(req);

    // Subscription expiry check
    if (req.organization?.subscriptionEndDate) {
      const isExpired =
        new Date() > new Date(req.organization.subscriptionEndDate);
      if (isExpired) {
        return res.status(403).json({
          success: false,
          subscriptionExpired: true,
          message: `Your organization's subscription expired on ${new Date(
            req.organization.subscriptionEndDate
          ).toLocaleDateString("en-IN")}. Please renew to create new leads.`,
        });
      }
    }

    const leadData = req.body || {};

    if (leadData.phone || leadData.email) {
      const rawPhone = leadData.phone ? String(leadData.phone).trim() : "";
      const cleanDigits = rawPhone.replace(/\D/g, "");
      const last10Digits =
        cleanDigits.length >= 10 ? cleanDigits.slice(-10) : cleanDigits;
      let normalizedPhone = cleanDigits;
      if (normalizedPhone.length > 10 && normalizedPhone.startsWith("91")) {
        normalizedPhone = normalizedPhone.substring(2);
      }

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
        const existingLead = await LeadModel.findOne({ $or: orConditions });
        if (existingLead) {
          return res.status(400).json({
            success: false,
            message: "A lead with this phone number or email already exists.",
          });
        }
      }
    }

    if (!leadData.assignedTo || leadData.assignedTo === "Unassigned") {
      const reps = await UserModel.find({ role: "sales person" }).sort({
        _id: 1,
      });
      if (reps && reps.length > 0) {
        let state = await AssignmentStateModel.findOne({
          key: "leadAssignment",
        });
        if (!state) {
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
      }
    }
    if (!leadData.joinedAt) {
      leadData.joinedAt = new Date();
    }

    if (req.file) {
      const host = req.get("host");
      const basePath = "/uploads/";
      const fileUrl = `${req.protocol}://${host}${basePath}${req.file.filename}`;
      leadData.recordings = [
        {
          name: req.body.recordingName || req.file.originalname,
          url: fileUrl,
          uploadedAt: new Date(),
        },
      ];
    }

    const lead = await LeadModel.create(leadData);

    // Send automated WhatsApp welcome enquiry message for non-manual entry sources (Call, Email, etc.)
    if (lead.source && lead.source !== "Manual Entry") {
      const orgId = req.user?.organizationId || req.organization?._id || null;
      sendWelcomeEnquiryMessage(lead, {
        tenantModels: req.tenantModels,
        organizationId: orgId,
      }).catch((err) =>
        console.error("Error in sendWelcomeEnquiryMessage (createLead):", err),
      );
    }

    let assignedUserName = "sales representative";
    let targetUsers = [];
    if (lead.assignedTo && lead.assignedTo !== "Unassigned") {
      if (mongoose.Types.ObjectId.isValid(lead.assignedTo)) {
        targetUsers = [lead.assignedTo];
        const assignedUser = await UserModel.findById(lead.assignedTo).select("name");
        if (assignedUser) assignedUserName = assignedUser.name;
      } else {
        const assignedUser = await UserModel.findOne({ name: lead.assignedTo });
        if (assignedUser) {
          targetUsers = [assignedUser._id];
          assignedUserName = assignedUser.name;
        } else {
          assignedUserName = lead.assignedTo;
        }
      }
    }

    await NotificationModel.create({
      title: "New Lead Added",
      message: `Lead ${lead.name} has been added and assigned to ${assignedUserName}.`,
      type: "new_lead",
      targetRoles: ["sales manager"],
      targetUsers: targetUsers,
    });

    res.status(201).json({ success: true, data: lead });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const updateLead = async (req, res) => {
  try {
    const { LeadModel, NotificationModel } = getModels(req);
    const { id } = req.params;
    const updateData = req.body || {};

    const lead = await LeadModel.findById(id);

    if (!lead) {
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    }

    if (req.file) {
      const host = req.get("host");
      const basePath = "/uploads/";
      const fileUrl = `${req.protocol}://${host}${basePath}${req.file.filename}`;
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
    }

    lead.set(updateData);
    await lead.save();

    if (req.file && ENABLE_AI_AUDIO_ANALYSIS) {
      const newRecording = lead.recordings[lead.recordings.length - 1];
      if (newRecording) {
        const orgApiKey = decryptApiKey(req.organization?.aiSettings?.geminiApiKey);
        triggerAudioAnalysis(
          lead._id,
          newRecording._id,
          req.file.path,
          req.file.mimetype,
          LeadModel,
          orgApiKey,
          req.organization?._id || req.user?.organizationId,
        );
      }
    }

    if (updateData.status) {
      await NotificationModel.create({
        title: "Lead Status Updated",
        message: `Lead ${lead.name} status updated to ${lead.status}.`,
        type: "lead_update",
        targetRoles: ["sales manager"],
      });
    }

    // When a human user updates this lead, mark any pending AI follow-ups as handled/done
    try {
      const { FollowupModel } = getModels(req);
      await FollowupModel.updateMany(
        { leadId: id, author: "AI Agent", done: false },
        { $set: { done: true } }
      );
    } catch (fuErr) {
      console.warn("[leadController] Error marking pending AI follow-up as done:", fuErr.message);
    }

    res.json({ success: true, data: lead });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteLead = async (req, res) => {
  try {
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
      message: "AI Call Analysis is temporarily paused.",
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
      "audio/mp4",
      LeadModel,
      orgApiKey,
      orgId,
    );

    res.json({ success: true, message: "Analysis triggered successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Bulk imports leads from Excel (.xlsx, .xls) or CSV into Old Leads
 * @route   POST /api/leads/import-excel
 * @access  Protected / Tenant-scoped
 */
export const importExcelLeads = async (req, res) => {
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
