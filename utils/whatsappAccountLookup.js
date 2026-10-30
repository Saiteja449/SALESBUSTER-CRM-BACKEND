/**
 * Finds an active WhatsApp line across tenant, master, and default DB models.
 * For sales reps, prefer their assigned line and then the organization line.
 */
export const findActiveWhatsAppAccount = async (
  models,
  organizationId,
  { isSalesRep = false, userId = null } = {}
) => {
  const accountModels = [...new Set(models.filter(Boolean))];
  const queries = isSalesRep
    ? [
        { organizationId, userId, status: { $in: ["connected", "syncing"] } },
        { organizationId, userId: null, status: { $in: ["connected", "syncing"] } },
      ]
    : [{ organizationId, status: { $in: ["connected", "syncing"] } }];

  for (const Model of accountModels) {
    for (const query of queries) {
      const account = await Model.findOne(query)
        .sort({ updatedAt: -1 })
        .lean();
      if (account) return account;
    }
  }
  return null;
};
