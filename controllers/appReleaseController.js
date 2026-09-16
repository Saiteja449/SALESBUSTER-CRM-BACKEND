import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getMasterModels } from "../services/tenantManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const apkStorageDir = path.resolve(__dirname, "../uploads/apk");

/**
 * Format bytes into human readable string (e.g. 42.5 MB)
 */
const formatBytes = (bytes, decimals = 2) => {
  if (!bytes || bytes === 0) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

// @desc    Upload a new mobile APK and automatically replace the previous one
// @route   POST /api/app-release/upload
// @route   POST /api/mobile-app/apk/upload
// @access  Protected (Super Admin)
export const uploadApk = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No APK file uploaded. Please attach an '.apk' file under key 'file' or 'apk'.",
      });
    }

    const { version, versionCode, minSupportedVersion, releaseNotes } = req.body;
    const { AppRelease } = getMasterModels();

    // 1. Find all previous APK records in DB
    const previousReleases = await AppRelease.find();

    // 2. Automatically delete the previous APK file(s) from disk
    for (const prev of previousReleases) {
      if (prev.filePath && fs.existsSync(prev.filePath)) {
        try {
          fs.unlinkSync(prev.filePath);
          console.log(`[APK Release] Deleted previous APK file: ${prev.filePath}`);
        } catch (unlinkErr) {
          console.warn(`[APK Release] Could not delete old file ${prev.filePath}:`, unlinkErr.message);
        }
      }
    }

    // Also clean up any older orphaned .apk files in uploads/apk/ except the newly uploaded file
    try {
      if (fs.existsSync(apkStorageDir)) {
        const files = fs.readdirSync(apkStorageDir);
        for (const f of files) {
          if (f !== req.file.filename && f.toLowerCase().endsWith(".apk")) {
            const orphanPath = path.join(apkStorageDir, f);
            try {
              fs.unlinkSync(orphanPath);
              console.log(`[APK Release] Purged orphaned APK file: ${orphanPath}`);
            } catch (e) {}
          }
        }
      }
    } catch (cleanupErr) {
      console.warn("[APK Release] Orphan directory scan warning:", cleanupErr.message);
    }

    // 3. Purge existing records from DB so only 1 active release is stored
    await AppRelease.deleteMany({});

    // 4. Save new APK release record
    const relativeUrl = `/uploads/apk/${req.file.filename}`;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const parsedVersionCode = versionCode ? parseInt(versionCode, 10) : 1;

    const newRelease = await AppRelease.create({
      fileName: req.file.filename,
      originalName: req.file.originalname || "salesbuster-crm.apk",
      filePath: req.file.path,
      fileUrl: relativeUrl,
      fileSize: req.file.size,
      version: (version || "1.0.0").trim(),
      versionCode: isNaN(parsedVersionCode) ? 1 : parsedVersionCode,
      minSupportedVersion: (minSupportedVersion || version || "1.0.0").trim(),
      releaseNotes: releaseNotes || "",
      mimeType: req.file.mimetype || "application/vnd.android.package-archive",
      uploadedBy: req.user?._id || null,
      uploadedByName: req.user?.name || "Super Admin",
    });

    res.status(201).json({
      success: true,
      message: `New APK (version ${newRelease.version}) uploaded successfully. Previous APK has been replaced.`,
      data: {
        _id: newRelease._id,
        version: newRelease.version,
        versionCode: newRelease.versionCode,
        minSupportedVersion: newRelease.minSupportedVersion,
        releaseNotes: newRelease.releaseNotes,
        originalName: newRelease.originalName,
        fileName: newRelease.fileName,
        fileSize: newRelease.fileSize,
        fileSizeFormatted: formatBytes(newRelease.fileSize),
        downloadUrl: `${baseUrl}/api/mobile-app/apk/download`,
        fileUrl: `${baseUrl}${relativeUrl}`,
        uploadedByName: newRelease.uploadedByName,
        uploadedAt: newRelease.createdAt,
      },
    });
  } catch (error) {
    console.error("Error uploading APK release:", error);
    // If upload failed, clean up the newly saved file
    if (req.file?.path && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
    }
    res.status(500).json({
      success: false,
      message: error.message || "Server error while processing APK upload",
    });
  }
};

// @desc    Get metadata and version of the latest uploaded APK
// @route   GET /api/app-release/latest
// @route   GET /api/mobile-app/apk/latest
// @access  Public
export const getLatestApkInfo = async (req, res) => {
  try {
    const { AppRelease } = getMasterModels();
    const release = await AppRelease.findOne().sort({ createdAt: -1 });

    if (!release) {
      return res.status(404).json({
        success: false,
        message: "No APK release has been uploaded yet.",
      });
    }

    // Verify file still exists on disk
    if (!fs.existsSync(release.filePath)) {
      return res.status(404).json({
        success: false,
        message: "APK file not found on disk. Please upload a new release.",
      });
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;

    res.status(200).json({
      success: true,
      data: {
        _id: release._id,
        version: release.version,
        versionCode: release.versionCode,
        minSupportedVersion: release.minSupportedVersion,
        releaseNotes: release.releaseNotes,
        originalName: release.originalName,
        fileName: release.fileName,
        fileSize: release.fileSize,
        fileSizeFormatted: formatBytes(release.fileSize),
        downloadUrl: `${baseUrl}/api/mobile-app/apk/download`,
        fileUrl: `${baseUrl}${release.fileUrl}`,
        uploadedByName: release.uploadedByName,
        uploadedAt: release.createdAt,
      },
    });
  } catch (error) {
    console.error("Error fetching latest APK info:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching APK details",
    });
  }
};

// @desc    Direct download endpoint for latest mobile APK
// @route   GET /api/app-release/download
// @route   GET /api/mobile-app/apk/download
// @access  Public
export const downloadLatestApk = async (req, res) => {
  try {
    const { AppRelease } = getMasterModels();
    const release = await AppRelease.findOne().sort({ createdAt: -1 });

    if (!release || !release.filePath || !fs.existsSync(release.filePath)) {
      return res.status(404).json({
        success: false,
        message: "No APK release is currently available for download. Please contact administrator.",
      });
    }

    const downloadFileName = release.originalName?.endsWith(".apk")
      ? release.originalName
      : `salesbuster-v${release.version || "latest"}.apk`;

    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    return res.download(release.filePath, downloadFileName);
  } catch (error) {
    console.error("Error downloading APK:", error);
    res.status(500).json({
      success: false,
      message: "Server error while downloading APK file",
    });
  }
};

// @desc    Delete the active APK release and purge file from disk
// @route   DELETE /api/app-release
// @route   DELETE /api/mobile-app/apk
// @access  Protected (Super Admin)
export const deleteApk = async (req, res) => {
  try {
    const { AppRelease } = getMasterModels();
    const releases = await AppRelease.find();

    for (const r of releases) {
      if (r.filePath && fs.existsSync(r.filePath)) {
        try {
          fs.unlinkSync(r.filePath);
        } catch (e) {}
      }
    }

    await AppRelease.deleteMany({});

    res.status(200).json({
      success: true,
      message: "Active APK release deleted successfully.",
    });
  } catch (error) {
    console.error("Error deleting APK:", error);
    res.status(500).json({
      success: false,
      message: "Server error while deleting APK release",
    });
  }
};
