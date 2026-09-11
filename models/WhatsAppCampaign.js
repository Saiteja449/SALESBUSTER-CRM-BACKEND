import mongoose from "mongoose";

const variableMappingSubSchema = new mongoose.Schema(
  {
    paramIndex: {
      type: String,
      required: true, // "1", "2", etc.
    },
    sourceType: {
      type: String,
      enum: ["lead_field", "static_value", "organization_field"],
      default: "lead_field",
    },
    fieldKey: {
      type: String,
      default: "", // e.g. "name", "service", "companyName", "assignedTo"
    },
    staticValue: {
      type: String,
      default: "",
    },
    fallback: {
      type: String,
      default: "",
    },
  },
  { _id: false }
);

const audienceCriteriaSubSchema = new mongoose.Schema(
  {
    filterType: {
      type: String,
      enum: ["all", "filtered", "manual_selection", "csv_import"],
      default: "filtered",
    },
    leadStatus: [
      {
        type: String,
      },
    ],
    services: [
      {
        type: String,
      },
    ],
    assignedTo: [
      {
        type: mongoose.Schema.Types.Mixed,
      },
    ],
    cities: [
      {
        type: String,
      },
    ],
    tags: [
      {
        type: String,
      },
    ],
    dateRange: {
      start: { type: Date, default: null },
      end: { type: Date, default: null },
    },
    manualLeadIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Lead",
      },
    ],
    requireConsent: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false }
);

const whatsAppCampaignSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    templateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WhatsAppTemplate",
      required: true,
    },
    templateName: {
      type: String,
      required: true,
      trim: true,
    },
    templateLanguage: {
      type: String,
      default: "en_US",
      trim: true,
    },
    variableMappings: [variableMappingSubSchema],
    headerMedia: {
      type: {
        type: String,
        enum: ["IMAGE", "DOCUMENT", "VIDEO"],
      },
      url: {
        type: String,
        default: "",
      },
      fileName: {
        type: String,
        default: "",
      },
    },
    audienceCriteria: {
      type: audienceCriteriaSubSchema,
      default: () => ({}),
    },
    status: {
      type: String,
      enum: [
        "Draft",
        "Queued",
        "Running",
        "Paused",
        "Completed",
        "Cancelled",
        "Failed",
      ],
      default: "Draft",
      index: true,
    },
    messagesPerSecond: {
      type: Number,
      default: 5,
      min: 1,
      max: 80,
    },
    totalRecipients: {
      type: Number,
      default: 0,
    },
    queuedCount: {
      type: Number,
      default: 0,
    },
    sentCount: {
      type: Number,
      default: 0,
    },
    deliveredCount: {
      type: Number,
      default: 0,
    },
    readCount: {
      type: Number,
      default: 0,
    },
    failedCount: {
      type: Number,
      default: 0,
    },
    skippedCount: {
      type: Number,
      default: 0,
    },
    startedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    createdByName: {
      type: String,
      default: "Agent",
    },
  },
  { timestamps: true }
);

whatsAppCampaignSchema.index({ status: 1, createdAt: -1 });

whatsAppCampaignSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: function (doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
  },
});

const WhatsAppCampaign = mongoose.model("WhatsAppCampaign", whatsAppCampaignSchema);

export { whatsAppCampaignSchema };
export default WhatsAppCampaign;
