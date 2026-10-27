import mongoose from "mongoose";

export const waContactSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WAAccount",
      required: true,
      index: true,
    },
    waId: {
      type: String, // Phone in international format (e.g. 919876543210)
      required: true,
      trim: true,
    },
    name: {
      type: String,
      default: "",
      trim: true,
    },
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      default: null,
      index: true,
    },
    syncAction: {
      type: String,
      enum: ["upsert", "delete"],
      default: "upsert",
    },
    lastSyncedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// Unique compound index on accountId + waId
waContactSchema.index({ accountId: 1, waId: 1 }, { unique: true });

const WAContact = mongoose.models.WAContact || mongoose.model("WAContact", waContactSchema);
export default WAContact;
