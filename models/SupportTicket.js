import mongoose from "mongoose";

const supportTicketSchema = new mongoose.Schema(
  {
    ticketNumber: {
      type: String,
      unique: true,
      required: true,
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    organizationName: {
      type: String,
      default: "",
      trim: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    userName: {
      type: String,
      required: true,
      trim: true,
    },
    userEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    userRole: {
      type: String,
      default: "",
    },
    subject: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      enum: [
        "general",
        "technical_issue",
        "whatsapp_meta",
        "call_recording",
        "leads_pipeline",
        "billing",
        "feature_request",
      ],
      default: "technical_issue",
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
    },
    status: {
      type: String,
      enum: ["open", "in_progress", "resolved", "closed"],
      default: "open",
      index: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    aiSummary: {
      type: String,
      default: "",
    },
    aiChatHistory: [
      {
        role: {
          type: String,
          enum: ["user", "assistant"],
        },
        content: {
          type: String,
          default: "",
        },
        timestamp: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    resolutionNotes: {
      type: String,
      default: "",
      trim: true,
    },
    resolvedAt: {
      type: Date,
    },
    resolvedBy: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

// Counter schema for atomic sequential ticket numbering
const ticketCounterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, default: 1000 },
  },
  { versionKey: false }
);

export const TicketCounter =
  mongoose.models.TicketCounter || mongoose.model("TicketCounter", ticketCounterSchema);

// Helper method to generate next sequential ticket number atomically
supportTicketSchema.statics.generateNextTicketNumber = async function () {
  try {
    // 1. Ensure counter is initialized to at least max existing ticket or 1000
    const counter = await TicketCounter.findById("support_ticket_seq");
    if (!counter) {
      const latestTicket = await this.findOne({}, { ticketNumber: 1 })
        .sort({ createdAt: -1 })
        .lean();

      let highestNum = 1000;
      if (latestTicket?.ticketNumber) {
        const match = latestTicket.ticketNumber.match(/SB-(\d+)/);
        if (match && match[1]) {
          highestNum = Math.max(highestNum, parseInt(match[1], 10));
        }
      }

      await TicketCounter.findByIdAndUpdate(
        "support_ticket_seq",
        { $setOnInsert: { seq: highestNum } },
        { upsert: true }
      );
    }

    // 2. Atomically increment sequence in MongoDB
    const updated = await TicketCounter.findByIdAndUpdate(
      "support_ticket_seq",
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );

    return `SB-${updated.seq}`;
  } catch (err) {
    console.warn("[SupportTicket] Atomic counter fallback:", err.message);
    const latestTicket = await this.findOne({}, { ticketNumber: 1 })
      .sort({ createdAt: -1 })
      .lean();

    if (!latestTicket || !latestTicket.ticketNumber) {
      return "SB-1001";
    }

    const match = latestTicket.ticketNumber.match(/SB-(\d+)/);
    if (match && match[1]) {
      const nextNum = parseInt(match[1], 10) + 1;
      return `SB-${nextNum}`;
    }

    return `SB-${Date.now().toString().slice(-4)}${Math.floor(100 + Math.random() * 900)}`;
  }
};

const SupportTicket = mongoose.model("SupportTicket", supportTicketSchema);

export default SupportTicket;

