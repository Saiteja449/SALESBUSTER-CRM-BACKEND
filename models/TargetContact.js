import mongoose from "mongoose";

const targetContactSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TargetCompany",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    designation: {
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
    sources: {
      type: [String],
      default: [],
    },
    verificationStatus: {
      type: String,
      enum: ["Verified", "Publicly Listed", "Unverified", "Invalid", "Not Found"],
      default: "Unverified",
    },
    emailVerification: {
      isValidFormat: { type: Boolean, default: false },
      mxValid: { type: Boolean, default: false },
      isRoleBased: { type: Boolean, default: false },
      verifiedAt: { type: Date, default: null },
    },
    phoneVerification: {
      isValidFormat: { type: Boolean, default: false },
      phoneType: { type: String, default: "none" },
      normalized: { type: String, default: "" },
      verifiedAt: { type: Date, default: null },
    },
  },
  {
    timestamps: true,
  }
);

targetContactSchema.index({ organizationId: 1, companyId: 1 });

const TargetContact =
  mongoose.models.TargetContact || mongoose.model("TargetContact", targetContactSchema);

export default TargetContact;
export { targetContactSchema };

