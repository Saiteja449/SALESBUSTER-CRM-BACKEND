import mongoose from "mongoose";

const providerUsageSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    provider: {
      type: String,
      required: true,
      trim: true,
    },
    requests: {
      type: Number,
      default: 0,
    },
    creditsUsed: {
      type: Number,
      default: 0,
    },
    date: {
      type: String, // YYYY-MM-DD
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

providerUsageSchema.index({ organizationId: 1, provider: 1, date: 1 }, { unique: true });

const ProviderUsage =
  mongoose.models.ProviderUsage || mongoose.model("ProviderUsage", providerUsageSchema);

export default ProviderUsage;
export { providerUsageSchema };

