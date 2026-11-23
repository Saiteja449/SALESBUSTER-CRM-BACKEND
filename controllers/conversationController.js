import asyncHandler from "../utils/asyncHandler.js";
import { getTenantScope } from "../utils/tenantScope.js";
import { sendSuccess, sendPaginated } from "../utils/responseHandler.js";
import {
  queryCapturedConversationsService,
  getConversationByIdService,
  confirmConversationContactService,
} from "../services/conversationService.js";

/**
 * List captured conversations for authenticated user / tenant.
 * @route GET /api/conversations
 */
export const getConversations = asyncHandler(async (req, res) => {
  const { tenantModels, organizationId } = getTenantScope(req);
  const result = await queryCapturedConversationsService({
    tenantModels,
    user: req.user,
    organizationId,
    query: req.query,
  });

  return sendPaginated(res, {
    data: result.conversations,
    total: result.total,
    page: result.page,
    limit: result.limit,
  });
});

/**
 * Get single conversation record by sessionId or ID.
 * @route GET /api/conversations/:id
 */
export const getConversationById = asyncHandler(async (req, res) => {
  const { tenantModels } = getTenantScope(req);
  const conversation = await getConversationByIdService({
    tenantModels,
    id: req.params.id,
  });

  return sendSuccess(res, { data: conversation });
});

/**
 * User review and confirmation of extracted contact details.
 * @route POST /api/conversations/:id/confirm
 */
export const confirmContact = asyncHandler(async (req, res) => {
  const { tenantModels } = getTenantScope(req);
  const result = await confirmConversationContactService({
    tenantModels,
    id: req.params.id,
    contactData: req.body,
    user: req.user,
  });

  return sendSuccess(res, {
    data: result,
    message: "Contact confirmed and verified successfully.",
  });
});

export default {
  getConversations,
  getConversationById,
  confirmContact,
};
