import { getMasterModels } from "../services/tenantManager.js";
import path from "path";
import fs from "fs";

export const DEFAULT_GUIDE_CONFIG = {
  key: "default_tour",
  title: "Create Your Event First",
  subtitle:
    "Group your leads by expo, conference, or roadshow. Pre-load your marketing collateral and welcome messages.",
  videoUrl: "",
  bannerImageUrl: "",
  fallbackBg: "#0B0A1F",
  isActive: true,
  stepIndex: 0,
  steps: [],
  updatedBy: "Super Admin",
};

/**
 * Public: Get active app guide video configuration (for Mobile App & Web)
 * GET /api/app-guide-video
 */
export const getPublicAppGuideVideo = async (req, res) => {
  try {
    const { AppGuideVideo } = getMasterModels();
    let config = await AppGuideVideo.findOne({ key: "default_tour" }).lean();

    if (!config) {
      config = await AppGuideVideo.create(DEFAULT_GUIDE_CONFIG);
    }

    return res.status(200).json({
      success: true,
      data: config,
    });
  } catch (error) {
    console.error("[AppGuideVideo] getPublicAppGuideVideo error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch guide video config.",
      data: DEFAULT_GUIDE_CONFIG,
    });
  }
};

/**
 * Super Admin: Get current guide video configuration
 * GET /api/app-guide-video/admin
 */
export const getAdminAppGuideVideo = async (req, res) => {
  try {
    const { AppGuideVideo } = getMasterModels();
    let config = await AppGuideVideo.findOne({ key: "default_tour" }).lean();

    if (!config) {
      config = await AppGuideVideo.create(DEFAULT_GUIDE_CONFIG);
    }

    return res.status(200).json({
      success: true,
      data: config,
    });
  } catch (error) {
    console.error("[AppGuideVideo] getAdminAppGuideVideo error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch guide video configuration.",
    });
  }
};

/**
 * Super Admin: Update guide video configuration (Supports file upload or URL)
 * PUT /api/app-guide-video/admin
 */
export const updateAppGuideVideo = async (req, res) => {
  try {
    const { AppGuideVideo } = getMasterModels();
    let config = await AppGuideVideo.findOne({ key: "default_tour" });

    if (!config) {
      config = new AppGuideVideo(DEFAULT_GUIDE_CONFIG);
    }

    const {
      title,
      subtitle,
      videoUrl: directVideoUrl,
      bannerImageUrl: directBannerUrl,
      fallbackBg,
      isActive,
      stepIndex,
      steps,
    } = req.body;

    // 1. Resolve uploaded banner/poster image if provided
    const bannerFile =
      req.bannerFile ||
      req.files?.bannerImage?.[0] ||
      req.files?.banner?.[0] ||
      (req.file?.mimetype?.startsWith("image/") ? req.file : null);

    if (bannerFile) {
      config.bannerImageUrl = `/uploads/videos/${bannerFile.filename}`;
    } else if (directBannerUrl !== undefined) {
      config.bannerImageUrl = directBannerUrl.trim();
    }

    // 2. Resolve uploaded video file if provided
    const videoFile =
      req.videoFile ||
      req.files?.video?.[0] ||
      (req.files?.media?.[0]?.mimetype?.startsWith("video/") ? req.files?.media?.[0] : null) ||
      (req.file?.mimetype?.startsWith("video/") ? req.file : null);

    if (videoFile) {
      config.videoUrl = `/uploads/videos/${videoFile.filename}`;
    } else if (directVideoUrl !== undefined) {
      config.videoUrl = directVideoUrl.trim();
    }

    if (title !== undefined) config.title = title.trim();
    if (subtitle !== undefined) config.subtitle = subtitle.trim();
    if (fallbackBg !== undefined) config.fallbackBg = fallbackBg.trim();
    if (stepIndex !== undefined) config.stepIndex = Number(stepIndex) || 0;
    if (isActive !== undefined) {
      config.isActive = isActive === true || isActive === "true";
    }

    if (steps !== undefined) {
      if (Array.isArray(steps)) {
        config.steps = steps;
      } else if (typeof steps === "string") {
        try {
          const parsed = JSON.parse(steps);
          if (Array.isArray(parsed)) config.steps = parsed;
        } catch (_) {}
      }
    }

    config.updatedBy = req.user?.name || req.user?.email || "Super Admin";

    await config.save();

    return res.status(200).json({
      success: true,
      message: "App guide video configuration updated successfully.",
      data: config,
    });
  } catch (error) {
    console.error("[AppGuideVideo] updateAppGuideVideo error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to update guide video configuration.",
    });
  }
};

/**
 * Super Admin: Delete/Reset guide video
 * DELETE /api/app-guide-video/admin/video
 */
export const deleteAppGuideVideo = async (req, res) => {
  try {
    const { AppGuideVideo } = getMasterModels();
    const config = await AppGuideVideo.findOne({ key: "default_tour" });

    if (!config) {
      return res.status(404).json({
        success: false,
        message: "Configuration not found.",
      });
    }

    // If local uploaded file exists, delete it safely
    if (config.videoUrl && config.videoUrl.startsWith("/uploads/")) {
      const filePath = path.resolve(process.cwd(), config.videoUrl.replace(/^\//, ""));
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          console.warn("[AppGuideVideo] Could not delete video file from disk:", e.message);
        }
      }
    }

    config.videoUrl = "";
    config.updatedBy = req.user?.name || req.user?.email || "Super Admin";
    await config.save();

    return res.status(200).json({
      success: true,
      message: "Guide video removed and reset to default.",
      data: config,
    });
  } catch (error) {
    console.error("[AppGuideVideo] deleteAppGuideVideo error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to delete guide video.",
    });
  }
};
