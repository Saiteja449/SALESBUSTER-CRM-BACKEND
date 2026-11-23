import { getMasterModels, getTenantModels } from "../services/tenantManager.js";

/**
 * Extracts and guarantees tenant-scoped context and models for any controller or service.
 * Eliminates redundant boilerplate model resolution across all current and future modules.
 */
export const getTenantScope = (req) => {
  const masterModels = getMasterModels();

  const organization = req.organization || null;
  const organizationId =
    organization?._id?.toString() ||
    req.user?.organizationId?.toString() ||
    req.userTokenData?.organizationId?.toString() ||
    null;

  const tenantDbName =
    req.tenantDbName ||
    organization?.tenantDbName ||
    req.userTokenData?.tenantDbName ||
    null;

  const tenantModels = tenantDbName
    ? getTenantModels(tenantDbName)
    : req.tenantModels || getTenantModels(process.env.MASTER_DB_NAME || "salesbuster_master");

  const user = req.user || null;
  const userId =
    user?._id?.toString() ||
    user?.id?.toString() ||
    req.userTokenData?.id?.toString() ||
    req.userTokenData?._id?.toString() ||
    null;

  const role = user?.role || req.userTokenData?.role || "sales person";

  const isSalesPerson =
    role === "sales person" ||
    role === "Sales Representative" ||
    role === "sales_person";

  const isManager = role === "sales manager" || role === "admin";
  const isSuperAdmin = role === "super_admin";

  return {
    organization,
    organizationId,
    tenantDbName,
    tenantModels,
    masterModels,
    user,
    userId,
    role,
    isSalesPerson,
    isManager,
    isSuperAdmin,
  };
};

export default getTenantScope;
