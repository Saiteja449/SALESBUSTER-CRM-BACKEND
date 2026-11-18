import { getMasterModels } from "../services/tenantManager.js";
import path from "path";
import fs from "fs";

export const DEFAULT_SHOWCASE_SERVICES = [
  {
    serviceKey: "bi_analyst",
    title: "BI Analyst",
    tag: "Analytics",
    bannerImageUrl: "https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=400&q=80",
    videoUrl: "",
    fallbackBg: "#1A1838",
    description:
      "A dedicated BI Analyst that turns your raw numbers into clear, actionable insight — dashboards, KPIs and reports your whole team can trust.",
    features: [
      "Live dashboards & KPI tracking",
      "Automated daily / weekly reports",
      "Sales funnel & revenue insights",
    ],
    order: 1,
    isActive: true,
  },
  {
    serviceKey: "target_audience",
    title: "Target Audience",
    tag: "Growth",
    bannerImageUrl: "https://images.unsplash.com/photo-1533750349088-cd871a92f312?w=400&q=80",
    videoUrl: "",
    fallbackBg: "#2A1828",
    description:
      "Identify, segment and engage your high-value audience segments with precision-engineered data analytics and customer persona intelligence.",
    features: [
      "High-intent buyer segmentation",
      "Persona-based audience discovery",
      "Multi-channel conversion optimization",
    ],
    order: 2,
    isActive: true,
  },
  {
    serviceKey: "whatsapp_chat_automation",
    title: "WhatsApp Chat Automation",
    tag: "Cloud API",
    bannerImageUrl: "https://images.unsplash.com/photo-1611746872915-64382b5c76da?w=400&q=80",
    videoUrl: "",
    fallbackBg: "#132822",
    description:
      "Supercharge customer communication with intelligent WhatsApp chatbots that qualify leads, answer FAQs, and book meetings 24/7.",
    features: [
      "Instant automated inquiry replies",
      "Lead qualification & routing",
      "Official Meta Cloud API integration",
    ],
    order: 3,
    isActive: true,
  },
  {
    serviceKey: "whatsapp_campaigns",
    title: "WhatsApp Campaigns",
    tag: "Marketing",
    bannerImageUrl: "https://images.unsplash.com/photo-1563986768609-322da13575f3?w=400&q=80",
    videoUrl: "",
    fallbackBg: "#162338",
    description:
      "Launch high-conversion broadcast campaigns, promotional announcements, and event reminders with enterprise-grade deliverability.",
    features: [
      "Targeted broadcast messaging",
      "Automated opt-in & click tracking",
      "Rich media & interactive CTAs",
    ],
    order: 4,
    isActive: true,
  },
  {
    serviceKey: "followup_automation",
    title: "24/7 Follow-up Automation",
    tag: "Automation",
    bannerImageUrl: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=400&q=80",
    videoUrl: "",
    fallbackBg: "#181C38",
    description:
      "Never drop another hot lead. Instantly follow up across WhatsApp, SMS, and email the moment a prospect shows interest.",
    features: [
      "Multi-touch smart follow-up sequences",
      "AI response trigger detection",
      "Automated pipeline status updates",
    ],
    order: 5,
    isActive: true,
  },
  {
    serviceKey: "call_recording",
    title: "Call Recording & Call Log",
    tag: "Sales OPS",
    bannerImageUrl: "https://images.unsplash.com/photo-1512428559087-560fa5ceab42?w=400&q=80",
    videoUrl: "",
    fallbackBg: "#1F1A30",
    description:
      "Automatically record and transcribe client calls, analyze sales performance, and keep your CRM updated with zero manual work.",
    features: [
      "Background call recording & sync",
      "AI transcription & sentiment analysis",
      "Automatic CRM activity logging",
    ],
    order: 6,
    isActive: true,
  },
];

/**
 * Ensure default showcase services exist in the database
 */
const ensureSeededDefaults = async (ShowcaseService) => {
  try {
    const count = await ShowcaseService.countDocuments();
    if (count === 0) {
      await ShowcaseService.insertMany(DEFAULT_SHOWCASE_SERVICES);
      console.log("[ShowcaseService] Seeded 6 default platform services into master database.");
    }
  } catch (err) {
    console.warn("[ShowcaseService] Auto-seed error (non-fatal):", err.message);
  }
};

/**
 * Public: Get active showcase services for mobile app and web showcase
 * GET /api/showcase-services
 */
export const getPublicShowcaseServices = async (req, res) => {
  try {
    const { ShowcaseService } = getMasterModels();
    await ensureSeededDefaults(ShowcaseService);

    const services = await ShowcaseService.find({ isActive: true })
      .sort({ order: 1, createdAt: 1 })
      .lean();

    // Map to mobile app friendly format
    const formatted = services.map((s) => {
      const bannerImageUrl = s.bannerImageUrl || s.imageUrl || "";
      const videoUrl = s.videoUrl || "";
      const hasVideo = Boolean(videoUrl);

      return {
        _id: s._id,
        id: s.serviceKey,
        serviceKey: s.serviceKey,
        title: s.title,
        tag: s.tag,
        bannerImageUrl,
        videoUrl,
        hasVideo,
        fallbackBg: s.fallbackBg || "#1A1838",
        description: s.description,
        features: s.features || [],
        order: s.order || 0,
        isActive: s.isActive,
      };
    });

    return res.status(200).json({
      success: true,
      data: formatted,
    });
  } catch (error) {
    console.error("[ShowcaseService] getPublicShowcaseServices error:", error);
    return res.status(200).json({
      success: true,
      data: DEFAULT_SHOWCASE_SERVICES.map((s) => ({
        ...s,
        id: s.serviceKey,
        hasVideo: Boolean(s.videoUrl),
      })),
      fallback: true,
    });
  }
};

/**
 * Super Admin: Get all showcase services (active + inactive)
 * GET /api/showcase-services/admin/all
 */
export const getAdminShowcaseServices = async (req, res) => {
  try {
    const { ShowcaseService } = getMasterModels();
    await ensureSeededDefaults(ShowcaseService);

    const services = await ShowcaseService.find()
      .sort({ order: 1, createdAt: 1 })
      .lean();

    const formatted = services.map((s) => {
      const bannerImageUrl = s.bannerImageUrl || s.imageUrl || "";
      const videoUrl = s.videoUrl || "";
      const hasVideo = Boolean(videoUrl);

      return {
        ...s,
        bannerImageUrl,
        videoUrl,
        hasVideo,
      };
    });

    return res.status(200).json({
      success: true,
      data: formatted,
    });
  } catch (error) {
    console.error("[ShowcaseService] getAdminShowcaseServices error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch showcase services.",
    });
  }
};

/**
 * Super Admin: Create a new showcase service
 * POST /api/showcase-services
 */
export const createShowcaseService = async (req, res) => {
  try {
    const { ShowcaseService } = getMasterModels();
    const {
      serviceKey,
      title,
      tag = "General",
      fallbackBg = "#1A1838",
      description = "",
      features = [],
      order = 0,
      isActive = true,
      bannerImageUrl: directBannerUrl = "",
      imageUrl: directImageUrl = "",
      videoUrl: directVideoUrl = "",
      mediaUrl: directMediaUrl = "",
      mediaType: requestedMediaType = "",
    } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({
        success: false,
        message: "Service title is required.",
      });
    }

    // Auto-generate serviceKey if not provided
    const key = (serviceKey && serviceKey.trim())
      ? serviceKey.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_")
      : title.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);

    // Check duplicate key
    const existing = await ShowcaseService.findOne({ serviceKey: key });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: `A service with key '${key}' already exists. Please choose another identifier.`,
      });
    }

    // 1. Resolve Banner Image (from uploaded file or URL)
    const bannerFile =
      req.bannerFile ||
      req.files?.bannerImage?.[0] ||
      req.files?.banner?.[0] ||
      (req.file?.mimetype?.startsWith("image/") ? req.file : null);

    let finalBannerUrl = (directBannerUrl || directImageUrl || "").trim();
    if (bannerFile) {
      finalBannerUrl = `/uploads/services/${bannerFile.filename}`;
    }

    // 2. Resolve Video (from uploaded file or URL)
    const videoFile =
      req.videoFile ||
      req.files?.video?.[0] ||
      (req.files?.media?.[0]?.mimetype?.startsWith("video/") ? req.files?.media?.[0] : null) ||
      (req.file?.mimetype?.startsWith("video/") ? req.file : null);

    let finalVideoUrl = (directVideoUrl || "").trim();
    if (videoFile) {
      finalVideoUrl = `/uploads/services/${videoFile.filename}`;
    } else if (!finalVideoUrl && directMediaUrl) {
      const isVideo =
        requestedMediaType === "video" ||
        /\.(mp4|webm|mov|mkv|avi|m3u8)(\?.*)?$/i.test(directMediaUrl);
      if (isVideo) {
        finalVideoUrl = directMediaUrl.trim();
      }
    }

    // Parse features if passed as string (e.g. from FormData)
    let parsedFeatures = [];
    if (Array.isArray(features)) {
      parsedFeatures = features.filter((f) => typeof f === "string" && f.trim());
    } else if (typeof features === "string") {
      try {
        const parsed = JSON.parse(features);
        if (Array.isArray(parsed)) {
          parsedFeatures = parsed.filter((f) => typeof f === "string" && f.trim());
        } else {
          parsedFeatures = features.split("\n").map((f) => f.trim()).filter(Boolean);
        }
      } catch {
        parsedFeatures = features.split("\n").map((f) => f.trim()).filter(Boolean);
      }
    }

    const newService = await ShowcaseService.create({
      serviceKey: key,
      title: title.trim(),
      tag: (tag || "General").trim(),
      bannerImageUrl: finalBannerUrl,
      videoUrl: finalVideoUrl,
      fallbackBg: fallbackBg || "#1A1838",
      description: description ? description.trim() : "",
      features: parsedFeatures,
      order: parseInt(order, 10) || 0,
      isActive: isActive === true || isActive === "true",
      createdBy: req.user?._id || null,
      createdByName: req.user?.name || "Super Admin",
    });

    return res.status(201).json({
      success: true,
      message: "Showcase service created successfully.",
      data: newService,
    });
  } catch (error) {
    console.error("[ShowcaseService] createShowcaseService error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to create showcase service.",
    });
  }
};

/**
 * Super Admin: Update an existing showcase service
 * PUT /api/showcase-services/:id
 */
export const updateShowcaseService = async (req, res) => {
  try {
    const { ShowcaseService } = getMasterModels();
    const { id } = req.params;

    const service = await ShowcaseService.findById(id);
    if (!service) {
      return res.status(404).json({
        success: false,
        message: "Showcase service not found.",
      });
    }

    const {
      serviceKey,
      title,
      tag,
      fallbackBg,
      description,
      features,
      order,
      isActive,
      bannerImageUrl: directBannerUrl,
      imageUrl: directImageUrl,
      videoUrl: directVideoUrl,
      mediaUrl: directMediaUrl,
      mediaType: requestedMediaType,
    } = req.body;

    if (title !== undefined) service.title = title.trim();
    if (tag !== undefined) service.tag = tag.trim();
    if (fallbackBg !== undefined) service.fallbackBg = fallbackBg.trim();
    if (description !== undefined) service.description = description.trim();
    if (order !== undefined) service.order = parseInt(order, 10) || 0;
    if (isActive !== undefined) service.isActive = isActive === true || isActive === "true";

    if (serviceKey && serviceKey.trim()) {
      const sanitizedKey = serviceKey.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
      if (sanitizedKey !== service.serviceKey) {
        const duplicate = await ShowcaseService.findOne({ serviceKey: sanitizedKey, _id: { $ne: id } });
        if (duplicate) {
          return res.status(400).json({
            success: false,
            message: `A service with key '${sanitizedKey}' already exists.`,
          });
        }
        service.serviceKey = sanitizedKey;
      }
    }

    // 1. Resolve Banner Image Update
    const bannerFile =
      req.bannerFile ||
      req.files?.bannerImage?.[0] ||
      req.files?.banner?.[0] ||
      (req.file?.mimetype?.startsWith("image/") ? req.file : null);

    if (bannerFile) {
      if (service.bannerImageUrl && service.bannerImageUrl.startsWith("/uploads/services/")) {
        const oldPath = path.resolve(process.cwd(), "." + service.bannerImageUrl);
        if (fs.existsSync(oldPath)) {
          try {
            fs.unlinkSync(oldPath);
          } catch (e) {}
        }
      }
      service.bannerImageUrl = `/uploads/services/${bannerFile.filename}`;
    } else if (directBannerUrl !== undefined || directImageUrl !== undefined) {
      service.bannerImageUrl = (directBannerUrl !== undefined ? directBannerUrl : directImageUrl).trim();
    }

    // 2. Resolve Video Update
    const videoFile =
      req.videoFile ||
      req.files?.video?.[0] ||
      (req.files?.media?.[0]?.mimetype?.startsWith("video/") ? req.files?.media?.[0] : null) ||
      (req.file?.mimetype?.startsWith("video/") ? req.file : null);

    if (videoFile) {
      if (service.videoUrl && service.videoUrl.startsWith("/uploads/services/")) {
        const oldPath = path.resolve(process.cwd(), "." + service.videoUrl);
        if (fs.existsSync(oldPath)) {
          try {
            fs.unlinkSync(oldPath);
          } catch (e) {}
        }
      }
      service.videoUrl = `/uploads/services/${videoFile.filename}`;
    } else if (directVideoUrl !== undefined) {
      service.videoUrl = directVideoUrl.trim();
    } else if (directMediaUrl !== undefined && directVideoUrl === undefined && directBannerUrl === undefined) {
      const isVideo =
        requestedMediaType === "video" ||
        /\.(mp4|webm|mov|mkv|avi|m3u8)(\?.*)?$/i.test(directMediaUrl);
      if (isVideo) {
        service.videoUrl = directMediaUrl.trim();
      } else {
        service.bannerImageUrl = directMediaUrl.trim();
      }
    }

    // Parse features
    if (features !== undefined) {
      if (Array.isArray(features)) {
        service.features = features.filter((f) => typeof f === "string" && f.trim());
      } else if (typeof features === "string") {
        try {
          const parsed = JSON.parse(features);
          if (Array.isArray(parsed)) {
            service.features = parsed.filter((f) => typeof f === "string" && f.trim());
          } else {
            service.features = features.split("\n").map((f) => f.trim()).filter(Boolean);
          }
        } catch {
          service.features = features.split("\n").map((f) => f.trim()).filter(Boolean);
        }
      }
    }

    await service.save();

    return res.status(200).json({
      success: true,
      message: "Showcase service updated successfully.",
      data: service,
    });
  } catch (error) {
    console.error("[ShowcaseService] updateShowcaseService error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to update showcase service.",
    });
  }
};

/**
 * Super Admin: Delete a showcase service
 * DELETE /api/showcase-services/:id
 */
export const deleteShowcaseService = async (req, res) => {
  try {
    const { ShowcaseService } = getMasterModels();
    const { id } = req.params;

    const service = await ShowcaseService.findById(id);
    if (!service) {
      return res.status(404).json({
        success: false,
        message: "Showcase service not found.",
      });
    }

    // Delete media from disk if local upload
    const filesToDelete = [
      service.bannerImageUrl,
      service.videoUrl,
    ].filter((p) => p && p.startsWith("/uploads/services/"));

    const uniqueFiles = [...new Set(filesToDelete)];
    for (const fileRel of uniqueFiles) {
      const oldPath = path.resolve(process.cwd(), "." + fileRel);
      if (fs.existsSync(oldPath)) {
        try {
          fs.unlinkSync(oldPath);
        } catch (e) {}
      }
    }

    await ShowcaseService.findByIdAndDelete(id);

    return res.status(200).json({
      success: true,
      message: "Showcase service deleted successfully.",
    });
  } catch (error) {
    console.error("[ShowcaseService] deleteShowcaseService error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to delete showcase service.",
    });
  }
};

/**
 * Super Admin: Standalone media upload helper (supports images & videos)
 * POST /api/showcase-services/upload-image
 * POST /api/showcase-services/upload-media
 */
export const uploadShowcaseImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No image or video file provided.",
      });
    }

    const isVideo = req.file.mimetype?.startsWith("video/");
    const relativeUrl = `/uploads/services/${req.file.filename}`;
    const fullUrl = `${req.protocol}://${req.get("host")}${relativeUrl}`;

    return res.status(200).json({
      success: true,
      url: relativeUrl,
      mediaUrl: relativeUrl,
      imageUrl: relativeUrl,
      mediaType: isVideo ? "video" : "image",
      fullUrl,
      fileName: req.file.filename,
    });
  } catch (error) {
    console.error("[ShowcaseService] uploadShowcaseImage error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to upload media.",
    });
  }
};

