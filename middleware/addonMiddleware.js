import { getMasterModels } from "../services/tenantManager.js";

/**
 * Middleware to require a specific Organization Add-on.
 * Super Admins bypass add-on checks.
 *
 * @param {string} addonKey - e.g. "whatsappCampaigns" or "biAnalyst"
 */
export const requireAddon = (addonKey) => async (req, res, next) => {
  try {
    // 1. Super Admins bypass all add-on gates
    if (
      req.user?.role === "super_admin" ||
      req.user?.role === "Super Admin" ||
      req.authType === "super_admin"
    ) {
      return next();
    }

    // 2. Resolve organization if not already attached to req
    let org = req.organization;
    if (!org) {
      const { Organization: MasterOrg } = getMasterModels();
      const orgId = req.user?.organizationId || req.organizationId;
      if (orgId) {
        org = await MasterOrg.findById(orgId);
      } else {
        const dbName = req.tenantDbName || req.tenantModels?.Lead?.db?.name;
        if (dbName && dbName !== "test" && dbName !== "salesbuster_master") {
          org = await MasterOrg.findOne({ tenantDbName: dbName });
        }
      }
      if (org) {
        req.organization = org;
      }
    }

    if (!org) {
      return res.status(403).json({
        success: false,
        message: "Organization context could not be resolved for add-on authorization.",
      });
    }

    // 3. Verify add-on status
    const isAddonActive = Boolean(org.addons?.[addonKey]);
    if (!isAddonActive) {
      const addonLabels = {
        whatsappCampaigns: "WhatsApp Campaigns",
        biAnalyst: "BI Analyst",
        targetIntelligence: "AI Target Intelligence",
      };
      const label = addonLabels[addonKey] || addonKey;
      return res.status(403).json({
        success: false,
        addonRequired: addonKey,
        message: `The ${label} add-on is not active for your organization. Please contact your administrator to enable this feature.`,
      });
    }

    next();
  } catch (error) {
    console.error(`[requireAddon] Error verifying addon ${addonKey}:`, error);
    return res.status(500).json({
      success: false,
      message: "Internal error checking organization add-on status.",
    });
  }
};
