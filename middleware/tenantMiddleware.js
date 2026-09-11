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

    // 2. Check explicit headers or query params
    if (!tenantDbName) {
      tenantDbName =
        req.headers["x-tenant-db"] ||
        req.headers["x-tenant-id"] ||
        req.query.tenantDb ||
        null;
    }

    // 3. Attach tenant models
    req.tenantDbName = tenantDbName;
    req.tenantModels = getTenantModels(tenantDbName);

    // 4. If organizationId exists, fetch and attach organization details
    if (organizationId) {
      try {
        const { Organization } = getMasterModels();
        const org = await Organization.findById(organizationId);
        if (org) {
          req.organization = org;
        }
      } catch (orgErr) {
        console.error("Error loading organization in tenantMiddleware:", orgErr);
      }
    } else if (tenantDbName) {
      try {
        const { Organization } = getMasterModels();
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
  const validApiKey =
    process.env.ADMIN_API_KEY || "salesbuster_super_admin_secret_key_2026";
  if (adminApiKey && adminApiKey === validApiKey) {
    return next();
  }

  // 2. Bypass public authentication routes, static chat, and health checks
  const path = req.path || req.originalUrl || "";
  if (
    path.startsWith("/api/auth/login") ||
    path.startsWith("/api/auth/forgot-password") ||
    path.startsWith("/api/auth/reset-password") ||
    path.startsWith("/api/static-chat") ||
    path.startsWith("/api/whatsapp/cloud/webhook") ||
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

