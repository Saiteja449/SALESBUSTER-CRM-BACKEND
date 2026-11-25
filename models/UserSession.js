import mongoose from "mongoose";

export const userSessionSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    email: {
      type: String,
      default: "",
      index: true,
    },
    name: {
      type: String,
      default: "",
    },
    role: {
      type: String,
      default: "sales person",
      index: true,
    },
    organizationId: {
      type: String,
      default: null,
      index: true,
    },
    organizationName: {
      type: String,
      default: "",
    },
    tenantDbName: {
      type: String,
      default: null,
    },
    platform: {
      type: String,
      enum: ["web", "mobile"],
      required: true,
      index: true,
    },
    userAgent: {
      type: String,
      default: "",
    },
    ip: {
      type: String,
      default: "",
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    lastActiveAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    revokedBy: {
      type: String,
      default: null,
    },
    revokeReason: {
      type: String,
      default: null,
    },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      expires: 0,
    },
  },
  {
    timestamps: true,
  }
);

userSessionSchema.index({ platform: 1, isActive: 1, lastActiveAt: -1 });
userSessionSchema.index({ userId: 1, platform: 1, isActive: 1 });

const UserSession =
  mongoose.models.UserSession ||
  mongoose.model("UserSession", userSessionSchema);

export default UserSession;
