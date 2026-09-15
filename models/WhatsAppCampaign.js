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

const scheduleSubSchema = new mongoose.Schema(
  {
    startDate: {
      type: Date,
      default: null,
    },
    timeOfDay: {
      type: String,
      default: "10:00", // HH:mm in 24hr format
    },
    frequency: {
      type: String,
      enum: ["once", "daily", "weekly", "monthly", "custom"],
      default: "once",
    },
    daysOfWeek: [
      {
        type: Number, // 0 = Sun, 1 = Mon, ..., 6 = Sat
      },
    ],
    cronExpression: {
      type: String,
      default: "", // e.g. "0 10 * * 1"
    },
    intervalDays: {
      type: Number,
      default: 1,
    },
    dayOfMonth: {
      type: Number,
      default: 1,
    },
    endCondition: {
      type: String,
      enum: ["indefinite", "until_date", "max_runs"],
      default: "indefinite",
    },
    endDate: {
      type: Date,
      default: null,
    },
    maxRuns: {
      type: Number,
      default: 0,
    },
    currentRunCount: {
      type: Number,
      default: 0,
    },
    nextRunAt: {
      type: Date,
      default: null,
      index: true,
    },
    lastRunAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false }
);

const audiencePolicySubSchema = new mongoose.Schema(
  {
    mode: {
      type: String,
      enum: ["new_leads_only", "cooldown", "all_matching"],
      default: "cooldown",
    },
    cooldownDays: {
      type: Number,
      default: 7,
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
    campaignType: {
      type: String,
      enum: ["one_time", "automated"],
      default: "one_time",
      index: true,
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
    schedule: {
      type: scheduleSubSchema,
      default: () => ({}),
    },
    audiencePolicy: {
      type: audiencePolicySubSchema,
      default: () => ({}),
    },
    status: {
      type: String,
      enum: [
        "Draft",
        "Scheduled",
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
whatsAppCampaignSchema.index({ status: 1, "schedule.nextRunAt": 1 });
whatsAppCampaignSchema.index({ campaignType: 1, status: 1 });

whatsAppCampaignSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: function (doc, ret) {
    ret.id = ret._id ? ret._id.toString() : ret.id;
    ret._id = ret.id;
  },
});

const WhatsAppCampaign = mongoose.model("WhatsAppCampaign", whatsAppCampaignSchema);

export { whatsAppCampaignSchema };
export default WhatsAppCampaign;
