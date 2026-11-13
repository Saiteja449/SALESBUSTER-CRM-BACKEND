import mongoose from "mongoose";

const canQuery = (model) => {
  if (!model) return false;
  if (model.prototype instanceof mongoose.Model || model.schema) {
    const readyState = model.db?.readyState ?? mongoose.connection?.readyState;
    return readyState === 1;
  }
  return true;
};

const HEX_24_REGEX = /^[a-f0-9]{24}$/i;

/**
 * Builds an in-memory owner directory by loading all users (all roles, active and inactive)
 * once per tool invocation to prevent N+1 queries.
 *
 * @param {Object} options
 * @param {Object} options.tenantModels - Map of Mongoose models for tenant
 * @returns {Promise<{ resolveOwner: (value: any) => { id: string|null, name: string, role: string, status: string }, allUsers: Array }>}
 */
export const buildOwnerDirectory = async ({ tenantModels = {} }) => {
  const UserModel = tenantModels?.User;
  const userById = new Map();
  const userByName = new Map();
  const userByEmail = new Map();
  const allUsers = [];

  if (canQuery(UserModel) && typeof UserModel.find === "function") {
    try {
      let q = UserModel.find({});
      if (typeof q?.select === "function") {
        q = q.select("name email phone role status");
      }
      let docs = typeof q?.lean === "function" ? await q.lean() : (typeof q?.then === "function" ? await q : q);
      const safeDocs = Array.isArray(docs) ? docs : [];
      for (const u of safeDocs) {
        const idStr = u._id ? u._id.toString() : (u.id ? String(u.id) : "");
        const name = (u.name || "").trim();
        const email = (u.email || "").trim().toLowerCase();
        const role = u.role || "sales person";
        const status = u.status || "active";
        const userObj = {
          _id: idStr,
          id: idStr,
          name: name || email || "Unknown team member",
          role,
          status,
        };
        allUsers.push(userObj);
        if (idStr) {
          userById.set(idStr.toLowerCase(), userObj);
        }
        if (name) {
          userByName.set(name.toLowerCase(), userObj);
        }
        if (email) {
          userByEmail.set(email, userObj);
        }
      }
    } catch (err) {
      console.warn("[OwnerResolver] Error loading users for directory:", err.message);
    }
  }

  /**
   * Resolves any owner representation (ObjectId, id string, name, email, null, or "Unassigned")
   * into a canonical { id, name, role, status } record.
   *
   * Invariants:
   * - Never returns a 24-character hex string as `name`.
   * - Unknown 24-hex strings (e.g. deleted/historical users) return `name: "Former/Unknown team member"`.
   * - "Unassigned", "", and null return `name: "Unassigned"`.
   * - Supports an optional secondary fallback value (e.g. salespersonName if salespersonId was unmapped).
   */
  const resolveSingle = (value) => {
    if (value === null || value === undefined) {
      return { id: null, name: "Unassigned", role: null, status: "unassigned" };
    }

    let rawStr = "";
    if (typeof value === "object") {
      if (value._id) {
        rawStr = String(value._id).trim();
      } else if (typeof value.toString === "function") {
        rawStr = value.toString().trim();
      }
    } else {
      rawStr = String(value).trim();
    }

    if (!rawStr || rawStr.toLowerCase() === "unassigned" || rawStr === "null" || rawStr === "undefined") {
      return { id: null, name: "Unassigned", role: null, status: "unassigned" };
    }

    const lower = rawStr.toLowerCase();

    // 1. Direct ID match
    if (userById.has(lower)) {
      return userById.get(lower);
    }

    // 2. Email match
    if (userByEmail.has(lower)) {
      return userByEmail.get(lower);
    }

    // 3. Exact name match
    if (userByName.has(lower)) {
      return userByName.get(lower);
    }

    // 4. Unknown 24-character hex string (e.g. deleted / historical user ObjectId)
    if (HEX_24_REGEX.test(rawStr)) {
      return {
        id: rawStr,
        name: "Former/Unknown team member",
        role: "unknown",
        status: "unknown",
      };
    }

    // 5. Unrecognized name string
    return {
      id: null,
      name: rawStr,
      role: "unknown",
      status: "unregistered",
    };
  };

  const resolveOwner = (value, secondaryValue) => {
    const res = resolveSingle(value);
    if (secondaryValue && (res.status === "unregistered" || res.name === "Former/Unknown team member" || !res.id)) {
      const secRes = resolveSingle(secondaryValue);
      if (secRes.id || (secRes.name && !HEX_24_REGEX.test(secRes.name) && secRes.name !== "Former/Unknown team member" && secRes.name !== "Unassigned")) {
        return secRes;
      }
    }
    return res;
  };

  return {
    resolveOwner,
    allUsers,
  };
};
