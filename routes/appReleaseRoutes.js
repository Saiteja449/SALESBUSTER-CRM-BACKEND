import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  uploadApk,
  getLatestApkInfo,
  downloadLatestApk,
  deleteApk,
} from "../controllers/appReleaseController.js";
import { verifySuperAdmin } from "../middleware/authMiddleware.js";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const apkDir = path.resolve(__dirname, "../uploads/apk");

if (!fs.existsSync(apkDir)) {
  fs.mkdirSync(apkDir, { recursive: true });
}

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    if (!fs.existsSync(apkDir)) {
      fs.mkdirSync(apkDir, { recursive: true });
    }
    cb(null, apkDir);
  },
  filename: function (req, file, cb) {
    const sanitized = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    cb(null, `${Date.now()}-${sanitized}`);
  },
});

// Multer File Filter: Strictly accept .apk files only
const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === ".apk") {
    return cb(null, true);
  }
  return cb(
    new Error(
      "Only .apk files are allowed. Please upload a valid Android application package (.apk)."
    ),
    false
  );
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB max size
});

// Middleware wrapper to handle Multer errors gracefully (e.g. file too large or wrong extension)
const handleApkUpload = (req, res, next) => {
  const uploadMiddleware = upload.single("file");
  uploadMiddleware(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          success: false,
          message: "File is too large. Maximum allowed size is 200 MB.",
        });
      }
      return res.status(400).json({
        success: false,
        message: `Multer upload error: ${err.message}`,
      });
    } else if (err) {
      return res.status(400).json({
        success: false,
        message: err.message || "Invalid file upload",
      });
    }
    next();
  });
};

// 1. Super Admin: Upload APK (automatically deletes and replaces previous APK)
router.post("/upload", verifySuperAdmin, handleApkUpload, uploadApk);

// 2. Public: Fetch latest APK version & metadata
router.get("/latest", getLatestApkInfo);

// 3. Public: Direct download latest APK binary
router.get("/download", downloadLatestApk);

// 4. Super Admin: Delete APK
router.delete("/", verifySuperAdmin, deleteApk);

export default router;
