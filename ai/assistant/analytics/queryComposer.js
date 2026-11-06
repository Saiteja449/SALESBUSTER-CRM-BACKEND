/**
 * Safe MongoDB Query Composition Utility
 * 
 * Prevents key collision (especially for $or, $and, and identical field names)
 * when composing multiple independent query filters.
 */

export const composeMongoQuery = (...clauses) => {
  const flattened = [];

  for (const c of clauses) {
    if (!c || typeof c !== "object" || Object.keys(c).length === 0) continue;
    if (Array.isArray(c.$and)) {
      flattened.push(
        ...c.$and.filter((sub) => sub && typeof sub === "object" && Object.keys(sub).length > 0)
      );
    } else {
      flattened.push(c);
    }
  }

  if (flattened.length === 0) return {};
  if (flattened.length === 1) return flattened[0];
  return { $and: flattened };
};

