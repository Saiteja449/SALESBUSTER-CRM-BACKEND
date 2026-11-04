import express from "express";
import {
  getUsers,
  addSalesPerson,
  deleteSalesPerson,
} from "../controllers/userController.js";
import { protect, requireCrmAccount } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(protect);
router.use(requireCrmAccount);

router.route("/").get(protect, getUsers).post(protect, addSalesPerson);

router.route("/:id").delete(protect, deleteSalesPerson);

export default router;
