import mongoose from "mongoose";

export const waAccountSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    // Multi-User: Null for company/manager shared account, or specific User ID for sales rep
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    wabaId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    phoneNumberId: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },
    displayPhone: {
      type: String,
      required: true,
      trim: true,
    },
    accessTokenEncrypted: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["onboarding", "syncing", "connected", "disconnected", "error"],
      default: "onboarding",
      index: true,
    },
    disconnectReason: {
      type: String,
      default: "", // e.g. PRIMARY_INACTIVITY, USER_REMOVED
    },
    isOnBizApp: {
      type: Boolean,
      default: null, // Unknown until verified from Meta; false for confirmed API-only lines
    },
    platformType: {
      type: String,
      default: "CLOUD_API",
    },
    onboardedAt: {
      type: Date,
      default: Date.now,
    },
    syncDeadline: {
      type: Date,
      default: null, // Set only when an eligible coexistence sync starts (onboardedAt + 24h)
      index: true,
    },
    contactsSyncRequested: {
      type: Boolean,
      default: false,
    },
    contactsSyncRequestId: {
      type: String,
      default: "",
    },
    historySyncRequested: {
      type: Boolean,
      default: false,
    },
    historySyncRequestId: {
      type: String,
      default: "",
    },
    historySharingDeclined: {
      type: Boolean,
      default: false, // Set to true if error code 2593109 received (user tapped Don't Share)
    },
    historyProgress: {
      chunksReceived: { type: Number, default: 0 },
      messagesImported: { type: Number, default: 0 },
      lastChunkReceivedAt: { type: Date },
      isComplete: { type: Boolean, default: false },
    },
    lastActivityAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

waAccountSchema.index({ organizationId: 1, status: 1 });
waAccountSchema.index({ organizationId: 1, userId: 1 });

const WAAccount = mongoose.models.WAAccount || mongoose.model("WAAccount", waAccountSchema);
export default WAAccount;
