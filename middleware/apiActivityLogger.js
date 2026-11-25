import {
  detectLogPlatform,
  getClientIp,
  recordApiActivityLog,
  sanitizeRequestBody,
} from "../services/telemetryService.js";

/**
 * Express middleware that captures every API request/response, latency,
 * user activity failures, and server errors/bugs for the Developer Console.
 */
export const apiActivityLogger = (req, res, next) => {
  // Skip health checks and noisy developer log polling to prevent feedback loops
  if (
    req.originalUrl === "/health" ||
    req.originalUrl.startsWith("/api/developer/logs")
  ) {
    return next();
  }

  const startHr = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startHr) / 1e6;
    const statusCode = res.statusCode || 200;
    const errorMeta = res.locals?.errorMeta || null;

    let level = "info";
    let category = "api";

    if (statusCode >= 500) {
      level = "error";
      category = "bug";
    } else if (statusCode >= 400) {
      level = "warn";
      category = req.originalUrl.includes("/auth") ? "auth" : "activity";
    }

    const message =
      errorMeta?.message ||
      res.locals?.logMessage ||
      `${req.method} ${req.originalUrl} -> ${statusCode}`;

    recordApiActivityLog({
      method: req.method,
      path: req.originalUrl,
      statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      level,
      category,
      message,
      errorName: errorMeta?.errorName || "",
      stack: errorMeta?.stack || "",
      userId: req.user?._id || req.user?.id || null,
      userEmail: req.user?.email || req.body?.email || null,
      userRole: req.user?.role || null,
      organizationId: req.user?.organizationId || req.organization?._id || null,
      platform: detectLogPlatform(req),
      ip: getClientIp(req),
      userAgent: req.headers["user-agent"] || "",
      requestBodySummary:
        req.method !== "GET" && req.method !== "HEAD"
          ? sanitizeRequestBody(req.body)
          : "",
    });
  });

  next();
};

export default apiActivityLogger;
