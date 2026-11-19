import express from "express";
import { receiveMobileAppLead } from "../controllers/mobileAppController.js";
import { protect } from "../middleware/authMiddleware.js";
import { getMasterModels, getTenantModels } from "../services/tenantManager.js";

const router = express.Router();

const authenticateLeadSubmission = async (req, res, next) => {
  const authorization = req.headers.authorization || "";
  const hasBearerToken = authorization.startsWith("Bearer ");
  const hasLegacyToken = Boolean(req.headers["x-access-token"] || req.body?.token);

  if (hasBearerToken || hasLegacyToken) {
    return protect(req, res, () => {
      if (!req.tenantDbName || !req.tenantModels || !req.user?.organizationId) {
        return res.status(403).json({
          success: false,
          message: "A tenant organization is required to submit a mobile lead.",
        });
      }
      next();
    });
  }

  const webhookKey = req.headers["x-webhook-secret"] || req.headers["x-api-key"];
  if (!webhookKey || typeof webhookKey !== "string") {
    return res.status(401).json({
      success: false,
      message: "A valid tenant token or organization webhook key is required.",
    });
  }

  try {
    const { Organization } = getMasterModels();
    const organization = await Organization.findOne({ webhookKey });
    if (!organization?.tenantDbName) {
      return res.status(401).json({
        success: false,
        message: "A valid tenant token or organization webhook key is required.",
      });
    }

    req.organization = organization;
    req.tenantDbName = organization.tenantDbName;
    req.tenantModels = getTenantModels(organization.tenantDbName);
    return next();
  } catch (error) {
    console.error("Mobile lead webhook authentication failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to authenticate mobile lead submission.",
    });
  }
};

router.post("/webhook", authenticateLeadSubmission, receiveMobileAppLead);

export default router;
