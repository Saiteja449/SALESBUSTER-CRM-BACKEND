import mongoose from "mongoose";

const callRecordSchema = new mongoose.Schema(
  {
    callEventId: {
      type: String,
      index: true,
      sparse: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      index: true,
      sparse: true,
    },
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      index: true,
      default: null,
    },
    salespersonId: {
      type: mongoose.Schema.Types.Mixed,
      ref: "User",
      index: true,
      default: null,
    },
    salespersonName: {
      type: String,
      default: "Unassigned",
      index: true,
    },
    customerName: {
      type: String,
      default: "",
      trim: true,
    },
    customerPhone: {
      type: String,
      required: true,
      index: true,
    },
    customerPhoneNormalized: {
      type: String,
      index: true,
      default: "",
    },
    callType: {
      type: String,
      enum: ["incoming", "outgoing", "missed"],
      default: "missed",
      index: true,
    },
    callStatus: {
      type: String,
      enum: ["missed", "connected", "not-connected", "rejected"],
      default: "missed",
      index: true,
    },
    duration: {
      type: Number,
      default: 0,
    },
    calledAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    source: {
      type: String,
      default: "Call",
    },
    receivedSimNumber: {
      type: String,
      default: "",
    },
    recordingUrl: {
      type: String,
      default: null,
    },
    recordingName: {
      type: String,
      default: null,
    },
    recordingId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

callRecordSchema.index({ customerPhoneNormalized: 1, calledAt: -1 });
callRecordSchema.index({ salespersonId: 1, calledAt: -1 });
callRecordSchema.index({ salespersonName: 1, calledAt: -1 });
callRecordSchema.index({ organizationId: 1, calledAt: -1 });
callRecordSchema.index({ callStatus: 1, calledAt: -1 });
callRecordSchema.index({ callType: 1, calledAt: -1 });
callRecordSchema.index({ callEventId: 1 }, { unique: true, sparse: true });

const normalizePhone = function () {
  if (this.customerPhone) {
    const digits = String(this.customerPhone).replace(/\D/g, "");
    this.customerPhoneNormalized = digits.length >= 10 ? digits.slice(-10) : digits;
  }
};
callRecordSchema.pre("validate", normalizePhone);
callRecordSchema.pre("save", normalizePhone);

const CallRecord = mongoose.model("CallRecord", callRecordSchema);
export default CallRecord;

