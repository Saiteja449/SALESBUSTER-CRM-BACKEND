import mongoose from "mongoose";

export const instagramContactSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InstagramAccount",
      required: true,
      index: true,
    },
    igsid: {
      type: String, // Instagram Scoped User ID
      required: true,
      trim: true,
    },
    username: {
      type: String,
      default: "",
      trim: true,
    },
    name: {
      type: String,
      default: "",
      trim: true,
    },
    profilePic: {
      type: String,
      default: "",
    },
    phone: {
      type: String,
      default: "",
      trim: true,
    },
    email: {
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
    aiPausedUntil: {
      type: Date,
      default: null,
    },
    qualificationState: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    lastInteractedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true }
);

// Unique compound index on accountId + igsid
instagramContactSchema.index({ accountId: 1, igsid: 1 }, { unique: true });

const InstagramContact =
  mongoose.models.InstagramContact ||
  mongoose.model("InstagramContact", instagramContactSchema);

export default InstagramContact;
