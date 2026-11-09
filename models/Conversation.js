import mongoose from "mongoose";

const conversationSchema = new mongoose.Schema(
  {
    // Existing WhatsApp CRM fields (preserved for 100% backward compatibility)
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      required: false,
      sparse: true,
      index: true,
    },
    phone: {
      type: String,
      default: "",
      index: true,
    },
    customerName: {
      type: String,
      default: "",
    },
    companyName: {
      type: String,
      default: "",
    },
    designation: {
      type: String,
      default: "",
    },
    isLead: {
      type: Boolean,
      default: true,
      index: true,
    },
    aiDisabled: {
      type: Boolean,
      default: false,
    },
    lastTemplateSentAt: {
      type: Date,
      default: null,
    },
    unreadCount: {
      type: Number,
      default: 0,
    },
    lastMessage: {
      type: String,
      default: "",
    },
    lastMessageTime: {
      type: Date,
      default: Date.now,
    },
    chatSummary: {
      summary: { type: String, default: "" },
      keyPoints: [{ type: String }],
      sentiment: { type: String, default: "" },
      nextSteps: [{ type: String }],
      generatedAt: { type: Date },
      messagesAnalyzed: { type: Number, default: 0 },
    },

    // =========================================================================
    // Real-Time Face-to-Face Conversation Capture System Fields
    // =========================================================================
    sessionId: {
      type: String,
      sparse: true,
      unique: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      index: true,
    },
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Event",
      sparse: true,
      index: true,
    },
    startedAt: {
      type: Date,
      default: Date.now,
    },
    endedAt: {
      type: Date,
      default: null,
    },
    duration: {
      type: Number, // Duration in seconds
      default: 0,
    },
    originalTranscript: {
      type: String,
      default: "",
    },
    transcriptSegments: [
      {
        speakerId: { type: String, required: true },
        text: { type: String, required: true },
        startTime: { type: Number, default: 0 },
        endTime: { type: Number, default: 0 },
        isFinal: { type: Boolean, default: true },
        confidence: { type: Number, default: 1.0 },
        language: { type: String, default: "en-IN" },
      },
    ],
    speakers: [
      {
        speakerId: { type: String, required: true },
        label: { type: String, default: "" },
        identifiedName: { type: String, default: null },
      },
    ],
    selectedSpeakerId: {
      type: String,
      default: null,
    },
    identityStatus: {
      type: String,
      enum: ["verified", "uncertain", "requires_verification", "provisional"],
      default: "provisional",
      index: true,
    },
    selectionReason: {
      type: String,
      default: null,
    },
    requiresManualReview: {
      type: Boolean,
      default: false,
    },
    extractedContact: {
      name: {
        value: { type: String, default: null },
        speakerId: { type: String, default: null },
        evidence: { type: String, default: null },
        confidence: { type: Number, default: 0 },
      },
      phone: {
        value: { type: String, default: null },
        speakerId: { type: String, default: null },
        evidence: { type: String, default: null },
        confidence: { type: Number, default: 0 },
      },
      company: {
        value: { type: String, default: null },
        speakerId: { type: String, default: null },
        evidence: { type: String, default: null },
        confidence: { type: Number, default: 0 },
      },
      designation: {
        value: { type: String, default: null },
        speakerId: { type: String, default: null },
        evidence: { type: String, default: null },
        confidence: { type: Number, default: 0 },
      },
      confirmationStatus: {
        type: String,
        enum: ["provisional", "confirmed", "rejected", "edited"],
        default: "provisional",
        index: true,
      },
      confirmedAt: {
        type: Date,
        default: null,
      },
    },
    summary: {
      keyDiscussion: { type: String, default: "" },
      topics: [{ type: String }],
      decisions: [{ type: String }],
      actionItems: [{ type: String }],
      participants: [{ type: Object }],
    },
    languages: [{ type: String }],
    processingStatus: {
      type: String,
      enum: ["recording", "processing", "completed", "failed"],
      default: "recording",
      index: true,
    },
    aiProvider: {
      type: String,
      default: "gemini",
    },
    modelMetadata: {
      liveModel: {
        type: String,
        default: "gemini-3.8-live",
      },
    },
    usageMetrics: {
      liveDurationSec: { type: Number, default: 0 },
      finalDiarizationDurationSec: { type: Number, default: 0 },
      flashPromptTokens: { type: Number, default: 0 },
      flashCandidateTokens: { type: Number, default: 0 },
      modelCallsCount: { type: Number, default: 0 },
      retriesCount: { type: Number, default: 0 },
      estimatedCostUsd: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

// Indexes
conversationSchema.index({ organizationId: 1, createdAt: -1 });
conversationSchema.index({ userId: 1, createdAt: -1 });
conversationSchema.index({ eventId: 1, createdAt: -1 });

conversationSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: function (doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
  },
});

const Conversation = mongoose.model("Conversation", conversationSchema);
export default Conversation;
