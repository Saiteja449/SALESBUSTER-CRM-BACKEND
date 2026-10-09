import mongoose from "mongoose";

const messageSubSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ["user", "assistant"],
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    toolsUsed: {
      type: [String],
      default: [],
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const aiAssistantChatSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    title: {
      type: String,
      default: "New Conversation",
    },
    messages: [messageSubSchema],
  },
  { timestamps: true }
);

// Compound index for querying chat sessions by user sorted by recent activity
aiAssistantChatSchema.index({ userId: 1, updatedAt: -1 });

aiAssistantChatSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: function (doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
  },
});

const AIAssistantChat = mongoose.model("AIAssistantChat", aiAssistantChatSchema);
export default AIAssistantChat;
