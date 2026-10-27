import mongoose from "mongoose";

export const waWebhookEventSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    field: {
      type: String,
      required: true,
      index: true,
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "processed", "failed", "ignored"],
      default: "pending",
      index: true,
    },
    errorMessage: {
      type: String,
      default: "",
    },
    processedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

const WAWebhookEvent =
  mongoose.models.WAWebhookEvent ||
  mongoose.model("WAWebhookEvent", waWebhookEventSchema);

export default WAWebhookEvent;
