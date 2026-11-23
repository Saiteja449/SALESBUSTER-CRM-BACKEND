import { NotFoundError } from "../../utils/AppError.js";

/**
 * Pure business logic for the module.
 * Receives tenant models and inputs, decoupled from Express req/res.
 */
export const listItemsService = async ({ tenantModels, filter = {}, page = 1, limit = 10 }) => {
  // Example query using tenant-scoped model
  const Model = tenantModels.Lead || tenantModels.Item;
  if (!Model) return { items: [], total: 0 };

  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    Model.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Model.countDocuments(filter),
  ]);

  return { items, total };
};

export const createItemService = async ({ tenantModels, itemData, creatorId }) => {
  const Model = tenantModels.Lead || tenantModels.Item;
  const created = await Model.create({
    ...itemData,
    createdBy: creatorId,
  });

  return created;
};

export const getItemByIdService = async ({ tenantModels, id }) => {
  const Model = tenantModels.Lead || tenantModels.Item;
  const item = await Model.findById(id).lean();
  if (!item) {
    throw new NotFoundError(`Item with ID ${id} not found.`);
  }

  return item;
};
