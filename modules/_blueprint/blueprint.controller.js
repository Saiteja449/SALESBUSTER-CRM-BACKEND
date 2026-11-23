import { asyncHandler } from "../../utils/asyncHandler.js";
import { getTenantScope } from "../../utils/tenantScope.js";
import { sendSuccess, sendPaginated } from "../../utils/responseHandler.js";
import {
  listItemsService,
  createItemService,
  getItemByIdService,
} from "./blueprint.service.js";

/**
 * Controller handlers: extracts validated scope, calls service, sends response.
 */
export const listItems = asyncHandler(async (req, res) => {
  const { tenantModels } = getTenantScope(req);
  const { page, limit, search, status } = req.query;

  const filter = {};
  if (status) filter.status = status;
  if (search) filter.name = { $regex: search, $options: "i" };

  const { items, total } = await listItemsService({
    tenantModels,
    filter,
    page: Number(page) || 1,
    limit: Number(limit) || 10,
  });

  return sendPaginated(res, {
    data: items,
    total,
    page,
    limit,
    message: "Items retrieved successfully.",
  });
});

export const createItem = asyncHandler(async (req, res) => {
  const { tenantModels, userId } = getTenantScope(req);

  const item = await createItemService({
    tenantModels,
    itemData: req.body,
    creatorId: userId,
  });

  return sendSuccess(res, {
    statusCode: 201,
    data: item,
    message: "Item created successfully.",
  });
});

export const getItemById = asyncHandler(async (req, res) => {
  const { tenantModels } = getTenantScope(req);
  const { id } = req.params;

  const item = await getItemByIdService({ tenantModels, id });

  return sendSuccess(res, {
    data: item,
    message: "Item retrieved successfully.",
  });
});
