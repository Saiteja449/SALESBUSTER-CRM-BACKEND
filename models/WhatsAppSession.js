import mongoose from "mongoose";

const whatsappSessionSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      required: true,
      unique: true,
    },
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
    // The phone number the rep is expected to scan (from their profile)
    expectedPhone: {
      type: String,
      default: "",
    },
    // Populated when phone verification fails (phone_mismatch error)
    errorMessage: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

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
