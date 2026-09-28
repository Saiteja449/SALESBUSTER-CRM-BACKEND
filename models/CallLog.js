import mongoose from "mongoose";

export const callLogSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: false,
      index: true,
    },
    salespersonId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    salespersonName: {
      type: String,
      default: "",
      trim: true,
    },
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      index: true,
    },
    leadPhone: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    leadName: {
      type: String,
      default: "",
      trim: true,
    },
    cmiuid: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    callType: {
      type: String,
      enum: ["incoming", "outgoing"],
      default: "outgoing",
    },
    status: {
      type: String,
      enum: [
        "connected",
        "missed",
        "rejected",
        "not-connected",
        "busy",
        "failed",
      ],
      default: "not-connected",
    },
    duration: {
      type: Number,
      default: 0, // Total duration in seconds
    },
    talkTime: {
      type: Number,
      default: 0, // Billed talk time in seconds
    },
    recordingFilename: {
      type: String,
      default: "",
    },
    recordingUrl: {
      type: String,
      default: "",
    },
    recordingSize: {
      type: Number,
      default: 0,
    },
    disposition: {
      type: String,
      default: "",
      trim: true,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
    aiAnalysisStatus: {
      type: String,
      enum: ["none", "pending", "completed", "failed"],
      default: "none",
    },
    aiSummary: {
      type: String,
      default: "",
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true }
);

callLogSchema.index({ createdAt: -1 });
callLogSchema.index({ salespersonId: 1, createdAt: -1 });
callLogSchema.index({ leadId: 1, createdAt: -1 });

callLogSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: function (doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
  },
});

const CallLog = mongoose.model("CallLog", callLogSchema);
export default CallLog;
