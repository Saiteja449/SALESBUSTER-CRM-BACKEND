import mongoose from "mongoose";

const whatsAppOptOutSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    reason: {
      type: String,
      default: "User requested STOP",
      trim: true,
    },
    sourceMessage: {
      type: String,
      default: "",
    },
    optedOutAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

whatsAppOptOutSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: function (doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
  },
});

const WhatsAppOptOut = mongoose.model("WhatsAppOptOut", whatsAppOptOutSchema);

export { whatsAppOptOutSchema };
export default WhatsAppOptOut;
