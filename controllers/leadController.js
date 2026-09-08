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
    const analysis = await analyzeAudioFile(filePath, mimeType);
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
        triggerAudioAnalysis(
          lead._id,
          newRecording._id,
          req.file.path,
          req.file.mimetype,
          LeadModel,
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
    triggerAudioAnalysis(id, recordingId, filePath, "audio/mp4", LeadModel);

    res.json({ success: true, message: "Analysis triggered successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
