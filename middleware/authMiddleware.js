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

      // Look up user in tenant's User collection first
      let user = null;
      if (req.tenantModels?.User) {
        user = await req.tenantModels.User.findById(decoded.id).select("-password -otp -otpExpiresAt");
      }

      // If not found in tenant DB, check Master AuthUser
      if (!user) {
        const { AuthUser } = getMasterModels();
        user = await AuthUser.findById(decoded.id).select("-password");
      }

      // Fallback to default User model for legacy compatibility
      if (!user) {
        user = await User.findById(decoded.id).select("-password -otp -otpExpiresAt");
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
