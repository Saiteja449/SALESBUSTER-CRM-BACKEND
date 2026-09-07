import express from "express";
import {
  getUsers,
  addSalesPerson,
  deleteSalesPerson,
} from "../controllers/userController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

router.route("/").get(protect, getUsers).post(protect, addSalesPerson);

router.route("/:id").delete(protect, deleteSalesPerson);

export default router;
