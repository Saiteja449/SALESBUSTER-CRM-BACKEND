import mongoose from "mongoose";

export const waMessageSchema = new mongoose.Schema(
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
    wamid: {
      type: String,
      required: true,
      unique: true, // Strict deduplication guarantee
      index: true,
    },
    contactWaId: {
      type: String,
      required: true,
      index: true,
    },
    direction: {
      type: String,
      enum: ["inbound", "outbound"],
      required: true,
    },
    source: {
      type: String,
      enum: ["cloud_api", "business_app", "history"],
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: [
        "text",
        "image",
        "audio",
        "video",
        "document",
        "sticker",
        "contacts",
        "location",
        "interactive",
        "media_placeholder",
        "unsupported",
      ],
      default: "text",
    },
    body: {
      type: String,
      default: "",
    },
    mediaId: {
      type: String,
      default: "",
    },
    mediaUrl: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["sent", "delivered", "read", "failed", "deleted"],
      default: "sent",
    },
    originalMessageId: {
      type: String, // Used when an incoming message is an edit or revoke of an earlier wamid
      default: null,
      index: true,
    },
    timestamp: {
      type: Date,
      required: true,
      index: true,
    },
    rawPayload: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  { timestamps: true }
);

waMessageSchema.index({ accountId: 1, contactWaId: 1, timestamp: -1 });

const WAMessage = mongoose.models.WAMessage || mongoose.model("WAMessage", waMessageSchema);
export default WAMessage;
