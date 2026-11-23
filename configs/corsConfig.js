/**
 * Production-ready, secure CORS Configuration for SalesBuster CRM.
 * Protects against cross-origin token abuse while ensuring zero disruption
 * for web clients, staging apps, mobile apps, and developer environments.
 */
const getExplicitAllowedOrigins = () => {
  const defaults = [
    "https://betaapp.salesbuster.ai",
    "https://app.salesbuster.ai",
    "https://salesbuster.ai",
  ];

  if (process.env.CLIENT_URL) defaults.push(process.env.CLIENT_URL.trim());
  if (process.env.FRONTEND_URL) defaults.push(process.env.FRONTEND_URL.trim());

  if (process.env.ALLOWED_ORIGINS) {
    const custom = process.env.ALLOWED_ORIGINS.split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    defaults.push(...custom);
  }

  return [...new Set(defaults)];
};

export const corsOptions = {
  origin: (origin, callback) => {
    // 1. Allow non-browser requests (e.g. mobile apps, webhooks, cURL, Postman)
    if (!origin) {
      return callback(null, true);
    }

    // 2. Allow all localhost & 127.0.0.1 origins (development & local testing on any port)
    if (
      process.env.NODE_ENV !== "production" ||
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
    ) {
      return callback(null, true);
    }

    const allowed = getExplicitAllowedOrigins();

    // 3. Match exact allowed origins
    if (allowed.includes(origin)) {
      return callback(null, true);
    }

    // 4. Match any official salesbuster.ai domain or subdomain
    try {
      const parsedUrl = new URL(origin);
      if (
        parsedUrl.hostname === "salesbuster.ai" ||
        parsedUrl.hostname.endsWith(".salesbuster.ai")
      ) {
        return callback(null, true);
      }
    } catch (_) {}

    // 5. If origin is not recognized, reject cleanly
    return callback(new Error(`Origin '${origin}' is not authorized by CORS policy.`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-webhook-secret",
    "x-api-key",
    "x-access-token",
    "x-admin-key",
    "x-client-platform",
  ],
  exposedHeaders: ["x-total-count", "x-request-id"],
  maxAge: 86400, // Cache preflight requests for 24 hours
};

export default corsOptions;
