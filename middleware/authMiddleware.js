import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { getTenantModels, getMasterModels } from "../services/tenantManager.js";

export const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    try {
      token = req.headers.authorization.split(" ")[1];

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Ensure tenant models are attached
      const tenantDbName = decoded.tenantDbName || req.tenantDbName;
      if (tenantDbName && (!req.tenantModels || req.tenantDbName !== tenantDbName)) {
        req.tenantDbName = tenantDbName;
        req.tenantModels = getTenantModels(tenantDbName);
      }

      // Attach organization if available
      if (decoded.organizationId && !req.organization) {
        try {
          const { Organization } = getMasterModels();
          req.organization = await Organization.findById(decoded.organizationId);
        } catch (orgErr) {
          console.error("Error finding organization in authMiddleware:", orgErr);
        }
      }

      // Look up user: if super_admin, check Master AuthUser first
      let user = null;
      if (decoded.role === "super_admin") {
        const { AuthUser } = getMasterModels();
        user = await AuthUser.findById(decoded.id).select("-password");
        if (!user) {
          user = await User.findById(decoded.id).select("-password -otp -otpExpiresAt");
        }
      } else {
        if (req.tenantModels?.User) {
          user = await req.tenantModels.User.findById(decoded.id).select("-password -otp -otpExpiresAt");
        }
        if (!user) {
          const { AuthUser } = getMasterModels();
          user = await AuthUser.findById(decoded.id).select("-password");
        }
        if (!user) {
          user = await User.findById(decoded.id).select("-password -otp -otpExpiresAt");
        }
      }

      if (!user) {
        return res.status(401).json({ success: false, message: "Not authorized, user not found" });
      }

      req.user = user;
      req.user.role = decoded.role || user.role;
      req.user.tenantDbName = tenantDbName;
      req.user.organizationId = decoded.organizationId;
      req.user.isOrgOwner = decoded.isOrgOwner || user.isOrgOwner;

      return next();
    } catch (error) {
      if (error.name === "TokenExpiredError") {
        return res.status(401).json({ success: false, message: "Not authorized, token expired" });
      }
      console.error("Auth middleware error:", error);
      return res.status(401).json({ success: false, message: "Not authorized, token invalid" });
    }
  }

  if (!token) {
    return res.status(401).json({ success: false, message: "Not authorized, no token" });
  }
};

/**
 * Middleware that strictly verifies Super Admin authentication using JWT token.
 * Validates token signature, expiration, and super_admin role.
 * Also supports x-admin-key header for backward-compatible server-to-server operations.
 */
export const verifySuperAdmin = async (req, res, next) => {
  const adminApiKey = req.headers["x-admin-key"];
  const validApiKey =
    process.env.ADMIN_API_KEY || "salesbuster_super_admin_secret_key_2026";

  let token = null;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  } else if (req.headers["x-access-token"]) {
    token = req.headers["x-access-token"];
  }

  // If token is provided, verify it strictly
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Verify role in token payload
      if (decoded.role !== "super_admin") {
        return res.status(403).json({
          success: false,
          message: "Access forbidden: Super Administrator privileges required",
        });
      }

      // Check Master AuthUser registry first
      const { AuthUser } = getMasterModels();
      let user = await AuthUser.findById(decoded.id).select("-password");

      // Fallback to User collection for legacy accounts
      if (!user) {
        user = await User.findById(decoded.id).select(
          "-password -otp -otpExpiresAt"
        );
      }

      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Not authorized, Super Admin user not found",
        });
      }

      if (user.role !== "super_admin") {
        return res.status(403).json({
          success: false,
          message: "Access forbidden: Super Administrator privileges required",
        });
      }

      if (user.status === "inactive") {
        return res.status(403).json({
          success: false,
          message: "Super Admin account is inactive",
        });
      }

      req.user = user;
      req.user.role = "super_admin";
      return next();
    } catch (error) {
      if (error.name === "TokenExpiredError") {
        return res.status(401).json({
          success: false,
          message: "Not authorized, token expired",
        });
      }
      console.error("Super Admin token verification error:", error);
      return res.status(401).json({
        success: false,
        message: "Not authorized, token invalid",
      });
    }
  }

  // If no token, check if valid admin API key is provided
  if (adminApiKey && adminApiKey === validApiKey) {
    req.user = {
      role: "super_admin",
      name: "Super Admin (API Key)",
      isOrgOwner: false,
    };
    return next();
  }

  return res.status(401).json({
    success: false,
    message: "Not authorized, Super Admin token is required",
  });
};

/**
 * Role guard middleware to check if authenticated user is super_admin.
 * If protect was not run before this, it delegates to verifySuperAdmin.
 */
export const requireSuperAdmin = (req, res, next) => {
  if (req.user && req.user.role === "super_admin") {
    return next();
  }

  const adminApiKey = req.headers["x-admin-key"];
  const validApiKey =
    process.env.ADMIN_API_KEY || "salesbuster_super_admin_secret_key_2026";
  if (adminApiKey && adminApiKey === validApiKey) {
    req.user = req.user || {
      role: "super_admin",
      name: "Super Admin (API Key)",
    };
    return next();
  }

  if (req.user) {
    return res.status(403).json({
      success: false,
      message: "Access forbidden: Super Administrator privileges required",
    });
  }

  return verifySuperAdmin(req, res, next);
};
