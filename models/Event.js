import mongoose from "mongoose";

const eventSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Event name is required"],
      trim: true,
      maxlength: [150, "Event name cannot exceed 150 characters"],
    },
    venue: {
      type: String,
      trim: true,
      default: "",
    },
    location: {
      type: String,
      trim: true,
      default: "",
    },
    eventDate: {
      type: Date,
      default: Date.now,
    },
    time: {
      type: String,
      trim: true,
      default: "",
    },
    whatsappTemplate: {
      type: String,
      trim: true,
      default: "",
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    attachments: [
      {
        name: { type: String, default: "" },
        type: { type: String, default: "" },
        size: { type: Number, default: 0 },
        url: { type: String, default: "" },
        uri: { type: String, default: "" },
      },
    ],
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

// Pre-save hook to synchronize venue & location
eventSchema.pre("save", function (next) {
  if (this.venue && !this.location) {
    this.location = this.venue;
  } else if (this.location && !this.venue) {
    this.venue = this.location;
  }
  if (!this.whatsappTemplate && this.description) {
    this.whatsappTemplate = this.description;
  }
  next();
});

// Index for listing events by organization and recency
eventSchema.index({ status: 1, createdAt: -1 });

const Event = mongoose.model("Event", eventSchema);
export default Event;
