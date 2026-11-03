import mongoose from "mongoose";

const targetListSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    companies: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "TargetCompany",
      },
    ],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
  }
);

targetListSchema.index({ organizationId: 1, name: 1 });

const TargetList =
  mongoose.models.TargetList || mongoose.model("TargetList", targetListSchema);

export default TargetList;
export { targetListSchema };

