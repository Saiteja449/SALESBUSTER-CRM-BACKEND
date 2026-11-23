import mongoose from "mongoose";

export const instagramMessageSchema = new mongoose.Schema(
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
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InstagramContact",
      required: true,
      index: true,
    },
    igsid: {
      type: String,
      required: true,
      index: true,
    },
    mid: {
      type: String, // Meta message ID
      required: true,
      unique: true,
      index: true,
    },
    direction: {
      type: String,
      enum: ["incoming", "outgoing"],
      required: true,
      index: true,
    },
    senderType: {
      type: String,
      enum: ["user", "agent", "ai_bot", "auto_dm"],
      default: "user",
    },
    text: {
      type: String,
      default: "",
    },
    mediaType: {
      type: String,
      enum: ["none", "image", "video", "audio", "share", "story_mention"],
      default: "none",
    },
    mediaUrl: {
      type: String,
      default: "",
    },
    triggerSource: {
      type: String,
      enum: ["direct_message", "comment_to_dm", "story_reply", "story_mention"],
      default: "direct_message",
    },
    ruleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InstagramAutomationRule",
      default: null,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true }
);

// Compound indexes for rapid thread lookups and trigger source querying
instagramMessageSchema.index({ contactId: 1, timestamp: -1 });
instagramMessageSchema.index({ organizationId: 1, triggerSource: 1, timestamp: -1 });

const InstagramMessage =
  mongoose.models.InstagramMessage ||
  mongoose.model("InstagramMessage", instagramMessageSchema);

export default InstagramMessage;
