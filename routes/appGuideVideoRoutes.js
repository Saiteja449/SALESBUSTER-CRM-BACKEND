import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import {
  getPublicAppGuideVideo,
  getAdminAppGuideVideo,
  updateAppGuideVideo,
  deleteAppGuideVideo,
} from "../controllers/appGuideVideoController.js";
import { verifySuperAdmin } from "../middleware/authMiddleware.js";

const router = express.Router();

// Multer storage for app guide video and poster uploads
const videoUploadDir = path.resolve(process.cwd(), "uploads", "videos");
if (!fs.existsSync(videoUploadDir)) {
  fs.mkdirSync(videoUploadDir, { recursive: true });
}

const videoStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    if (!fs.existsSync(videoUploadDir)) {
      fs.mkdirSync(videoUploadDir, { recursive: true });
    }
    cb(null, videoUploadDir);
  },
  filename: function (req, file, cb) {
    const sanitized = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    cb(null, `guide_${Date.now()}_${sanitized}`);
  },
});

const upload = multer({
  storage: videoStorage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/")) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Only video (MP4, WEBM, MOV) and image files (JPG, PNG, WEBP) are allowed."
        ),
        false
      );
    }
  },
});

const uploadFields = upload.fields([
  { name: "video", maxCount: 1 },
  { name: "media", maxCount: 1 },
  { name: "file", maxCount: 1 },
  { name: "bannerImage", maxCount: 1 },
  { name: "banner", maxCount: 1 },
  { name: "poster", maxCount: 1 },
  { name: "image", maxCount: 1 },
]);

const handleUploadMiddleware = (req, res, next) => {
  uploadFields(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({
          success: false,
          message: `Upload error: ${err.message}`,
        });
      }
      return res.status(400).json({
        success: false,
        message: err.message || "Failed to process uploaded file.",
      });
    }

    if (req.files) {
      req.bannerFile =
        req.files?.bannerImage?.[0] ||
        req.files?.banner?.[0] ||
        req.files?.poster?.[0] ||
        req.files?.image?.[0] ||
        null;

      req.videoFile =
        req.files?.video?.[0] ||
        (req.files?.media?.[0]?.mimetype?.startsWith("video/")
          ? req.files?.media?.[0]
          : null) ||
        (req.files?.file?.[0]?.mimetype?.startsWith("video/")
          ? req.files?.file?.[0]
          : null) ||
        null;
    }
    next();
  });
};

// 1. Public route: Mobile app and web access
router.get("/", getPublicAppGuideVideo);

// 2. Protected routes: Super Admin configuration
router.get("/admin", verifySuperAdmin, getAdminAppGuideVideo);
router.put("/admin", verifySuperAdmin, handleUploadMiddleware, updateAppGuideVideo);
router.delete("/admin/video", verifySuperAdmin, deleteAppGuideVideo);

export default router;
