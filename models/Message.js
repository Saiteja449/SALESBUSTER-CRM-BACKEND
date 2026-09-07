import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    messageId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      required: true,
      index: true,
    },
    sender: {
      type: String,
      required: true,
    },
    senderName: {
      type: String,
    },
    direction: {
      type: String,
      enum: ["incoming", "outgoing"],
      required: true,
    },
    messageType: {
      type: String,
      enum: ["text", "image", "audio", "document", "contact", "location"],
      default: "text",
    },
    text: {
      type: String,
      default: "",
    },
    mediaUrl: {
      type: String,
      default: "",
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
    aiGenerated: {
      type: Boolean,
      default: false,
    },
    delivered: {
      type: Boolean,
      default: false,
    },
    read: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      default: "sent",
    },
  },
  { timestamps: true }
);

// Convert _id to id for frontend compatibility
messageSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: function (doc, ret) {
    ret.id = ret._id.toString();
    if (ret.leadId) ret.leadId = ret.leadId.toString();
    delete ret._id;
  },
});

const Message = mongoose.model("Message", messageSchema);
export default Message;
