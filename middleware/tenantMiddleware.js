import jwt from "jsonwebtoken";
import { getTenantModels, getMasterModels } from "../services/tenantManager.js";

/**
 * Middleware that attaches tenant-scoped models and organization info to req.
 * Runs non-destructively: if no tenant is found, falls back safely to default database models.
 */
export const tenantMiddleware = async (req, res, next) => {
  try {
    let tenantDbName = null;
    let organizationId = null;

    // 1. Check if token is present in Authorization header
    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer")
    ) {
      try {
        const token = req.headers.authorization.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.tenantDbName) {
          tenantDbName = decoded.tenantDbName;
        }
        if (decoded.organizationId) {
          organizationId = decoded.organizationId;
        }
        req.userTokenData = decoded;
      } catch (err) {
        // Token might be invalid or expired; let authMiddleware handle 401 if route is protected
      }
    }

    // 2. Check webhook secret or API key (e.g. for external status webhook or API integrations)
    const secretOrKey =
      req.headers["x-webhook-secret"] ||
      req.headers["x-api-key"] ||
      req.query?.secret ||
      req.query?.apiKey ||
      req.body?.secret ||
      req.body?.apiKey;

    const { Organization } = getMasterModels();

    if (!organizationId && secretOrKey) {
      try {
        const orgBySecret = await Organization.findOne({ webhookKey: secretOrKey });
        if (orgBySecret) {
          req.organization = orgBySecret;
          organizationId = orgBySecret._id;
          tenantDbName = orgBySecret.tenantDbName;
        }
      } catch (e) {
        console.error("Error looking up organization by webhookKey in tenantMiddleware:", e);
      }
    }

    // 3. Check explicit organization ID from headers, query, or body (e.g. website lead submission)
    if (!organizationId) {
      const explicitOrgId =
        req.headers["x-organization-id"] ||
        req.headers["x-org-id"] ||
        req.query?.orgId ||
        req.query?.organizationId ||
        req.body?.organizationId ||
        req.body?.orgId;

      if (explicitOrgId) {
        try {
          const org = await Organization.findById(explicitOrgId);
          if (org) {
            req.organization = org;
            organizationId = org._id;
            tenantDbName = org.tenantDbName;
          }
        } catch (e) {
          // might not be a valid ObjectId
        }
      }
    }

    // 4. Only allow explicit headers or query params if NO authenticated user token or secret was matched
    // (Genuinely unauthenticated public endpoints like website lead capture or static chat can use this)
    if (!req.headers.authorization && !tenantDbName) {
      tenantDbName =
        req.headers["x-tenant-db"] ||
        req.headers["x-tenant-id"] ||
        req.query?.tenantDb ||
        req.body?.tenantDb ||
        null;
    }

    // 5. Attach tenant models
    req.tenantDbName = tenantDbName;
    req.tenantModels = getTenantModels(tenantDbName);

    // 6. If organizationId exists and req.organization not yet set, fetch and attach organization details
    if (organizationId && !req.organization) {
      try {
        const org = await Organization.findById(organizationId);
        if (org) {
          req.organization = org;
        }
      } catch (orgErr) {
        console.error("Error loading organization in tenantMiddleware:", orgErr);
      }
    } else if (tenantDbName && !req.organization) {
      try {
        const org = await Organization.findOne({ tenantDbName });
        if (org) {
          req.organization = org;
        }
      } catch (orgErr) {
        console.error("Error loading organization by tenantDbName in tenantMiddleware:", orgErr);
      }
    }

    next();
  } catch (error) {
    console.error("Error in tenantMiddleware:", error);
    next(error);
  }
};

/**
 * Middleware to check if organization subscription is active
 */
export const checkSubscriptionActive = (req, res, next) => {
  // 1. Bypass Super Admin (via role, token data, or admin API key)
  if (req.user?.role === "super_admin" || req.userTokenData?.role === "super_admin") {
    return next();
  }

  const adminApiKey = req.headers["x-admin-key"];
  const configuredApiKey = process.env.ADMIN_API_KEY && process.env.ADMIN_API_KEY.trim();
  if (configuredApiKey && adminApiKey && adminApiKey === configuredApiKey) {
    return next();
  }

  // 2. Bypass public authentication routes, static chat, webhooks, website leads, and health checks
  const path = req.path || req.originalUrl || "";
  if (
    path.startsWith("/api/auth/login") ||
    path.startsWith("/api/auth/forgot-password") ||
    path.startsWith("/api/auth/reset-password") ||
    path.startsWith("/api/static-chat") ||
    path.startsWith("/api/whatsapp/cloud/webhook") ||
    path.startsWith("/api/meta/webhook") ||
    path.startsWith("/api/webhooks/meta") ||
    path.startsWith("/api/leads/webhook/status") ||
    path.startsWith("/api/website") ||
    path === "/" ||
    path === "/health"
  ) {
    return next();
  }

  // 3. Bypass Super Admin organization management endpoints
  if (path.startsWith("/api/organizations") && !path.startsWith("/api/organizations/my-org")) {
    return next();
  }

  // 4. Check organization status if attached
  if (req.organization) {
    if (req.organization.status === "inactive" || req.organization.status === "suspended") {
      return res.status(403).json({
        success: false,
        accountSuspended: true,
        organizationStatus: req.organization.status,
        message: `Your organization workspace (${req.organization.name || "account"}) is currently ${req.organization.status}. Please contact SalesBuster administrator.`,
      });
    }

    if (req.organization.subscriptionEndDate) {
      const isExpired = new Date() > new Date(req.organization.subscriptionEndDate);
      if (isExpired) {
        return res.status(403).json({
          success: false,
          subscriptionExpired: true,
          message: `Your organization's subscription expired on ${new Date(
            req.organization.subscriptionEndDate
          ).toLocaleDateString("en-IN", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          })}. Please contact SalesBuster administrator to renew.`,
        });
      }
    }
  }
  next();
};

export { requireSuperAdmin } from "./authMiddleware.js";

