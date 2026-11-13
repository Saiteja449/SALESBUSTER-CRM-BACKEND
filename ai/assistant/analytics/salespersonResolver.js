import mongoose from "mongoose";
import { escapeRegex } from "../securityUtils.js";

/**
 * Checks if a Mongoose model can be queried (handles disconnected states in test mocks).
 */
const canQuery = (model) => {
  if (!model) return false;
  if (model.prototype instanceof mongoose.Model || model.schema) {
    const readyState = model.db?.readyState ?? mongoose.connection?.readyState;
    return readyState === 1;
  }
  return true;
};

/**
 * Determines whether a user's role represents a frontline sales representative
 * (e.g. sales person, sales representative, telecaller, agent)
 * rather than a pure management or administrative role.
 */
export const isSalesRole = (role) => {
  if (!role) return true;
  const r = String(role).toLowerCase().trim();
  if (r.includes("manager") || r.includes("admin")) return false;
  return true;
};

/**
 * Checks if a manager or administrator has any historical sales assignments or logged calls.
 */
const hasHistoricalSalesActivity = async ({ tenantModels, user }) => {
  const LeadModel = tenantModels.Lead;
  const CallRecordModel = tenantModels.CallRecord;
  const AnalyticsModel = tenantModels.TelecallerAnalytics;
  const uid = user._id?.toString() || user.id;
  const uName = user.name;

  if (canQuery(LeadModel)) {
    try {
      const q = [{ assignedTo: uid }];
      if (user._id && mongoose.Types.ObjectId.isValid(user._id)) {
        q.push({ assignedTo: user._id });
      }
      if (uName) q.push({ assignedTo: uName });
      const count = typeof LeadModel.countDocuments === "function"
        ? await LeadModel.countDocuments({ $or: q })
        : 0;
      if (count > 0) return true;
    } catch (_) {}
  }

  if (canQuery(CallRecordModel)) {
    try {
      const q = [{ salespersonId: uid }];
      if (user._id && mongoose.Types.ObjectId.isValid(user._id)) {
        q.push({ salespersonId: user._id });
      }
      if (uName) q.push({ salespersonName: uName });
      const count = typeof CallRecordModel.countDocuments === "function"
        ? await CallRecordModel.countDocuments({ $or: q })
        : 0;
      if (count > 0) return true;
    } catch (_) {}
  }

  if (canQuery(AnalyticsModel)) {
    try {
      const q = [{ salespersonId: uid }];
      if (user._id && mongoose.Types.ObjectId.isValid(user._id)) {
        q.push({ salespersonId: user._id });
      }
      if (uName) q.push({ salesperson: uName });
      const count = typeof AnalyticsModel.countDocuments === "function"
        ? await AnalyticsModel.countDocuments({ $or: q })
        : 0;
      if (count > 0) return true;
    } catch (_) {}
  }

  return false;
};

/**
 * Resolves a salesperson input (ID, exact name, partial name, email, or unassigned)
 * into a canonical salesperson record with query filters.
 *
 * Enforces:
 * - Case-insensitivity
 * - Handles both active and inactive/historical representatives
 * - Prevents misidentifying pure managers and administrators as salespeople
 * - Detects ambiguity (multiple matching reps) and refuses to guess silently
 * - Builds robust match queries for Lead.assignedTo, CallRecord, and TelecallerAnalytics
 */
export const resolveSalesperson = async ({
  tenantModels = {},
  identifier,
  organizationId = null,
}) => {
  if (!identifier || typeof identifier !== "string" || !identifier.trim()) {
    return {
      resolved: true,
      all: true,
      searchTerm: "",
      leadAssignedFilter: {},
      callSalespersonFilter: {},
      analyticsSalespersonFilter: {},
    };
  }

  const raw = identifier.trim();
  const lower = raw.toLowerCase();

  // 1. Explicit unassigned or unknown check
  if (["unassigned", "unknown", "none", "no one", "not assigned"].includes(lower)) {
    return {
      resolved: true,
      isUnassigned: true,
      canonicalId: null,
      canonicalName: "Unassigned",
      searchTerm: raw,
      leadAssignedFilter: {
        $or: [
          { assignedTo: "Unassigned" },
          { assignedTo: "unassigned" },
          { assignedTo: null },
          { assignedTo: "" },
          { assignedTo: { $exists: false } },
        ],
      },
      callSalespersonFilter: {
        $or: [
          { salespersonId: null },
          { salespersonId: "" },
          { salespersonName: "Unassigned" },
          { salespersonName: "" },
          { salespersonName: null },
        ],
      },
      analyticsSalespersonFilter: {
        $or: [
          { salespersonId: null },
          { salesperson: "Unassigned" },
          { salesperson: "" },
          { salesperson: null },
        ],
      },
    };
  }

  const UserModel = tenantModels.User;

  // 2. Query UserModel (both active and inactive)
  if (canQuery(UserModel)) {
    try {
      let matchedUsers = [];

      // 2a. ObjectId direct match
      if (mongoose.Types.ObjectId.isValid(raw)) {
        const exactUser = await UserModel.findById(raw).lean();
        if (exactUser) {
          matchedUsers = [exactUser];
        }
      }

      // 2b. Email exact match
      if (matchedUsers.length === 0 && raw.includes("@")) {
        const emailRegex = new RegExp(`^${escapeRegex(raw)}$`, "i");
        const exactUser = await UserModel.findOne({ email: emailRegex }).lean();
        if (exactUser) {
          matchedUsers = [exactUser];
        }
      }

      // 2c. Exact full name match (case-insensitive)
      if (matchedUsers.length === 0) {
        const exactNameRegex = new RegExp(`^${escapeRegex(raw)}$`, "i");
        const exactMatches = await UserModel.find({ name: exactNameRegex }).lean();
        if (exactMatches.length > 0) {
          matchedUsers = exactMatches;
        }
      }

      // 2d. Partial name matches
      if (matchedUsers.length === 0) {
        const partialRegex = new RegExp(escapeRegex(raw), "i");
        const partialMatches = await UserModel.find({
          $or: [{ name: partialRegex }, { email: partialRegex }],
        }).lean();
        if (partialMatches.length > 0) {
          // Check for exact word match
          const wordRegex = new RegExp(`\\b${escapeRegex(raw)}\\b`, "i");
          const wordMatches = partialMatches.filter((u) => u.name && wordRegex.test(u.name));
          matchedUsers = wordMatches.length === 1 ? wordMatches : partialMatches;
        }
      }

      if (matchedUsers.length > 0) {
        // Evaluate roles vs historical sales activity
        const validSalesCandidates = [];
        const nonSalesCandidates = [];

        for (const user of matchedUsers) {
          if (isSalesRole(user.role)) {
            validSalesCandidates.push(user);
          } else {
            const hasActivity = await hasHistoricalSalesActivity({ tenantModels, user });
            if (hasActivity) {
              validSalesCandidates.push(user);
            } else {
              nonSalesCandidates.push(user);
            }
          }
        }

        if (validSalesCandidates.length === 1) {
          return buildCanonicalResult(validSalesCandidates[0]);
        }

        if (validSalesCandidates.length > 1) {
          return {
            resolved: false,
            isAmbiguous: true,
            searchTerm: raw,
            matches: validSalesCandidates.map(formatUserPreview),
            message: `Multiple salespeople match "${raw}": ${validSalesCandidates.map((u) => `${u.name} (${u.role})`).join(", ")}. Please specify which salesperson you mean.`,
          };
        }

        // Only non-sales candidates were found (e.g. manager / administrator with no sales activity)
        if (nonSalesCandidates.length > 0) {
          const user = nonSalesCandidates[0];
          return {
            resolved: false,
            notFound: true,
            isManagerOrAdmin: true,
            searchTerm: raw,
            message: `User "${user.name || raw}" is registered as a ${user.role}, not a sales representative, and has no recorded sales or call activity.`,
          };
        }
      }
    } catch (userErr) {
      console.warn("[SalespersonResolver] Error querying UserModel:", userErr.message);
    }
  }

  // 3. Fallback: Check historical Lead and Analytics records for matching names
  const fallbackNames = new Set();
  const LeadModel = tenantModels.Lead;
  const AnalyticsModel = tenantModels.TelecallerAnalytics;
  const CallRecordModel = tenantModels.CallRecord;

  if (canQuery(LeadModel)) {
    try {
      const distinctAssigned = await LeadModel.distinct("assignedTo");
      for (const val of distinctAssigned) {
        if (typeof val === "string" && val.toLowerCase().includes(lower) && !["unassigned", ""].includes(val.toLowerCase())) {
          fallbackNames.add(val);
        }
      }
    } catch (_) {}
  }

  if (canQuery(AnalyticsModel)) {
    try {
      const distinctSalespersons = await AnalyticsModel.distinct("salesperson");
      for (const val of distinctSalespersons) {
        if (typeof val === "string" && val.toLowerCase().includes(lower)) {
          fallbackNames.add(val);
        }
      }
    } catch (_) {}
  }

  if (canQuery(CallRecordModel)) {
    try {
      const distinctCallReps = await CallRecordModel.distinct("salespersonName");
      for (const val of distinctCallReps) {
        if (typeof val === "string" && val.toLowerCase().includes(lower) && val.toLowerCase() !== "unassigned") {
          fallbackNames.add(val);
        }
      }
    } catch (_) {}
  }

  const nameList = Array.from(fallbackNames);
  if (nameList.length === 1) {
    const historicalName = nameList[0];
    const nameRegex = new RegExp(`^${escapeRegex(historicalName)}$`, "i");
    return {
      resolved: true,
      canonicalId: null,
      canonicalName: historicalName,
      searchTerm: raw,
      isHistoricalOnly: true,
      leadAssignedFilter: {
        $or: [{ assignedTo: nameRegex }, { assignedTo: historicalName }],
      },
      callSalespersonFilter: {
        $or: [{ salespersonName: nameRegex }, { salespersonName: historicalName }],
      },
      analyticsSalespersonFilter: {
        $or: [{ salesperson: nameRegex }, { salesperson: historicalName }],
      },
    };
  }

  if (nameList.length > 1) {
    return {
      resolved: false,
      isAmbiguous: true,
      searchTerm: raw,
      matches: nameList.map((n) => ({ name: n })),
      message: `Multiple historical salespeople match "${raw}": ${nameList.join(", ")}. Please clarify which one you mean.`,
    };
  }

  // Not found in any collection
  return {
    resolved: false,
    notFound: true,
    searchTerm: raw,
    message: `Salesperson "${raw}" was not found in active or historical records.`,
  };
};

/**
 * Builds canonical query criteria from a found User document
 */
const buildCanonicalResult = (user) => {
  const uidStr = user._id ? user._id.toString() : user.id;
  const uName = user.name || user.email;
  const nameRegex = new RegExp(`^${escapeRegex(uName)}$`, "i");

  const leadFilterConditions = [];
  if (user._id) leadFilterConditions.push({ assignedTo: user._id });
  if (uidStr) leadFilterConditions.push({ assignedTo: uidStr });
  if (user.name) {
    leadFilterConditions.push({ assignedTo: nameRegex });
    leadFilterConditions.push({ assignedTo: user.name });
  }

  const callFilterConditions = [];
  if (user._id) callFilterConditions.push({ salespersonId: user._id });
  if (uidStr) callFilterConditions.push({ salespersonId: uidStr });
  if (user.name) {
    callFilterConditions.push({ salespersonName: nameRegex });
    callFilterConditions.push({ salespersonName: user.name });
  }

  const analyticsFilterConditions = [];
  if (user._id) analyticsFilterConditions.push({ salespersonId: user._id });
  if (uidStr) analyticsFilterConditions.push({ salespersonId: uidStr });
  if (user.name) {
    analyticsFilterConditions.push({ salesperson: nameRegex });
    analyticsFilterConditions.push({ salesperson: user.name });
  }

  return {
    resolved: true,
    canonicalId: uidStr,
    canonicalName: uName,
    user: formatUserPreview(user),
    leadAssignedFilter: { $or: leadFilterConditions },
    callSalespersonFilter: { $or: callFilterConditions },
    analyticsSalespersonFilter: { $or: analyticsFilterConditions },
  };
};

const formatUserPreview = (u) => ({
  id: u._id?.toString() || u.id,
  name: u.name || "",
  email: u.email || "",
  role: u.role || "sales person",
  status: u.status || "active",
  phone: u.phone || "",
});

/**
 * Lists all frontline salespeople across the organization (both active and inactive).
 * Excludes managers and administrators by default.
 */
export const listAllSalespeople = async ({ tenantModels, includeManagers = false }) => {
  const UserModel = tenantModels.User;
  if (!canQuery(UserModel)) return [];

  const allUsers = await UserModel.find({})
    .select("name email role status phone")
    .sort({ status: 1, name: 1 })
    .lean();

  if (includeManagers) return allUsers;
  return allUsers.filter((u) => isSalesRole(u.role));
};
