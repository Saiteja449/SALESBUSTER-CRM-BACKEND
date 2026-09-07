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
  if (req.organization) {
    if (req.organization.status === "inactive" || req.organization.status === "suspended") {
      return res.status(403).json({
        success: false,
        accountSuspended: true,
        message: "Your organization account is currently inactive or suspended. Please contact SalesBuster administrator.",
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

