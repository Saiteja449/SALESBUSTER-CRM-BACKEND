import asyncHandler from "../utils/asyncHandler.js";
import { getTenantScope } from "../utils/tenantScope.js";
import { sendSuccess } from "../utils/responseHandler.js";
import {
  queryFollowupsService,
  createFollowupService,
  updateFollowupService,
  queryAIFollowupsService,
  handleAIFollowupService,
} from "../services/followupService.js";
import { getIO } from "../socket/socket.js";

/**
 * @desc    Get all followups (scoped by role and query filters)
 * @route   GET /api/followups
 * @access  Protected
 */
export const getFollowups = asyncHandler(async (req, res) => {
  const { tenantModels } = getTenantScope(req);
  const followups = await queryFollowupsService({
    tenantModels,
    user: req.user,
    query: req.query,
  });

  return sendSuccess(res, { data: followups });
});

/**
 * @desc    Create a followup
 * @route   POST /api/followups
 * @access  Protected
 */
export const createFollowup = asyncHandler(async (req, res) => {
  const { tenantModels, organizationId } = getTenantScope(req);
  const io = getIO();

  const createdFollowup = await createFollowupService({
    tenantModels,
    data: req.body,
    creatorUser: req.user,
    organizationId,
    io,
  });

  return sendSuccess(res, {
    statusCode: 201,
    data: createdFollowup,
    message: "Follow-up created successfully.",
  });
});

/**
 * @desc    Update a followup
 * @route   PUT /api/followups/:id
 * @access  Protected
 */
export const updateFollowup = asyncHandler(async (req, res) => {
  const { tenantModels } = getTenantScope(req);
  const updatedFollowup = await updateFollowupService({
    tenantModels,
    followupId: req.params.id,
    updateData: req.body,
  });

  return sendSuccess(res, {
    data: updatedFollowup,
    message: "Follow-up updated successfully.",
  });
});

/**
 * @desc    Get pending AI Follow-ups with joined Lead details
 * @route   GET /api/followups/ai
 * @access  Protected
 */
export const getAIFollowups = asyncHandler(async (req, res) => {
  const { tenantModels } = getTenantScope(req);
  const data = await queryAIFollowupsService({
    tenantModels,
    user: req.user,
    search: req.query?.search,
  });

  return res.json({
    success: true,
    count: data.length,
    data,
  });
});

/**
 * @desc    Mark an AI follow-up as handled
 * @route   PUT /api/followups/ai/:id/handle
 * @access  Protected
 */
export const handleAIFollowup = asyncHandler(async (req, res) => {
  const { tenantModels, organizationId } = getTenantScope(req);
  const io = getIO();

  const result = await handleAIFollowupService({
    tenantModels,
    followupId: req.params.id,
    handledBy: req.user?.name || "Representative",
    organizationId,
    io,
  });

  return sendSuccess(res, {
    data: result,
    message: "AI follow-up marked as handled successfully.",
  });
});

export default {
  getFollowups,
  createFollowup,
  updateFollowup,
  getAIFollowups,
  handleAIFollowup,
};
