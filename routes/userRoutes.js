import express from "express";
import {
  getUsers,
  addSalesPerson,
  deleteSalesPerson,
} from "../controllers/userController.js";

const router = express.Router();

router.route("/").get(getUsers).post(addSalesPerson);

router.route("/:id").delete(deleteSalesPerson);

export default router;
