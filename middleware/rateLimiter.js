import rateLimit from "express-rate-limit";

/**
 * Tiered Rate Limiters for SalesBuster CRM.
 * Protects login/auth endpoints against brute-force attacks and prevents
 * denial-of-service spikes, while skipping webhooks and test suites.
 */

// 1. Strict Limiter for Authentication & Password Operations
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // 30 requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.NODE_ENV === "test",
  message: {
    success: false,
    code: "TOO_MANY_REQUESTS",
    message: "Too many authentication attempts from this IP address. Please try again after 15 minutes.",
  },
});

// 2. General API Limiter
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 600, // 600 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    if (process.env.NODE_ENV === "test") return true;
    // Never rate-limit incoming webhooks or health checks
    const url = req.originalUrl || req.url || "";
    return (
      url.includes("/webhook") ||
      url.includes("/health") ||
      url.startsWith("/api/s/") ||
      url.startsWith("/s/")
    );
  },
  message: {
    success: false,
    code: "RATE_LIMIT_EXCEEDED",
    message: "Too many requests. Please slow down and try again shortly.",
  },
});
