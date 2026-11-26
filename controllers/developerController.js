import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { getMasterModels } from "../services/tenantManager.js";
import { recordApiActivityLog } from "../services/telemetryService.js";

/**
 * GET /api/developer/overview
 * Summary telemetry for the Developer Console.
 */
export const getDeveloperOverview = async (req, res) => {
  try {
    const { ApiActivityLog, UserSession, AuthUser } = getMasterModels();
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      totalLogs24h,
      errorCount24h,
      warningCount24h,
      crashCount24h,
      activeWebSessions,
      activeMobileSessions,
      developerCount,
    ] = await Promise.all([
      ApiActivityLog.countDocuments({ createdAt: { $gte: since24h } }),
      ApiActivityLog.countDocuments({
        createdAt: { $gte: since24h },
        level: { $in: ["error", "crash"] },
      }),
      ApiActivityLog.countDocuments({
        createdAt: { $gte: since24h },
        level: "warn",
      }),
      ApiActivityLog.countDocuments({
        createdAt: { $gte: since24h },
        category: "server_crash",
      }),
      UserSession.countDocuments({ platform: "web", isActive: true }),
      UserSession.countDocuments({ platform: "mobile", isActive: true }),
      AuthUser.countDocuments({ role: "developer" }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        totalLogs24h,
        errorCount24h,
        warningCount24h,
        crashCount24h,
        activeWebSessions,
        activeMobileSessions,
        developerCount,
      },
    });
  } catch (error) {
    console.error("[Developer] Overview error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load developer overview metrics.",
    });
  }
};

/**
 * GET /api/developer/logs
 * Query API logs, user activity failures, bugs, and server crashes.
 */
export const getApiLogs = async (req, res) => {
  try {
    const { ApiActivityLog } = getMasterModels();
    const {
      level,
      category,
      platform,
      resolutionStatus,
      search,
      onlyFailures,
      page = 1,
      limit = 50,
    } = req.query;

    const filter = {};
    if (level && level !== "all") {
      filter.level = level;
    }
    if (category && category !== "all") {
      filter.category = category;
    }
    if (platform && platform !== "all") {
      filter.platform = platform;
    }
    if (resolutionStatus && resolutionStatus !== "all") {
      if (resolutionStatus === "unsolved") {
        filter.resolutionStatus = { $ne: "solved" };
      } else {
        filter.resolutionStatus = resolutionStatus;
      }
    }
    if (onlyFailures === "true") {
      filter.$or = [
        { level: { $in: ["warn", "error", "crash"] } },
        { statusCode: { $gte: 400 } },
      ];
    }
    if (search && String(search).trim()) {
      const q = String(search).trim();
      const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const searchCond = [
        { path: regex },
        { userEmail: regex },
        { message: regex },
        { errorName: regex },
      ];
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: searchCond }];
        delete filter.$or;
      } else {
        filter.$or = searchCond;
      }
    }

    const parsedPage = Math.max(1, parseInt(page, 10) || 1);
    const parsedLimit = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (parsedPage - 1) * parsedLimit;

    const [logs, total] = await Promise.all([
      ApiActivityLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit)
        .lean(),
      ApiActivityLog.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: logs,
      pagination: {
        total,
        page: parsedPage,
        limit: parsedLimit,
        totalPages: Math.max(1, Math.ceil(total / parsedLimit)),
      },
    });
  } catch (error) {
    console.error("[Developer] getApiLogs error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch API & error logs.",
    });
  }
};

/**
 * DELETE /api/developer/logs
 * Clear logs by filter (optional level/category).
 */
export const clearApiLogs = async (req, res) => {
  try {
    const { ApiActivityLog } = getMasterModels();
    const { level, category } = req.query;
    const filter = {};
    if (level && level !== "all") filter.level = level;
    if (category && category !== "all") filter.category = category;

    const result = await ApiActivityLog.deleteMany(filter);
    return res.status(200).json({
      success: true,
      deletedCount: result.deletedCount || 0,
      message: `Cleared ${result.deletedCount || 0} log entries.`,
    });
  } catch (error) {
    console.error("[Developer] clearApiLogs error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to clear logs.",
    });
  }
};

/**
 * PATCH /api/developer/logs/:id/resolution
 * Mark a bug/error log as solved or unsolved.
 */
export const updateLogResolution = async (req, res) => {
  try {
    const { ApiActivityLog } = getMasterModels();
    const { id } = req.params;
    const { status, note } = req.body || {};

    if (!["solved", "unsolved"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Status must be 'solved' or 'unsolved'.",
      });
    }

    const updated = await ApiActivityLog.findByIdAndUpdate(
      id,
      {
        $set: {
          resolutionStatus: status,
          resolvedAt: status === "solved" ? new Date() : null,
          resolvedBy:
            status === "solved"
              ? req.user?.email || req.user?.name || "developer"
              : null,
          resolutionNote: note !== undefined ? String(note).slice(0, 500) : "",
        },
      },
      { new: true }
    ).lean();

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: "Log entry not found.",
      });
    }

    return res.status(200).json({
      success: true,
      message: `Marked as ${status}.`,
      data: updated,
    });
  } catch (error) {
    console.error("[Developer] updateLogResolution error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update log resolution status.",
    });
  }
};

/**
 * GET /api/developer/sessions
 * List active or revoked Web (frontend) and Mobile App sessions.
 */
export const getUserSessions = async (req, res) => {
  try {
    const { UserSession } = getMasterModels();
    const {
      platform = "all",
      status = "active",
      search,
      page = 1,
      limit = 50,
    } = req.query;

    const filter = {};
    if (platform && platform !== "all") {
      filter.platform = platform;
    }
    if (status === "active") {
      filter.isActive = true;
    } else if (status === "revoked") {
      filter.isActive = false;
    }

    if (search && String(search).trim()) {
      const q = String(search).trim();
      const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { email: regex },
        { name: regex },
        { organizationName: regex },
        { role: regex },
      ];
    }

    const parsedPage = Math.max(1, parseInt(page, 10) || 1);
    const parsedLimit = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (parsedPage - 1) * parsedLimit;

    const [sessions, total, activeWeb, activeMobile, revokedTotal] =
      await Promise.all([
        UserSession.find(filter)
          .sort({ lastActiveAt: -1 })
          .skip(skip)
          .limit(parsedLimit)
          .lean(),
        UserSession.countDocuments(filter),
        UserSession.countDocuments({ platform: "web", isActive: true }),
        UserSession.countDocuments({ platform: "mobile", isActive: true }),
        UserSession.countDocuments({ isActive: false }),
      ]);

    return res.status(200).json({
      success: true,
      data: sessions,
      counts: {
        activeWeb,
        activeMobile,
        revokedTotal,
      },
      pagination: {
        total,
        page: parsedPage,
        limit: parsedLimit,
        totalPages: Math.max(1, Math.ceil(total / parsedLimit)),
      },
    });
  } catch (error) {
    console.error("[Developer] getUserSessions error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch user sessions.",
    });
  }
};

/**
 * POST /api/developer/sessions/:sessionId/force-logout
 * Force logout a specific Web or Mobile session immediately.
 */
export const forceLogoutSession = async (req, res) => {
  try {
    const { UserSession } = getMasterModels();
    const { sessionId } = req.params;
    const { reason } = req.body || {};

    const session = await UserSession.findOne({ sessionId });
    if (!session) {
      return res.status(404).json({
        success: false,
        message: "Session not found.",
      });
    }

    session.isActive = false;
    session.revokedAt = new Date();
    session.revokedBy = req.user?.email || req.user?.name || "developer";
    session.revokeReason =
      reason ||
      `Force logged out from ${session.platform} by ${req.user?.role || "developer"}`;
    await session.save();

    await recordApiActivityLog({
      method: "POST",
      path: req.originalUrl,
      statusCode: 200,
      level: "warn",
      category: "auth",
      message: `Force-logged out ${session.platform} session for ${session.email || session.userId}`,
      userId: req.user?._id || req.user?.id || null,
      userEmail: req.user?.email || null,
      userRole: req.user?.role || null,
      platform: "admin",
    });

    return res.status(200).json({
      success: true,
      message: `Force logged out ${session.platform} session for ${session.email || session.userId}.`,
      data: session,
    });
  } catch (error) {
    console.error("[Developer] forceLogoutSession error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to force logout session.",
    });
  }
};

/**
 * POST /api/developer/sessions/force-logout-platform
 * Bulk force logout all Web (frontend) or Mobile App sessions (optionally scoped to userId/organizationId).
 */
export const forceLogoutPlatform = async (req, res) => {
  try {
    const { UserSession } = getMasterModels();
    const { platform, userId, organizationId, reason } = req.body || {};

    if (!["web", "mobile"].includes(platform)) {
      return res.status(400).json({
        success: false,
        message: "Platform must be either 'web' or 'mobile'.",
      });
    }

    // Extract caller's own sessionId so they don't accidentally lock themselves out during global web logout
    let callerSessionId = null;
    if (req.headers.authorization?.startsWith("Bearer ")) {
      const decoded = jwt.decode(req.headers.authorization.split(" ")[1]);
      callerSessionId = decoded?.sessionId || null;
    }

    const filter = {
      platform,
      isActive: true,
      ...(callerSessionId ? { sessionId: { $ne: callerSessionId } } : {}),
    };
    if (userId) filter.userId = String(userId);
    if (organizationId) filter.organizationId = String(organizationId);

    const revokeReason =
      reason ||
      `All ${platform === "web" ? "Web (Frontend)" : "Mobile App"} sessions were force-logged out by ${req.user?.role || "developer"}.`;

    const result = await UserSession.updateMany(filter, {
      $set: {
        isActive: false,
        revokedAt: new Date(),
        revokedBy: req.user?.email || req.user?.name || "developer",
        revokeReason,
      },
    });

    const modifiedCount = result.modifiedCount ?? result.nModified ?? 0;

    await recordApiActivityLog({
      method: "POST",
      path: req.originalUrl,
      statusCode: 200,
      level: "warn",
      category: "auth",
      message: `Bulk force-logout triggered for ${platform} (${modifiedCount} sessions revoked)`,
      userId: req.user?._id || req.user?.id || null,
      userEmail: req.user?.email || null,
      userRole: req.user?.role || null,
      platform: "admin",
    });

    return res.status(200).json({
      success: true,
      modifiedCount,
      message: `Force logged out ${modifiedCount} active ${platform} session(s).`,
    });
  } catch (error) {
    console.error("[Developer] forceLogoutPlatform error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to execute bulk force logout.",
    });
  }
};

/**
 * GET /api/developer/users
 * List all developer & super_admin accounts in Master AuthUser.
 */
export const listDeveloperUsers = async (req, res) => {
  try {
    const { AuthUser } = getMasterModels();
    const users = await AuthUser.find({
      role: { $in: ["developer", "super_admin"] },
    })
      .select("-password")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      data: users,
    });
  } catch (error) {
    console.error("[Developer] listDeveloperUsers error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch developer accounts.",
    });
  }
};

/**
 * POST /api/developer/users
 * Create a new developer account with full admin + developer permissions.
 */
export const createDeveloperUser = async (req, res) => {
  try {
    const { AuthUser } = getMasterModels();
    const { name, email, password, phone } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Name, email, and password are required.",
      });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const existing = await AuthUser.findOne({ email: cleanEmail });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists.",
      });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(String(password), salt);

    const devUser = await AuthUser.create({
      name: String(name).trim(),
      email: cleanEmail,
      password: hashedPassword,
      phone: phone ? String(phone).trim() : undefined,
      role: "developer",
      status: "active",
      isOrgOwner: false,
      accountType: "crm",
    });

    return res.status(201).json({
      success: true,
      message: "Developer account created successfully.",
      data: {
        _id: devUser._id,
        name: devUser.name,
        email: devUser.email,
        phone: devUser.phone || "",
        role: devUser.role,
        status: devUser.status,
        createdAt: devUser.createdAt,
      },
    });
  } catch (error) {
    console.error("[Developer] createDeveloperUser error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create developer account.",
    });
  }
};

/**
 * PATCH /api/developer/users/:id/status
 * Activate or deactivate a developer account.
 */
export const toggleDeveloperUserStatus = async (req, res) => {
  try {
    const { AuthUser } = getMasterModels();
    const { id } = req.params;
    const { status } = req.body || {};

    if (!["active", "inactive"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Status must be 'active' or 'inactive'.",
      });
    }

    const target = await AuthUser.findById(id).select("-password");
    if (!target || target.role !== "developer") {
      return res.status(404).json({
        success: false,
        message: "Developer user not found.",
      });
    }

    target.status = status;
    await target.save();

    return res.status(200).json({
      success: true,
      message: `Developer account marked as ${status}.`,
      data: target,
    });
  } catch (error) {
    console.error("[Developer] toggleDeveloperUserStatus error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update developer status.",
    });
  }
};
