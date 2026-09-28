/**
 * Middleware to verify that the active organization has the Telephony Add-On enabled.
 */
export const requireTelephonyAddon = (req, res, next) => {
  // Super Admin bypass
  if (req.user?.role === "super_admin" || req.userTokenData?.role === "super_admin") {
    return next();
  }

  const telephony = req.organization?.telephony;
  if (!telephony?.isAddonEnabled) {
    return res.status(403).json({
      success: false,
      code: "TELEPHONY_ADDON_REQUIRED",
      message:
        "Cloud Telephony is an optional add-on feature that is not currently enabled for your organization. Please contact your administrator.",
    });
  }

  next();
};
