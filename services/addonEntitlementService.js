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

/**
 * Returns total usable sales-rep seats: base plan seats plus any active
 * (non-expired) extra-seat entitlements.
 */
export const getEffectiveOrganizationSeats = (org, now = new Date()) => {
  if (!org) return 1;
  const baseSeats = Math.max(1, Number(org.seats) || 1);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const entitlements = Array.isArray(org.seatEntitlements)
    ? org.seatEntitlements
    : [];

  const activeExtraSeats = entitlements.reduce((sum, item) => {
    const qty = Number(item?.quantity) || 0;
    if (qty <= 0 || !item?.expiresAt) return sum;
    const startsMs = item.startsAt ? new Date(item.startsAt).getTime() : 0;
    const expiresMs = new Date(item.expiresAt).getTime();
    if (Number.isNaN(expiresMs) || expiresMs <= nowMs) return sum;
    if (item.startsAt && (Number.isNaN(startsMs) || startsMs > nowMs)) {
      return sum;
    }
    return sum + qty;
  }, 0);

  return baseSeats + activeExtraSeats;
};

export default isAddonActive;
