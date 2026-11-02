import mongoose from "mongoose";

const resolvedProspectSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    prospectKey: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    entityType: {
      type: String,
      enum: ["company", "person"],
      default: "company",
    },
    companyName: {
      type: String,
      required: true,
      trim: true,
    },
    personName: {
      type: String,
      trim: true,
      default: "",
    },
    title: {
      type: String,
      trim: true,
      default: "",
    },
    email: {
      type: String,
      trim: true,
      default: "",
    },
    phone: {
      type: String,
      trim: true,
      default: "",
    },
    website: {
      type: String,
      trim: true,
      default: "",
    },
    linkedin: {
      type: String,
      trim: true,
      default: "",
    },
    location: {
      type: String,
      trim: true,
      default: "",
    },
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    resolvedByName: {
      type: String,
      trim: true,
      default: "Team Member",
    },
    resolvedAt: {
      type: Date,
      default: Date.now,
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

// Unique resolution per organization & prospect key
resolvedProspectSchema.index(
  { organization: 1, prospectKey: 1 },
  { unique: true }
);

const ResolvedProspect = mongoose.models.ResolvedProspect || mongoose.model("ResolvedProspect", resolvedProspectSchema);

export default ResolvedProspect;

