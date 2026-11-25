import crypto from "crypto";
import mongoose from "mongoose";
import { getMasterModels } from "./tenantManager.js";

const MOBILE_UA_REGEX = /(okhttp|dart|flutter|reactnative|expo|cfnetwork|dalvik|android|iphone|ipad|salesbuster-mobile)/i;

/**
 * Normalize client platform into "web" or "mobile" for session tracking.
 */
export const normalizeSessionPlatform = (req) => {
  const headerPlatform = String(
    req?.headers?.["x-client-platform"] ||
      req?.headers?.["x-client-type"] ||
      req?.body?.clientType ||
      req?.body?.platform ||
      ""
  )
    .trim()
    .toLowerCase();

  if (
    headerPlatform === "mobile" ||
    headerPlatform === "android" ||
    headerPlatform === "ios" ||
    headerPlatform === "app" ||
    headerPlatform === "flutter" ||
    headerPlatform === "react-native"
  ) {
    return "mobile";
  }

  if (headerPlatform === "web" || headerPlatform === "admin" || headerPlatform === "browser") {
    return "web";
  }

  const ua = String(req?.headers?.["user-agent"] || "");
  if (MOBILE_UA_REGEX.test(ua) && !/mozilla\/5\.0/i.test(ua)) {
    return "mobile";
  }

  return "web";
};

/**
 * Determine platform label for API activity logging ("admin" | "mobile" | "web" | "unknown").
 */
export const detectLogPlatform = (req) => {
  if (req?.headers?.["x-admin-key"] || req?.user?.role === "super_admin" || req?.user?.role === "developer") {
    return "admin";
  }
  const sessionPlatform = normalizeSessionPlatform(req);
  return sessionPlatform || "unknown";
};

export const getClientIp = (req) => {
  return (
    req?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req?.socket?.remoteAddress ||
    req?.ip ||
    ""
  );
};

export const sanitizeRequestBody = (body) => {
  if (!body || typeof body !== "object") return "";
  try {
    const redactedKeys = new Set([
      "password",
      "newPassword",
      "currentPassword",
      "token",
      "accessToken",
      "refreshToken",
      "otp",
      "secret",
      "authorization",
    ]);
    const clone = {};
    for (const [k, v] of Object.entries(body)) {
      if (redactedKeys.has(k)) {
        clone[k] = "[REDACTED]";
      } else if (typeof v === "string" && v.length > 200) {
        clone[k] = v.slice(0, 200) + "...";
      } else {
        clone[k] = v;
      }
    }
    const serialized = JSON.stringify(clone);
    return serialized.length > 500 ? serialized.slice(0, 500) + "..." : serialized;
  } catch {
    return "";
  }
};

/**
 * Create a tracked UserSession record for web or mobile login.
 */
export const createUserSession = async ({ user, organization, req, platform }) => {
  const sessionId = crypto.randomUUID();
  const resolvedPlatform = platform || normalizeSessionPlatform(req);

  try {
    if (mongoose.connection.readyState !== 1 && typeof getMasterModels !== "function") {
      return { sessionId, platform: resolvedPlatform };
    }
    const masterModels = getMasterModels();
    const UserSession = masterModels?.UserSession;
    if (!UserSession) {
      return { sessionId, platform: resolvedPlatform };
    }

    const userIdStr = String(user._id || user.id);

    // Enforce single active session per platform (max 1 web + 1 mobile = 2 total)
    const revokeResult = await UserSession.updateMany(
      {
        userId: userIdStr,
        platform: resolvedPlatform,
        isActive: true,
      },
      {
        $set: {
          isActive: false,
          revokedAt: new Date(),
          revokedBy: "system_single_session",
          revokeReason: `New ${resolvedPlatform} login detected. Previous ${resolvedPlatform} session was automatically logged out.`,
        },
      }
    );

    const revokedCount = revokeResult?.modifiedCount ?? revokeResult?.nModified ?? 0;
    if (revokedCount > 0) {
      recordApiActivityLog({
        method: "POST",
        path: req?.originalUrl || "/api/auth/login",
        statusCode: 200,
        level: "info",
        category: "auth",
        message: `Auto-logged out ${revokedCount} previous ${resolvedPlatform} session(s) for ${user.email || userIdStr} (single-session policy)`,
        userId: userIdStr,
        userEmail: user.email || null,
        userRole: user.role || null,
        organizationId: user.organizationId ? String(user.organizationId) : null,
        platform: resolvedPlatform,
        ip: getClientIp(req),
      });
    }

    await UserSession.create({
      sessionId,
      userId: userIdStr,
      email: user.email || "",
      name: user.name || "",
      role: user.role || "sales person",
      organizationId: user.organizationId ? String(user.organizationId) : null,
      organizationName: organization?.name || "",
      tenantDbName: user.tenantDbName || organization?.tenantDbName || null,
      platform: resolvedPlatform,
      userAgent: String(req?.headers?.["user-agent"] || "").slice(0, 300),
      ip: getClientIp(req),
      isActive: true,
      lastActiveAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
  } catch (err) {
    console.error("[Telemetry] Failed to create UserSession:", err.message);
  }

  return { sessionId, platform: resolvedPlatform };
};

/**
 * Check whether a decoded JWT's sessionId is still active (not force-logged out).
 */
export const verifyUserSessionActive = async (decoded) => {
  if (!decoded?.sessionId) {
    return { active: true };
  }
  try {
    const masterModels = getMasterModels();
    const UserSession = masterModels?.UserSession;
    if (!UserSession) {
      return { active: true };
    }

    const session = await UserSession.findOne({ sessionId: decoded.sessionId }).lean();
    if (!session) {
      return { active: true };
    }

    if (!session.isActive) {
      return {
        active: false,
        platform: session.platform,
        reason:
          session.revokeReason ||
          `Your ${session.platform} session has been logged out by an administrator.`,
      };
    }

    // Throttle lastActiveAt updates to once per 60 seconds
    const lastActiveMs = session.lastActiveAt ? new Date(session.lastActiveAt).getTime() : 0;
    if (Date.now() - lastActiveMs > 60 * 1000) {
      UserSession.updateOne(
        { sessionId: decoded.sessionId },
        { $set: { lastActiveAt: new Date() } }
      ).catch(() => {});
    }

    return { active: true, platform: session.platform };
  } catch (err) {
    console.error("[Telemetry] Session verification check failed:", err.message);
    return { active: true };
  }
};

/**
 * Record an API, auth, user activity, bug, or server crash log entry.
 */
export const recordApiActivityLog = async (entry) => {
  try {
    const masterModels = getMasterModels();
    const ApiActivityLog = masterModels?.ApiActivityLog;
    if (!ApiActivityLog) return null;

    return await ApiActivityLog.create({
      method: entry.method || "SYSTEM",
      path: String(entry.path || "/").slice(0, 500),
      statusCode: Number(entry.statusCode ?? 200),
      durationMs: Number(entry.durationMs ?? 0),
      level: entry.level || "info",
      category: entry.category || "api",
      message: String(entry.message || "").slice(0, 1000),
      errorName: String(entry.errorName || "").slice(0, 200),
      stack: String(entry.stack || "").slice(0, 4000),
      userId: entry.userId ? String(entry.userId) : null,
      userEmail: entry.userEmail || null,
      userRole: entry.userRole || null,
      organizationId: entry.organizationId ? String(entry.organizationId) : null,
      platform: entry.platform || "unknown",
      ip: entry.ip || "",
      userAgent: String(entry.userAgent || "").slice(0, 300),
      requestBodySummary: entry.requestBodySummary || "",
    });
  } catch (err) {
    console.error("[Telemetry] Failed to write ApiActivityLog:", err.message);
    return null;
  }
};
