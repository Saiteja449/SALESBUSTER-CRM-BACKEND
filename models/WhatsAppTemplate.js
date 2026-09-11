import mongoose from "mongoose";

const componentSubSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["HEADER", "BODY", "FOOTER", "BUTTONS"],
      required: true,
    },
    format: {
      type: String,
      enum: ["TEXT", "IMAGE", "DOCUMENT", "VIDEO", "LOCATION"],
      default: "TEXT",
    },
    text: {
      type: String,
      default: "",
    },
    example: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    buttons: [
      {
        type: mongoose.Schema.Types.Mixed,
      },
    ],
  },
  { _id: false }
);

const whatsAppTemplateSchema = new mongoose.Schema(
  {
    metaTemplateId: {
      type: String,
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    language: {
      type: String,
      default: "en_US",
      trim: true,
    },
    category: {
      type: String,
      enum: ["MARKETING", "UTILITY", "AUTHENTICATION"],
      required: true,
    },
    status: {
      type: String,
      enum: ["APPROVED", "PENDING", "REJECTED", "PAUSED", "DISABLED"],
      default: "APPROVED",
      index: true,
    },
    components: [componentSubSchema],
    variableCount: {
      type: Number,
      default: 0,
    },
    variableNames: [
      {
        type: String,
      },
    ],
    lastSyncedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

whatsAppTemplateSchema.index({ name: 1, language: 1 }, { unique: true });

whatsAppTemplateSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: function (doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
  },
});

const WhatsAppTemplate = mongoose.model("WhatsAppTemplate", whatsAppTemplateSchema);

export { whatsAppTemplateSchema };
export default WhatsAppTemplate;
