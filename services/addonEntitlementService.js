const ADDON_KEYS = {
  whatsappCampaigns: "whatsapp_campaigns",
  biAnalyst: "bi_analyst",
  targetIntelligence: "target_intelligence",
  instagramAutomation: "instagram_automation",
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

export default isAddonActive;
