import mongoose from "mongoose";

export const appReleaseSchema = new mongoose.Schema(
  {
    fileName: {
      type: String,
      required: true,
      trim: true,
    },
    originalName: {
      type: String,
      required: true,
      trim: true,
    },
    filePath: {
      type: String,
      required: true,
    },
    fileUrl: {
      type: String,
      required: true,
    },
    fileSize: {
      type: Number, // File size in bytes
      required: true,
    },
    version: {
      type: String,
      default: "1.0.0",
      trim: true,
    },
    versionCode: {
      type: Number,
      default: 1,
    },
    minSupportedVersion: {
      type: String,
      default: "1.0.0",
      trim: true,
    },
    releaseNotes: {
      type: String,
      default: "",
    },
    mimeType: {
      type: String,
      default: "application/vnd.android.package-archive",
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AuthUser",
      default: null,
    },
    uploadedByName: {
      type: String,
      default: "Super Admin",
    },
  },
  {
    timestamps: true,
  }
);

const AppRelease =
  mongoose.models.AppRelease || mongoose.model("AppRelease", appReleaseSchema);

export default AppRelease;
