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

const getManagedMediaPath = (mediaUrl) => {
  if (typeof mediaUrl !== "string" || !mediaUrl.startsWith("/uploads/videos/")) {
    return null;
  }
  const uploadRoot = path.resolve(process.cwd(), "uploads", "videos");
  const mediaPath = path.resolve(process.cwd(), mediaUrl.replace(/^\/+/, ""));
  const relativePath = path.relative(uploadRoot, mediaPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
  return mediaPath;
};

const removeManagedMedia = (mediaUrl) => {
  const mediaPath = getManagedMediaPath(mediaUrl);
  if (!mediaPath || !fs.existsSync(mediaPath)) return;
  try {
    fs.unlinkSync(mediaPath);
  } catch (error) {
    console.warn("[AppGuideVideo] Could not remove managed media:", error.message);
  }
};

const getStepVideoFiles = (files = {}) =>
  [0, 1, 2, 3].map((index) => files[`stepVideo_${index}`]?.[0] || null);

const getStepPosterFiles = (files = {}) =>
  [0, 1, 2, 3].map((index) => files[`stepPoster_${index}`]?.[0] || null);
const hasOwn = (object, property) =>
  Object.prototype.hasOwnProperty.call(object, property);

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
  const uploadedFiles = Object.values(req.files || {}).flat();
  const cleanupUploadedFiles = () => {
    uploadedFiles.forEach((file) => {
      if (file?.path) {
        removeManagedMedia(`/uploads/videos/${path.basename(file.path)}`);
      }
    });
  };
  try {
    const { AppGuideVideo } = getMasterModels();
    let config = await AppGuideVideo.findOne({ key: "default_tour" });

    if (!config) {
      config = new AppGuideVideo(DEFAULT_GUIDE_CONFIG);
    }
    const previousLegacyMediaUrls = [config.videoUrl, config.bannerImageUrl];
    const legacyVideoBeforeUpdate = config.videoUrl || "";

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

    const stepVideoFiles = getStepVideoFiles(req.files);
    const stepPosterFiles = getStepPosterFiles(req.files);
    const hasStepVideoUpload = stepVideoFiles.some(Boolean);
    const hasStepPosterUpload = stepPosterFiles.some(Boolean);
    const previousSteps = (config.steps || []).map((step) =>
      typeof step?.toObject === "function" ? step.toObject() : { ...step },
    );

    if (steps !== undefined || hasStepVideoUpload || hasStepPosterUpload) {
      let parsedSteps = steps === undefined ? previousSteps : steps;
      if (typeof steps === "string") {
        try {
          parsedSteps = JSON.parse(steps);
        } catch {
          cleanupUploadedFiles();
          return res.status(400).json({
            success: false,
            message: "The slide configuration must be valid JSON.",
          });
        }
      }
      if (!Array.isArray(parsedSteps)) {
        cleanupUploadedFiles();
        return res.status(400).json({
          success: false,
          message: "The slide configuration must be an array.",
        });
      }

      const incomingByIndex = new Map();
      for (const step of parsedSteps) {
        const index = Number(step?.stepIndex);
        if (!Number.isInteger(index) || index < 0 || index > 3) {
          cleanupUploadedFiles();
          return res.status(400).json({
            success: false,
            message: "Slide indexes must be between 0 and 3.",
          });
        }
        if (incomingByIndex.has(index)) {
          cleanupUploadedFiles();
          return res.status(400).json({
            success: false,
            message: `Slide ${index + 1} was included more than once.`,
          });
        }
        incomingByIndex.set(index, step);
      }

      const updatedSteps = [0, 1, 2, 3].map((index) => {
        const previous = previousSteps.find(
          (step) => Number(step.stepIndex) === index,
        ) || { stepIndex: index };
        const incoming = incomingByIndex.get(index);
        const next = { ...previous, ...(incoming || {}), stepIndex: index };
        const videoFile = stepVideoFiles[index];
        const posterFile = stepPosterFiles[index];

        if (videoFile) {
          next.videoUrl = `/uploads/videos/${videoFile.filename}`;
        } else if (incoming && hasOwn(incoming, "videoUrl")) {
          next.videoUrl = String(incoming.videoUrl || "").trim();
        }
        if (posterFile) {
          next.bannerImageUrl = `/uploads/videos/${posterFile.filename}`;
        } else if (incoming && hasOwn(incoming, "bannerImageUrl")) {
          next.bannerImageUrl = String(incoming.bannerImageUrl || "").trim();
        }
        return {
          stepIndex: index,
          badgeText: String(next.badgeText || "").trim(),
          title: String(next.title || "").trim(),
          subtitle: String(next.subtitle || "").trim(),
          videoUrl: String(next.videoUrl || "").trim(),
          bannerImageUrl: String(next.bannerImageUrl || "").trim(),
        };
      });

      config.steps = updatedSteps;

      // Keep the legacy single-video fields aligned with their slide while the
      // new four-video set is being configured for older app versions.
      const legacyStep = incomingByIndex.get(Number(config.stepIndex) || 0);
      const shouldMaintainLegacyAlias = Boolean(
        legacyVideoBeforeUpdate || String(directVideoUrl || "").trim(),
      );
      if (legacyStep && shouldMaintainLegacyAlias) {
        const legacyIndex = Number(config.stepIndex) || 0;
        const legacyUpdated = updatedSteps[legacyIndex];
        if (
          stepVideoFiles[legacyIndex] ||
          hasOwn(legacyStep, "videoUrl")
        ) {
          config.videoUrl = legacyUpdated.videoUrl;
        }
        if (
          stepPosterFiles[legacyIndex] ||
          hasOwn(legacyStep, "bannerImageUrl")
        ) {
          config.bannerImageUrl = legacyUpdated.bannerImageUrl;
        }
        if (legacyStep.title !== undefined) config.title = legacyUpdated.title;
        if (legacyStep.subtitle !== undefined)
          config.subtitle = legacyUpdated.subtitle;
      }

      const completeStepVideoSet = updatedSteps.every((step) => step.videoUrl);
      const requestedActive =
        isActive === undefined
          ? Boolean(config.isActive)
          : isActive === true || isActive === "true";
      const stepVideoConfigurationRequested =
        steps !== undefined || hasStepVideoUpload || hasStepPosterUpload;
      if (
        stepVideoConfigurationRequested &&
        requestedActive &&
        !completeStepVideoSet &&
        !config.videoUrl
      ) {
        cleanupUploadedFiles();
        return res.status(400).json({
          success: false,
          message: "Add a video to all four slides before enabling the guide.",
        });
      }
    }

    config.updatedBy = req.user?.name || req.user?.email || "Super Admin";

    await config.save();

    const referencedUrls = new Set([
      config.videoUrl,
      config.bannerImageUrl,
      ...(config.steps || []).flatMap((step) => [
        step.videoUrl,
        step.bannerImageUrl,
      ]),
    ]);
    const oldUrls = [
      ...previousLegacyMediaUrls,
      ...previousSteps.flatMap((step) => [step.videoUrl, step.bannerImageUrl]),
    ];
    for (const oldUrl of oldUrls) {
      if (oldUrl && !referencedUrls.has(oldUrl)) removeManagedMedia(oldUrl);
    }

    return res.status(200).json({
      success: true,
      message: "App guide video configuration updated successfully.",
      data: config,
    });
  } catch (error) {
    cleanupUploadedFiles();
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

    const videoIsStillUsedBySlide = (config.steps || []).some(
      (step) => step.videoUrl === config.videoUrl,
    );
    if (!videoIsStillUsedBySlide) removeManagedMedia(config.videoUrl);

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
