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
