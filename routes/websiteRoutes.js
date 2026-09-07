import express from "express";
import { receiveWebsiteLead } from "../controllers/websiteController.js";

const router = express.Router();

router.post("/lead", receiveWebsiteLead);

export default router;
