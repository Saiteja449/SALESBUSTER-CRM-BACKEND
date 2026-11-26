import mongoose from "mongoose";

export const apiActivityLogSchema = new mongoose.Schema(
  {
    method: {
      type: String,
      default: "GET",
      index: true,
    },
    path: {
      type: String,
      required: true,
      index: true,
    },
    statusCode: {
      type: Number,
      default: 200,
      index: true,
    },
    durationMs: {
      type: Number,
      default: 0,
    },
    level: {
      type: String,
      enum: ["info", "warn", "error", "crash"],
      default: "info",
      index: true,
    },
    category: {
      type: String,
      enum: ["api", "auth", "activity", "bug", "server_crash"],
      default: "api",
      index: true,
    },
    message: {
      type: String,
      default: "",
    },
    errorName: {
      type: String,
      default: "",
    },
    stack: {
      type: String,
      default: "",
    },
    userId: {
      type: String,
      default: null,
      index: true,
    },
    userEmail: {
      type: String,
      default: null,
      index: true,
    },
    userRole: {
      type: String,
      default: null,
    },
    organizationId: {
      type: String,
      default: null,
      index: true,
    },
    platform: {
      type: String,
      enum: ["web", "mobile", "admin", "unknown"],
      default: "unknown",
      index: true,
    },
    ip: {
      type: String,
      default: "",
    },
    userAgent: {
      type: String,
      default: "",
    },
    requestBodySummary: {
      type: String,
      default: "",
    },
    resolutionStatus: {
      type: String,
      enum: ["unsolved", "solved"],
      default: "unsolved",
      index: true,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    resolvedBy: {
      type: String,
      default: null,
    },
    resolutionNote: {
      type: String,
      default: "",
    },
    createdAt: {
      type: Date,
      default: Date.now,
      expires: 2592000, // 30 days retention
    },
  },
  {
    versionKey: false,
  }
);

apiActivityLogSchema.index({ createdAt: -1, level: 1 });
apiActivityLogSchema.index({ createdAt: -1, category: 1 });

const ApiActivityLog =
  mongoose.models.ApiActivityLog ||
  mongoose.model("ApiActivityLog", apiActivityLogSchema);

export default ApiActivityLog;
