import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import {
  getPublicShowcaseServices,
  getAdminShowcaseServices,
  createShowcaseService,
  updateShowcaseService,
  deleteShowcaseService,
  uploadShowcaseImage,
} from "../controllers/showcaseServiceController.js";
import { verifySuperAdmin } from "../middleware/authMiddleware.js";

const router = express.Router();

// Multer storage for service showcase images
const serviceUploadDir = path.resolve(process.cwd(), "uploads", "services");
if (!fs.existsSync(serviceUploadDir)) {
  fs.mkdirSync(serviceUploadDir, { recursive: true });
}

const serviceStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    if (!fs.existsSync(serviceUploadDir)) {
      fs.mkdirSync(serviceUploadDir, { recursive: true });
    }
    cb(null, serviceUploadDir);
  },
  filename: function (req, file, cb) {
    const sanitized = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    cb(null, `showcase_${Date.now()}_${sanitized}`);
  },
});

const serviceUpload = multer({
  storage: serviceStorage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files (JPG, PNG, WEBP, GIF, SVG) are allowed!"), false);
    }
  },
});

const handleImageUpload = (req, res, next) => {
  serviceUpload.single("image")(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({
          success: false,
          message: `Image upload error: ${err.message}`,
        });
      }
      return res.status(400).json({
        success: false,
        message: err.message || "Failed to upload image.",
      });
    }
    next();
  });
};

// 1. Public: Active showcase services (for mobile app & web)
router.get("/", getPublicShowcaseServices);

// 2. Super Admin: List all showcase services (active + inactive)
router.get("/admin/all", verifySuperAdmin, getAdminShowcaseServices);

// 3. Super Admin: Standalone image upload helper
router.post("/upload-image", verifySuperAdmin, handleImageUpload, uploadShowcaseImage);

// 4. Super Admin: Create new showcase service
router.post("/", verifySuperAdmin, handleImageUpload, createShowcaseService);

// 5. Super Admin: Update showcase service
router.put("/:id", verifySuperAdmin, handleImageUpload, updateShowcaseService);

// 6. Super Admin: Delete showcase service
router.delete("/:id", verifySuperAdmin, deleteShowcaseService);

export default router;

