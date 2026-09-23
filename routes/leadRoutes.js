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
  uploadRecordingForLead,
  importExcelLeads,
} from "../controllers/leadController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

const uploadDir = "uploads/";
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // Sanitize the filename to remove spaces and special characters that cause % encoding issues
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    cb(null, Date.now() + "-" + sanitizedName);
  },
});

// Multer instance for audio recording uploads (25MB limit + audio MIME filter)
const recordingMulter = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
  fileFilter: (req, file, cb) => {
    const isAudioMime = file.mimetype && file.mimetype.startsWith("audio/");
    const isAudioExt = /\.(mp3|wav|m4a|ogg|webm|aac|flac|mp4|opus)$/i.test(
      file.originalname
    );
    if (isAudioMime || isAudioExt) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only audio recordings are permitted."));
    }
  },
});

// Multer instance for Excel / CSV lead imports (10MB limit + spreadsheet MIME filter)
const excelMulter = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    const allowedExtensions = /\.(xlsx|xls|csv)$/i.test(file.originalname);
    const allowedMimes = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "text/csv",
      "application/csv",
      "text/plain",
      "application/octet-stream",
    ];
    if (allowedExtensions || allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only .xlsx, .xls, and .csv files are permitted."));
    }
  },
});

// Middleware wrappers to handle multer validation and limit errors cleanly (400 Bad Request)
const handleRecordingUpload = (req, res, next) => {
  recordingMulter.single("recording")(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next();
  });
};

const handleExcelUpload = (req, res, next) => {
  excelMulter.single("file")(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next();
  });
};

// 1. Bulk import (Protected)
router.post("/import-excel", protect, handleExcelUpload, importExcelLeads);

// 2. Leads listing & creation (Protected)
router
  .route("/")
  .get(protect, getLeads)
  .post(protect, handleRecordingUpload, createLead);

// 3. Paginated leads (Protected)
router.route("/paginated").get(protect, getPaginatedLeads);

// 4. External status webhook (Public integration endpoint, protected by secret verification)
router.post("/webhook/status", updateStatusByWebhook);

// 5. Individual lead management & recording operations (Protected)
router
  .route("/:id")
  .put(protect, handleRecordingUpload, updateLead)
  .delete(protect, deleteLead);

router.post(
  "/:id/recordings",
  protect,
  handleRecordingUpload,
  uploadRecordingForLead
);

router.post("/:id/analyze-recording/:recordingId", protect, analyzeRecording);

export default router;
