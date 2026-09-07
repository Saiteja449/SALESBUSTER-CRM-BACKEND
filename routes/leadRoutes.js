import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import {
  getLeads,
  getPaginatedLeads,
  createLead,
  updateLead,
  deleteLead,
  updateStatusByWebhook,
  analyzeRecording,
} from "../controllers/leadController.js";

const router = express.Router();

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = "uploads/";
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // Sanitize the filename to remove spaces and special characters that cause % encoding issues
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, Date.now() + "-" + sanitizedName);
  },
});
const upload = multer({ storage: storage });

router.route("/").get(getLeads).post(upload.single("recording"), createLead);
router.route("/paginated").get(getPaginatedLeads);

router.post("/webhook/status", updateStatusByWebhook);

router.route("/:id").put(upload.single("recording"), updateLead).delete(deleteLead);
router.post("/:id/analyze-recording/:recordingId", analyzeRecording);

export default router;
