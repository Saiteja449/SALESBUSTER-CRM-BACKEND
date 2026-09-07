import express from "express";
import { receiveMobileAppLead } from "../controllers/mobileAppController.js";

const router = express.Router();

router.post("/webhook", receiveMobileAppLead);

export default router;
