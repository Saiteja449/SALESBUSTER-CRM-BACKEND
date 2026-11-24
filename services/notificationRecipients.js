import mongoose from "mongoose";

/** Resolve legacy salesperson names and IDs to valid Notification.targetUsers IDs. */
export const resolveNotificationUserIds = async (assignedTo, UserModel) => {
  const assignments = [];
  const flattenAssignments = (value) => {
    if (Array.isArray(value)) {
      value.forEach(flattenAssignments);
    } else if (value != null) {
      assignments.push(value);
    }
  };
  flattenAssignments(assignedTo);
  const resolvedIds = new Set();

  for (const assignment of assignments) {
    const value =
      assignment && typeof assignment === "object"
        ? assignment._id || assignment.id
        : assignment;
    if (value == null || value === "" || value === "Unassigned") continue;

    const normalized = String(value).trim();
    if (!normalized) continue;

    if (mongoose.Types.ObjectId.isValid(normalized)) {
      resolvedIds.add(normalized);
      continue;
    }

    if (!UserModel || typeof UserModel.findOne !== "function") continue;
    try {
      const query = UserModel.findOne({ name: normalized }).select("_id");
      const user = typeof query.lean === "function" ? await query.lean() : await query;
      if (user?._id && mongoose.Types.ObjectId.isValid(String(user._id))) {
        resolvedIds.add(String(user._id));
      }
    } catch (error) {
      console.warn(
        `[Notification] Could not resolve assigned user "${normalized}":`,
        error.message,
      );
    }
  }

  return [...resolvedIds];
};
