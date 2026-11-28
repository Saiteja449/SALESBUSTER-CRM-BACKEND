import { getMasterModels } from "../services/tenantManager.js";
import { TRIAL_LIMITS } from "../middleware/trialLimitMiddleware.js";

/**
 * POST /api/payment/cashfree/trial/start
 * Activates a 3-day free trial with limited features for the authenticated organization.
 */
export const startFreeTrialHandler = async (req, res) => {
  try {
    const orgId = req.organization?._id || req.user?.organizationId;
    if (!orgId) {
      return res.status(400).json({
        success: false,
        message: "Organization context is required to start a free trial.",
      });
    }

    const { Organization } = getMasterModels();
    const org = await Organization.findById(orgId);
    if (!org) {
      return res.status(404).json({
        success: false,
        message: "Organization not found.",
      });
    }

    if (org.trialStartDate) {
      return res.status(400).json({
        success: false,
        code: "TRIAL_ALREADY_USED",
        message: "This organization has already used its 3-day free trial.",
      });
    }

    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + TRIAL_LIMITS.durationDays * 24 * 60 * 60 * 1000);

    org.isTrial = true;
    org.trialStartDate = now;
    org.trialEndsAt = trialEndsAt;
    org.trialConverted = false;
    org.accountType = "crm";
    org.seats = TRIAL_LIMITS.maxSeats;
    org.subscriptionStartDate = now;
    org.subscriptionEndDate = trialEndsAt;
    org.status = "active";
    await org.save();

    return res.status(200).json({
      success: true,
      message: "3-day free trial activated with limited features.",
      data: {
        isTrial: true,
        trialStartDate: now,
        trialEndsAt,
        seats: org.seats,
        limits: TRIAL_LIMITS,
      },
    });
  } catch (error) {
    console.error("[Trial] startFreeTrialHandler error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to activate 3-day free trial.",
    });
  }
};
