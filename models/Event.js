import mongoose from "mongoose";

const eventSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Event name is required"],
      trim: true,
      maxlength: [150, "Event name cannot exceed 150 characters"],
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    eventDate: {
      type: Date,
      default: Date.now,
    },
    location: {
      type: String,
      trim: true,
      default: "",
    },
    status: {
      type: String,
      enum: ["active", "completed", "archived"],
      default: "active",
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    createdByName: {
      type: String,
      default: "",
    },
    stats: {
      totalCaptured: {
        type: Number,
        default: 0,
      },
      whatsappSentCount: {
        type: Number,
        default: 0,
      },
    },
  },
  {
    timestamps: true,
  }
);

// Index for listing events by organization and recency
eventSchema.index({ status: 1, createdAt: -1 });

const Event = mongoose.model("Event", eventSchema);
export default Event;

