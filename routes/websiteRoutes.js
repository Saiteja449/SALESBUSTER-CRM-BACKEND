import express from "express";
import { receiveWebsiteLead } from "../controllers/websiteController.js";

const router = express.Router();

router.post("/lead", receiveWebsiteLead);
router.post("/:orgId/lead", receiveWebsiteLead);
router.post("/lead/:orgId", receiveWebsiteLead);

export default router;
