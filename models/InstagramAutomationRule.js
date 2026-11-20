import mongoose from "mongoose";

export const instagramAutomationRuleSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    triggerType: {
      type: String,
      enum: ["comment_to_dm", "dm_keyword", "story_reply", "story_mention"],
      required: true,
      index: true,
    },
    postScope: {
      type: String,
      enum: ["all_posts", "specific_post"],
      default: "all_posts",
    },
    targetPostId: {
      type: String,
      default: "",
      trim: true,
    },
    keywords: [
      {
        type: String,
        trim: true,
        lowercase: true,
      },
    ],
    matchType: {
      type: String,
      enum: ["exact", "contains"],
      default: "contains",
    },
    publicCommentReplies: [
      {
        type: String,
        trim: true,
      },
    ],
    dmReplyType: {
      type: String,
      enum: ["text", "button_card", "ai_lead_flow"],
      default: "text",
    },
    dmMessageTemplate: {
      type: String,
      default: "",
      trim: true,
    },
    callToAction: {
      buttonTitle: { type: String, default: "" },
      buttonUrl: { type: String, default: "" },
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    timesTriggered: {
      type: Number,
      default: 0,
    },
    leadsGenerated: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

const InstagramAutomationRule =
  mongoose.models.InstagramAutomationRule ||
  mongoose.model("InstagramAutomationRule", instagramAutomationRuleSchema);

export default InstagramAutomationRule;
