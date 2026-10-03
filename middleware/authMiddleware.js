import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { getTenantModels, getMasterModels } from "../services/tenantManager.js";

export const protect = async (req, res, next) => {
  console.log("\n==================== [authMiddleware: protect] START ====================");
  console.log(`[protect] [Step 1] Request received: ${req.method} ${req.originalUrl || req.url} at ${new Date().toISOString()}`);

  let token;
  let tokenSource = "none";

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
    tokenSource = "Authorization (Bearer)";
  } else if (req.headers["x-access-token"]) {
    token = req.headers["x-access-token"];
    tokenSource = "x-access-token";
  } else if (req.body && req.body.token) {
    token = String(req.body.token).replace(/^Bearer\s+/i, "").trim();
    tokenSource = "req.body.token";
  } else if (
    req.headers["x-admin-key"] &&
    (req.headers["x-admin-key"].startsWith("ey") ||
      req.headers["x-admin-key"].startsWith("Bearer "))
  ) {
    token = req.headers["x-admin-key"].replace(/^Bearer\s+/i, "").trim();
    tokenSource = "x-admin-key (JWT)";
  }

  console.log(`[protect] [Step 1] Token source: ${tokenSource}, token present: ${!!token}`);

  if (token) {
    try {
      console.log("[protect] [Step 2] Verifying JWT token with secret...");
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      console.log("[protect] [Step 2] Token successfully verified. Decoded payload:", {
        id: decoded.id,
        role: decoded.role,
        tenantDbName: decoded.tenantDbName,
        organizationId: decoded.organizationId,
        isOrgOwner: decoded.isOrgOwner,
        exp: decoded.exp ? new Date(decoded.exp * 1000).toISOString() : undefined,
      });

      // Ensure tenant scope comes from verified user token, never unauthenticated headers
      let tenantDbName = decoded.tenantDbName;
      if (decoded.organizationId) {
        try {
          console.log(`[protect] [Step 3] Loading organization for ID: ${decoded.organizationId}...`);
          const { Organization } = getMasterModels();
          req.organization = await Organization.findById(decoded.organizationId);
          if (req.organization) {
            console.log(`[protect] [Step 3] Organization loaded: "${req.organization.name}" (status: ${req.organization.status})`);
          } else {
            console.warn(`[protect] [Step 3] No organization found for ID: ${decoded.organizationId}`);
          }
          if (!tenantDbName && req.organization?.tenantDbName) {
            tenantDbName = req.organization.tenantDbName;
            console.log(`[protect] [Step 3] Set tenantDbName from organization: ${tenantDbName}`);
          }
        } catch (orgErr) {
          console.error("[protect] [Step 3] Error finding organization in authMiddleware:", orgErr.message);
        }
      } else {
        console.log("[protect] [Step 3] No organizationId in token payload.");
      }

      req.tenantDbName = tenantDbName || null;
      req.tenantModels = tenantDbName ? getTenantModels(tenantDbName) : null;
      console.log(`[protect] [Step 4] Tenant DB Name: ${req.tenantDbName || 'None (Master/Default)'}, Models resolved: ${!!req.tenantModels}`);

      // Look up user: if super_admin, check Master AuthUser first
      let user = null;
      let matchedModel = null;
      console.log(`[protect] [Step 5] Looking up user in database (ID: ${decoded.id}, Role: ${decoded.role})...`);

      if (decoded.role === "super_admin") {
        const { AuthUser } = getMasterModels();
        user = await AuthUser.findById(decoded.id).select("-password");
        if (user) {
          matchedModel = "Master AuthUser";
        } else {
          user = await User.findById(decoded.id).select("-password -otp -otpExpiresAt");
          if (user) matchedModel = "Default User (super_admin fallback)";
        }
      } else {
        if (req.tenantModels?.User) {
          user = await req.tenantModels.User.findById(decoded.id).select("-password -otp -otpExpiresAt");
          if (user) matchedModel = "Tenant User";
        }
        if (!user) {
          const { AuthUser } = getMasterModels();
          user = await AuthUser.findById(decoded.id).select("-password");
          if (user) matchedModel = "Master AuthUser";
        }
        if (!user) {
          user = await User.findById(decoded.id).select("-password -otp -otpExpiresAt");
          if (user) matchedModel = "Default User";
        }
      }

      if (!user) {
        console.warn(`[protect] [Step 5] REJECTED (401): User not found in database for decoded ID: ${decoded.id}`);
        console.log("==================== [authMiddleware: protect] REJECTED ====================\n");
        return res.status(401).json({ success: false, message: "Not authorized, user not found" });
      }

      console.log(`[protect] [Step 5] User located via [${matchedModel}]:`, {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status,
      });

      // Check if individual user account is deactivated
      console.log(`[protect] [Step 6] Checking user account status: "${user.status}"...`);
      if (user.status === "inactive") {
        console.warn(`[protect] [Step 6] REJECTED (403): User account is deactivated (${user.email})`);
        console.log("==================== [authMiddleware: protect] DEACTIVATED ====================\n");
        return res.status(403).json({
          success: false,
          accountSuspended: true,
          message: "Your user account is deactivated. Please contact your administrator.",
        });
      }

      req.user = user;
      req.user.role = decoded.role || user.role;
      req.user.tenantDbName = tenantDbName;
      req.user.organizationId = decoded.organizationId || user.organizationId;
      req.user.isOrgOwner = decoded.isOrgOwner || user.isOrgOwner;

      // Super admin is exempt from tenant organization suspension checks
      console.log(`[protect] [Step 7] Checking organization subscription and suspension status (User role: ${req.user.role})...`);
      if (req.user.role !== "super_admin") {
        // Ensure organization is loaded
        if (!req.organization && req.user.organizationId) {
          try {
            console.log(`[protect] [Step 7] Re-fetching organization for ID: ${req.user.organizationId}...`);
            const { Organization } = getMasterModels();
            req.organization = await Organization.findById(req.user.organizationId);
          } catch (orgErr) {
            console.error("[protect] [Step 7] Error loading organization in protect:", orgErr.message);
          }
        }

        // If organization was deleted from DB for this user, reject with 401
        if (!req.organization && req.user.organizationId) {
          console.warn(`[protect] [Step 7] REJECTED (401): Organization workspace deleted for orgId: ${req.user.organizationId}`);
          console.log("==================== [authMiddleware: protect] ORG DELETED ====================\n");
          return res.status(401).json({
            success: false,
            organizationDeleted: true,
            message: "Your organization workspace no longer exists or was deleted. Please log in again.",
          });
        }

        if (req.organization) {
          console.log(`[protect] [Step 7] Organization status: "${req.organization.status}", subscriptionEndDate: ${req.organization.subscriptionEndDate}`);
          if (req.organization.status === "inactive" || req.organization.status === "suspended") {
            console.warn(`[protect] [Step 7] REJECTED (403): Organization status is ${req.organization.status}`);
            console.log("==================== [authMiddleware: protect] ORG SUSPENDED ====================\n");
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
              console.warn(`[protect] [Step 7] REJECTED (403): Organization subscription expired on ${req.organization.subscriptionEndDate}`);
              console.log("==================== [authMiddleware: protect] SUBSCRIPTION EXPIRED ====================\n");
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
      } else {
        console.log("[protect] [Step 7] User is super_admin. Exempt from organization checks.");
      }

      console.log(`[protect] [Step 8] SUCCESS: Authorized user "${req.user.name}" (${req.user.email}, role: ${req.user.role}) for ${req.method} ${req.originalUrl || req.url}`);
      console.log("==================== [authMiddleware: protect] ALLOWED ====================\n");
      return next();
    } catch (error) {
      if (error.name === "TokenExpiredError") {
        console.warn(`[protect] [ERROR] (401) Token expired at: ${error.expiredAt}`);
        console.log("==================== [authMiddleware: protect] TOKEN EXPIRED ====================\n");
        return res.status(401).json({ success: false, message: "Not authorized, token expired" });
      }
      console.error("[protect] [ERROR] Auth middleware token verification failed:", {
        name: error.name,
        message: error.message,
      });
      console.log("==================== [authMiddleware: protect] TOKEN INVALID ====================\n");
      return res.status(401).json({ success: false, message: "Not authorized, token invalid" });
    }
  }

  if (!token) {
    console.warn(`[protect] [Step 1] REJECTED (401): No token provided in headers for ${req.method} ${req.originalUrl || req.url}`);
    console.log("==================== [authMiddleware: protect] NO TOKEN ====================\n");
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
  const configuredApiKey = process.env.ADMIN_API_KEY && process.env.ADMIN_API_KEY.trim();

  let token = null;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  } else if (req.headers["x-access-token"]) {
    token = req.headers["x-access-token"];
  } else if (adminApiKey && (adminApiKey.startsWith("ey") || adminApiKey.startsWith("Bearer "))) {
    token = adminApiKey.replace(/^Bearer\s+/i, "").trim();
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

  // If no token, check if valid configured admin API key is provided (strictly reject default fallback)
  if (configuredApiKey && adminApiKey && adminApiKey === configuredApiKey) {
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
  const configuredApiKey = process.env.ADMIN_API_KEY && process.env.ADMIN_API_KEY.trim();
  if (configuredApiKey && adminApiKey && adminApiKey === configuredApiKey) {
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
