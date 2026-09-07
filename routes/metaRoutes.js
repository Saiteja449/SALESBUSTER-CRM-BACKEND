import express from "express";
import {
  verifyMetaWebhook,
  receiveMetaWebhook,
} from "../controllers/metaController.js";

const router = express.Router();

router.get("/webhook", verifyMetaWebhook);
router.post("/webhook", receiveMetaWebhook);

export default router;
