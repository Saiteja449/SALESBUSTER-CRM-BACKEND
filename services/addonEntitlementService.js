const ADDON_KEYS = {
  whatsappCampaigns: "whatsapp_campaigns",
  biAnalyst: "bi_analyst",
  targetIntelligence: "target_intelligence",
  instagramAutomation: "instagram_automation",
  marketingRoi: "marketing_roi",
};

/** Legacy boolean grants remain active unless a dated entitlement exists. */
export const isAddonActive = (org, addonKey, now = new Date()) => {
  const addonId = ADDON_KEYS[addonKey] || addonKey;
  const entitlement = Array.isArray(org?.addonEntitlements)
    ? [...org.addonEntitlements].reverse().find((item) => item.addonId === addonId)
    : null;
  if (entitlement) return Boolean((!entitlement.startsAt || new Date(entitlement.startsAt) <= now) && entitlement.expiresAt && new Date(entitlement.expiresAt) > now);
  return Boolean(org?.addons?.[addonKey] ||
    (addonKey === "whatsappCampaigns" && org?.hasWhatsAppCampaignsAddon) ||
    (addonKey === "instagramAutomation" && org?.hasInstagramAddon));
};

/**
 * Returns true only when the organization is active and its subscription
 * (trialEndsAt for trials, subscriptionEndDate for paid plans) has not expired.
 */
export const isOrganizationSubscriptionActive = (org, now = new Date()) => {
  if (!org) return false;
  const status = String(org.status || "").toLowerCase();
  if (status !== "active" || org.isExpired) return false;

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const expiryRaw = org.isTrial
    ? org.trialEndsAt ?? org.subscriptionEndDate
    : org.subscriptionEndDate;
  if (!expiryRaw) return false;

  const expiryMs = new Date(expiryRaw).getTime();
  return !Number.isNaN(expiryMs) && expiryMs > nowMs;
};

export default isAddonActive;
