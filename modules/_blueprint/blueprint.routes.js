import express from "express";
import { protect, requireCrmAccount } from "../../middleware/authMiddleware.js";
import { validateRequest } from "../../middleware/validateRequest.js";
import {
  createItemSchema,
  updateItemSchema,
  queryItemsSchema,
} from "./blueprint.schema.js";
import {
  listItems,
  createItem,
  getItemById,
} from "./blueprint.controller.js";

const router = express.Router();

// All module routes are authenticated and scoped to active CRM tenant
router.use(protect, requireCrmAccount);

router
  .route("/")
  .get(validateRequest(queryItemsSchema), listItems)
  .post(validateRequest(createItemSchema), createItem);

router.route("/:id").get(validateRequest(updateItemSchema), getItemById);

export default router;
