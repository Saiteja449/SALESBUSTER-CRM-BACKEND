import mongoose from "mongoose";

const targetSearchSchema = new mongoose.Schema(
  {
    searchId: {
      type: String,
      default: () => `ti_${new mongoose.Types.ObjectId().toString()}`,
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    originalPrompt: {
      type: String,
      required: true,
      trim: true,
    },
    extractedFilters: {
      industry: { type: String, default: "All" },
      city: { type: String, default: "All" },
      state: { type: String, default: "" },
      country: { type: String, default: "India" },
      need: { type: String, default: "" },
      roles: { type: [String], default: [] },
      limit: { type: Number, default: 10 },
      searchType: { type: String, enum: ["all", "companies", "people"], default: "all" },
    },
    status: {
      type: String,
      enum: ["pending", "in_progress", "completed", "failed"],
      default: "completed",
    },
    totalDiscovered: {
      type: Number,
      default: 0,
    },
    totalMatched: {
      type: Number,
      default: 0,
    },
    searchProviders: {
      type: [String],
      default: [],
    },
    durationMs: {
      type: Number,
      default: 0,
    },
    isSaved: {
      type: Boolean,
      default: false,
      index: true,
    },
    savedName: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

targetSearchSchema.index({ organizationId: 1, createdAt: -1 });

const TargetSearch =
  mongoose.models.TargetSearch || mongoose.model("TargetSearch", targetSearchSchema);

export default TargetSearch;
export { targetSearchSchema };

