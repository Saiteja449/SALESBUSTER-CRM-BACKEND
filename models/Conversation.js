import mongoose from "mongoose";

const conversationSchema = new mongoose.Schema(
  {
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      required: true,
      unique: true,
      index: true,
    },
    unreadCount: {
      type: Number,
      default: 0,
    },
    lastMessage: {
      type: String,
      default: "",
    },
    lastMessageTime: {
      type: Date,
      default: Date.now,
    },
    // AI-generated chat summary — cached here to avoid repeated Gemini calls
    chatSummary: {
      summary: { type: String, default: "" },
      keyPoints: [{ type: String }],
      // e.g. "High Intent" | "Warm" | "Neutral" | "Cold" | "Hesitant" | "Price Sensitive"
      sentiment: { type: String, default: "" },
      nextSteps: [{ type: String }],
      generatedAt: { type: Date },
      // Number of messages that were analyzed — used as cache invalidation key
      messagesAnalyzed: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

conversationSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: function (doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
  },
});

const Conversation = mongoose.model("Conversation", conversationSchema);
export default Conversation;
