import mongoose from "mongoose";

export const instagramAccountSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    instagramBusinessId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    facebookPageId: {
      type: String,
      required: true,
      index: true,
    },
    pageAccessTokenEncrypted: {
      type: String,
      required: true,
    },
    username: {
      type: String,
      required: true,
      trim: true,
    },
    name: {
      type: String,
      default: "",
    },
    profilePictureUrl: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["connected", "disconnected", "error"],
      default: "connected",
      index: true,
    },
    disconnectReason: {
      type: String,
      default: "",
    },
    connectedAt: {
      type: Date,
      default: Date.now,
    },
    lastActivityAt: {
      type: Date,
      default: Date.now,
    },
    settings: {
      enableAutoDM: {
        type: Boolean,
        default: true,
      },
      enableCommentToDM: {
        type: Boolean,
        default: true,
      },
      enableAIQualification: {
        type: Boolean,
        default: true,
      },
      aiPauseOnHumanReplyMinutes: {
        type: Number,
        default: 60,
      },
    },
  },
  { timestamps: true }
);

const InstagramAccount =
  mongoose.models.InstagramAccount ||
  mongoose.model("InstagramAccount", instagramAccountSchema);

export default InstagramAccount;
