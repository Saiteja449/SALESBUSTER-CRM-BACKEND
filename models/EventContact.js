import mongoose from "mongoose";

const eventContactSchema = new mongoose.Schema(
  {
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Event",
      required: [true, "Event ID is required"],
      index: true,
    },
    name: {
      type: String,
      required: [true, "Contact name is required"],
      trim: true,
    },
    phone: {
      type: String,
      required: [true, "Contact phone number is required"],
      trim: true,
      index: true,
    },
    companyName: {
      type: String,
      trim: true,
      default: "",
    },
    summary: {
      type: String,
      trim: true,
      default: "",
    },
    messageText: {
      type: String,
      trim: true,
      default: "",
    },
    status: {
      type: String,
      enum: ["captured", "whatsapp_opened", "completed"],
      default: "captured",
      index: true,
    },
    capturedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    capturedByName: {
      type: String,
      default: "",
    },
    sentAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Composite index for fast lookup of contacts under an event
eventContactSchema.index({ eventId: 1, createdAt: -1 });
eventContactSchema.index({ eventId: 1, phone: 1 });

const EventContact = mongoose.model("EventContact", eventContactSchema);
export default EventContact;

