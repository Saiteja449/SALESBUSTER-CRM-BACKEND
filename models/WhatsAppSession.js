import mongoose from "mongoose";

const whatsappSessionSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    lineNumber: { type: Number, enum: [1, 2], default: 1 },
    status: {
      type: String,
      enum: ["disconnected", "qr", "connecting", "connected"],
      default: "disconnected",
    },
    qrCode: {
      type: String,
      default: "",
    },
    connectedPhone: {
      type: String,
      default: "",
    },
    connectedName: {
      type: String,
      default: "",
    },
    // Multi-user support: links session to a specific sales rep
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // Explicit tenant organization association for this session record
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
    },
    errorMessage: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

whatsappSessionSchema.index({ organizationId: 1, userId: 1, lineNumber: 1 });

whatsappSessionSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: function (doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
  },
});

const WhatsAppSession = mongoose.model("WhatsAppSession", whatsappSessionSchema);
export default WhatsAppSession;
