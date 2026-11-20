import mongoose from "mongoose";

export const cashfreeWebhookEventSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    eventType: {
      type: String,
      required: true,
      index: true,
    },
    orderId: {
      type: String,
      required: true,
      index: true,
    },
    processedAt: {
      type: Date,
      default: Date.now,
    },
    rawPayload: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

const CashfreeWebhookEvent =
  mongoose.models.CashfreeWebhookEvent ||
  mongoose.model("CashfreeWebhookEvent", cashfreeWebhookEventSchema);

export default CashfreeWebhookEvent;
