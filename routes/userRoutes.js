import express from "express";
import {
  getUsers,
  addSalesPerson,
  deleteSalesPerson,
} from "../controllers/userController.js";
import { protect, requireCrmAccount } from "../middleware/authMiddleware.js";
import { enforceTrialLimits } from "../middleware/trialLimitMiddleware.js";

const router = express.Router();

router.use(protect);
router.use(requireCrmAccount);

router.route("/").get(protect, getUsers).post(protect, enforceTrialLimits("seats"), addSalesPerson);

router.route("/:id").delete(protect, deleteSalesPerson);

export default router;
