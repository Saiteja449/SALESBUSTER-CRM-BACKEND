export const TRIAL_LIMITS = {
  durationDays: 3,
  maxSeats: 2,
  maxLeads: 50,
  maxAiMessagesPerDay: 20,
};

/**
 * Middleware to enforce 3-day free trial expiry and resource caps.
 * @param {"leads" | "seats" | "ai" | "general"} resource
 */
export const enforceTrialLimits = (resource = "general") => {
  return async (req, res, next) => {
    try {
      const org = req.organization;
      if (!org || !org.isTrial) {
        return next();
      }

      // 1. Check 3-day trial expiration
      if (org.trialEndsAt && new Date() > new Date(org.trialEndsAt)) {
        return res.status(403).json({
          success: false,
          code: "TRIAL_EXPIRED",
          message:
            "Your 3-day free trial has expired. Please upgrade to a paid plan or enable Autopay to continue.",
        });
      }

      // 2. Enforce per-resource caps during active trial
      if (resource === "leads" && req.tenantModels?.Lead) {
        const leadCount = await req.tenantModels.Lead.countDocuments({});
        if (leadCount >= TRIAL_LIMITS.maxLeads) {
          return res.status(403).json({
            success: false,
            code: "TRIAL_LIMIT_REACHED",
            message: `Free trial is limited to ${TRIAL_LIMITS.maxLeads} leads. Upgrade your plan to add more leads.`,
          });
        }
      }

      if (resource === "seats" && req.tenantModels?.User) {
        const userCount = await req.tenantModels.User.countDocuments({ status: { $ne: "deleted" } });
        if (userCount >= TRIAL_LIMITS.maxSeats) {
          return res.status(403).json({
            success: false,
            code: "TRIAL_LIMIT_REACHED",
            message: `Free trial includes ${TRIAL_LIMITS.maxSeats} seats total. Upgrade your plan to add more team members.`,
          });
        }
      }

      next();
    } catch (error) {
      console.error("[TrialLimitMiddleware] Error:", error.message);
      if (req.organization?.isTrial) {
        return res.status(500).json({ success: false, message: "Could not verify the trial workspace limits. Please retry." });
      }
      next();
    }
  };
};

export default enforceTrialLimits;
