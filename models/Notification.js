import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      default: "general", // general, alert, system, lead_update
    },
    targetRoles: {
      type: [String],
      default: [], // e.g., ["sales manager", "sales person"]
    },
    targetUsers: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "User",
      default: [], // specific users who should see this
    },
    readBy: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "User",
      default: [],
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

notificationSchema.index({ createdAt: -1 });
notificationSchema.index({ targetUsers: 1, createdAt: -1 });
notificationSchema.index({ targetRoles: 1, createdAt: -1 });

const Notification = mongoose.model("Notification", notificationSchema);

export default Notification;
