import mongoose from "mongoose";

const whatsAppCampaignRecipientSchema = new mongoose.Schema(
  {
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WhatsAppCampaign",
      required: true,
      index: true,
    },
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      default: null,
      index: true,
    },
    recipientPhone: {
      type: String,
      required: true,
      index: true,
    },
    recipientName: {
      type: String,
      default: "",
    },
    renderedParameters: [
      {
        type: String,
      },
    ],
    metaMessageId: {
      type: String,
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: [
        "Pending",
        "Queued",
        "Sending",
        "Sent",
        "Delivered",
        "Read",
        "Failed",
        "Skipped",
      ],
      default: "Pending",
      index: true,
    },
    lockedAt: {
      type: Date,
      default: null,
      index: true,
    },
    workerId: {
      type: String,
      default: null,
    },
    retryCount: {
      type: Number,
      default: 0,
    },
    errorCode: {
      type: String,
      default: null,
    },
    errorMessage: {
      type: String,
      default: null,
    },
    sentAt: {
      type: Date,
      default: null,
    },
    deliveredAt: {
      type: Date,
      default: null,
    },
    readAt: {
      type: Date,
      default: null,
    },
    failedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Compound unique index to prevent duplicate recipient numbers in the same campaign
whatsAppCampaignRecipientSchema.index(
  { campaignId: 1, recipientPhone: 1 },
  { unique: true }
);

// Worker atomic polling index
whatsAppCampaignRecipientSchema.index({
  campaignId: 1,
  status: 1,
  lockedAt: 1,
});

whatsAppCampaignRecipientSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: function (doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
  },
});

const WhatsAppCampaignRecipient = mongoose.model(
  "WhatsAppCampaignRecipient",
  whatsAppCampaignRecipientSchema
);

export { whatsAppCampaignRecipientSchema };
export default WhatsAppCampaignRecipient;
