import mongoose from "mongoose";

const targetCompanySchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    searchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TargetSearch",
      index: true,
    },
    prospectKey: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    companyName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    normalizedDomain: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    website: {
      type: String,
      trim: true,
      default: "",
    },
    industry: {
      type: String,
      trim: true,
      default: "Commercial Enterprise",
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    location: {
      locality: { type: String, default: "" },
      city: { type: String, default: "" },
      state: { type: String, default: "" },
      country: { type: String, default: "India" },
      raw: { type: String, default: "" },
    },
    founders: [
      {
        name: { type: String, trim: true, default: "" },
        title: { type: String, trim: true, default: "" },
        designation: { type: String, trim: true, default: "" },
        email: { type: String, trim: true, default: "" },
        phone: { type: String, trim: true, default: "" },
        verificationStatus: {
          type: String,
          enum: ["Verified", "Publicly Listed", "Unverified", "Invalid", "Not Found"],
          default: "Unverified",
        },
      },
    ],
    contact: {
      businessPhone: { type: String, trim: true, default: "" },
      phoneType: {
        type: String,
        enum: ["mobile", "landline", "corporate", "none"],
        default: "none",
      },
      phoneVerificationStatus: {
        type: String,
        enum: ["Verified", "Publicly Listed", "Unverified", "Invalid", "Not Found"],
        default: "Unverified",
      },
      businessEmail: { type: String, trim: true, default: "" },
      emailType: {
        type: String,
        enum: ["direct", "corporate", "role_based", "none"],
        default: "none",
      },
      emailVerificationStatus: {
        type: String,
        enum: ["Verified", "Publicly Listed", "Unverified", "Invalid", "Not Found"],
        default: "Unverified",
      },
      contactPage: { type: String, trim: true, default: "" },
    },
    socialLinks: {
      linkedin: { type: String, trim: true, default: "" },
      twitter: { type: String, trim: true, default: "" },
      facebook: { type: String, trim: true, default: "" },
      instagram: { type: String, trim: true, default: "" },
      whatsapp: { type: String, trim: true, default: "" },
      youtube: { type: String, trim: true, default: "" },
      github: { type: String, trim: true, default: "" },
    },
    technologies: {
      type: [String],
      default: [],
    },
    sources: [
      {
        url: { type: String, default: "" },
        field: { type: String, default: "" },
        accessedAt: { type: Date, default: Date.now },
      },
    ],
    confidenceScore: {
      type: Number,
      default: 80,
      min: 0,
      max: 100,
    },
    enrichmentStatus: {
      type: String,
      enum: ["discovered", "enriching", "enriched", "failed"],
      default: "discovered",
    },
    isResolved: {
      type: Boolean,
      default: false,
      index: true,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    resolvedByName: {
      type: String,
      default: "",
    },
    resolvedNotes: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

targetCompanySchema.index({ organizationId: 1, normalizedDomain: 1 });
targetCompanySchema.index({ organizationId: 1, prospectKey: 1 });

const TargetCompany =
  mongoose.models.TargetCompany || mongoose.model("TargetCompany", targetCompanySchema);

export default TargetCompany;
export { targetCompanySchema };

