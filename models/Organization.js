import mongoose from "mongoose";
import crypto from "crypto";

// Sub-Schema for Service Images & Descriptions
export const serviceImageSubSchema = new mongoose.Schema(
  {
    url: {
      type: String,
      required: [true, "Image URL or path is required"],
      trim: true,
    },
    title: {
      type: String,
      default: "",
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    order: {
      type: Number,
      default: 0,
    },
  },
  { _id: true }
);

// Formal Sub-Schema for Organization Services Catalog
export const serviceSubSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Service name is required"],
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    keywords: [
      {
        type: String,
        trim: true,
      },
    ],
    category: {
      type: String,
      default: "General",
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    sendImagesEnabled: {
      type: Boolean,
      default: true,
    },
    images: {
      type: [serviceImageSubSchema],
      default: [],
    },
  },
  { _id: true }
);

// Formal Sub-Schema for Lead Qualification Fields / Questions
export const qualificationFieldSubSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: [true, "Field key is required"],
      trim: true,
    },
    label: {
      type: String,
      required: [true, "Field label is required"],
      trim: true,
    },
    type: {
      type: String,
      enum: ["string", "number", "boolean", "select"],
      default: "string",
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    options: [
      {
        type: String,
        trim: true,
      },
    ],
    required: {
      type: Boolean,
      default: false,
    },
  },
  { _id: true }
);

// Formal Sub-Schema for Organization Lead Workflow & Automation Settings
export const workflowSettingsSubSchema = new mongoose.Schema(
  {
    // 1. SLA & Attendance Configuration
    leadAttendanceSlaHours: {
      type: Number,
      default: 24, // Configurable e.g. 2, 4, 12, 24, 48 hours
      min: [1, "SLA must be at least 1 hour"],
    },
    enableAutoAttendanceEscalation: {
      type: Boolean,
      default: true,
    },
    retriggerAutoMsgOnBreach: {
      type: Boolean,
      default: true,
    },

    // 2. Scheduled Follow-up (Take Up Later) Reminders
    callerReminderMinutesBefore: {
      type: Number,
      default: 30, // Configurable e.g. 10, 15, 30, 60 minutes
      min: [0, "Cannot be negative"],
    },
    clientReminderMinutesBefore: {
      type: Number,
      default: 0, // 0 = at scheduled time; or 15, 30 mins before
      min: [0, "Cannot be negative"],
    },
    callerOverdueThresholdMinutes: {
      type: Number,
      default: 120, // 2 hours grace period before flagging in caller accountability report
      min: [15, "Threshold must be at least 15 minutes"],
    },

    // 3. "Not Responding" Cadence Configuration
    notRespondingMaxFollowups: {
      type: Number,
      default: 5, // Configurable e.g. 3, 5, 7 attempts
      min: [1, "Must have at least 1 follow-up"],
    },
    notRespondingWindowDays: {
      type: Number,
      default: 15, // Configurable duration e.g. 7, 10, 15, 30 days
      min: [1, "Window must be at least 1 day"],
    },
    notRespondingIntervalDays: {
      type: [Number],
      default: [1, 3, 6, 10, 15],
    },
    notRespondingFallbackFolder: {
      type: String,
      default: "Future Leads",
    },

    // 4. "Future Leads" Long-Term Drip Configuration
    futureLeadsDripIntervalDays: {
      type: Number,
      default: 15, // Configurable e.g. 7, 15, 30 days
      min: [1, "Drip interval must be at least 1 day"],
    },
    futureLeadsMaxDrips: {
      type: Number,
      default: 0, // 0 = unlimited / ongoing until unsubscribe
    },

    // 5. Special Routing Numbers & Opt-Out Keywords
    collabNotificationPhone: {
      type: String,
      default: "", // Target phone number for collaboration opportunity alerts
      trim: true,
    },
    jobNotificationPhone: {
      type: String,
      default: "", // Target phone or HR number for job applicant alerts
      trim: true,
    },
    dndKeywords: {
      type: [String],
      default: ["stop", "unsubscribe", "dnd", "cancel", "dont call", "opt out"],
    },
    reactivationKeywords: {
      type: [String],
      default: ["yes", "interested", "call me", "details", "info", "price"],
    },
  },
  { _id: false }
);

const organizationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Organization name is required"],
      trim: true,
    },
    email: {
      type: String,
      required: function () {
        return this.accountType !== "guest";
      },
      trim: true,
      lowercase: true,
    },
    mobile: {
      type: String,
      required: [true, "Mobile phone number is required"],
      trim: true,
    },
    website: {
      type: String,
      trim: true,
      default: "",
    },
    seats: {
      type: Number,
      required: [true, "Number of user seats is required"],
      min: [1, "An organization must have at least 1 seat"],
      default: 1,
    },
    amountPaid: {
      type: Number,
      required: [true, "Amount paid is required"],
      min: [0, "Amount paid cannot be negative"],
      default: 0,
    },
    pricingPerSeat: {
      type: Number,
      default: 0,
    },
    paymentMethod: {
      type: String,
      default: "Manual",
    },
    subscriptionPlan: {
      type: String,
      enum: ["monthly", "quarterly", "annually", "annual", "yearly", "starter", "growth", "enterprise"],
      default: "monthly",
      lowercase: true,
      trim: true,
    },
    subscriptionStartDate: {
      type: Date,
      default: Date.now,
    },
    accountType: {
      type: String,
      enum: ["crm", "guest"],
      default: "crm",
      index: true,
    },
    subscriptionEndDate: {
      type: Date,
      required: function () {
        return this.accountType !== "guest";
      },
      index: true,
    },
    isTrial: {
      type: Boolean,
      default: false,
      index: true,
    },
    trialStartDate: {
      type: Date,
      default: null,
    },
    trialEndsAt: {
      type: Date,
      default: null,
      index: true,
    },
    trialConverted: {
      type: Boolean,
      default: false,
    },
    nextBillingDate: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ["active", "inactive", "suspended"],
      default: "active",
      index: true,
    },
    tenantDbName: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AuthUser",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AuthUser",
    },
    notes: {
      type: String,
      default: "",
    },
    whatsappLineLimit: {
      type: Number,
      enum: [1, 2],
      default: 1,
    },
    addons: {
      whatsappCampaigns: {
        type: Boolean,
        default: false,
        index: true,
      },
      biAnalyst: {
        type: Boolean,
        default: false,
        index: true,
      },
      targetIntelligence: {
        type: Boolean,
        default: false,
        index: true,
      },
      marketingRoi: {
        type: Boolean,
        default: false,
        index: true,
      },
    },
    addonEntitlements: [
      {
        addonId: { type: String, required: true, trim: true },
        startsAt: { type: Date, required: true },
        expiresAt: { type: Date, required: true, index: true },
        orderId: { type: String, default: "" },
        source: { type: String, enum: ["payment", "admin"], default: "payment" },
      },
    ],
    aiSettings: {
      geminiApiKey: {
        type: String,
        default: "",
        trim: true,
      },
      isAiConfigured: {
        type: Boolean,
        default: false,
        index: true,
      },
      aiSetupCompletedAt: {
        type: Date,
        default: null,
      },
      companyName: {
        type: String,
        default: "",
        trim: true,
      },
      businessDescription: {
        type: String,
        default: "",
        trim: true,
      },
      agentPersona: {
        type: String,
        default: "friendly, human sales representative",
        trim: true,
      },
      customInstructions: {
        type: String,
        default: "",
        trim: true,
      },
      services: [serviceSubSchema],
      qualificationFields: [qualificationFieldSubSchema],
      welcomeMessageTemplate: {
        type: String,
        default: "",
        trim: true,
      },
      welcomeMessageFallbackService: {
        type: String,
        default: "",
        trim: true,
      },
      missedCallMessageEnabled: {
        type: Boolean,
        default: true,
      },
      missedCallMessageTemplate: {
        type: String,
        default: "",
        trim: true,
      },
      missedCallDifferentNumberTemplate: {
        type: String,
        default: "",
        trim: true,
      },
      serviceImagesAutoSendEnabled: {
        type: Boolean,
        default: true,
      },
      qdrantCollection: {
        type: String,
        default: "",
        trim: true,
      },
      knowledgeDocs: [
        {
          docId: { type: String, required: true },
          name: { type: String, required: true },
          originalName: { type: String, required: true },
          fileUrl: { type: String, default: "" },
          fileSize: { type: Number, default: 0 },
          chunkCount: { type: Number, default: 0 },
          status: {
            type: String,
            enum: ["processing", "indexed", "failed"],
            default: "indexed",
          },
          uploadedAt: { type: Date, default: Date.now },
        },
      ],
      dailyAiUsage: {
        date: {
          type: String,
          default: () => new Date().toISOString().slice(0, 10),
        },
        chatApiCalls: {
          type: Number,
          default: 0,
        },
        audioApiCalls: {
          type: Number,
          default: 0,
        },
        whatsappAiCalls: {
          type: Number,
          default: 0,
        },
        callsApiCalls: {
          type: Number,
          default: 0,
        },
        biAnalystCalls: {
          type: Number,
          default: 0,
        },
        totalApiCalls: {
          type: Number,
          default: 0,
        },
        dailyQuotaLimit: {
          type: Number,
          default: 500,
        },
        quotaSplit: {
          whatsappAi: {
            type: Number,
            default: 250,
            min: 0,
          },
          calls: {
            type: Number,
            default: 250,
            min: 0,
          },
          biAnalyst: {
            type: Number,
            default: 0,
            min: 0,
          },
        },
        lastResetAt: {
          type: Date,
          default: Date.now,
        },
      },
    },
    whatsappCloudSettings: {
      isConfigured: {
        type: Boolean,
        default: false,
        index: true,
      },
      wabaId: {
        type: String,
        default: "",
        trim: true,
        index: true,
      },
      phoneNumberId: {
        type: String,
        default: "",
        trim: true,
        index: true,
      },
      displayPhoneNumber: {
        type: String,
        default: "",
        trim: true,
      },
      verifiedName: {
        type: String,
        default: "",
        trim: true,
      },
      accessTokenEncrypted: {
        type: String,
        default: "",
      },
      qualityRating: {
        type: String,
        default: "UNKNOWN",
      },
      messagingLimitTier: {
        type: String,
        default: "TIER_1K",
      },
      messagesPerSecond: {
        type: Number,
        default: 5,
        min: 1,
        max: 80,
      },
      webhookVerifyToken: {
        type: String,
        default: "",
      },
      lastSyncedAt: {
        type: Date,
        default: null,
      },
    },
    webhookKey: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      index: true,
      default: () => "sb_whk_" + crypto.randomBytes(16).toString("hex"),
    },
    workflowSettings: {
      type: workflowSettingsSubSchema,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
  },
);

/**
 * Returns default AI configuration depending on organization name/type
 */
export const getDefaultAISettings = (orgName = "") => {
  return {
    geminiApiKey: "",
    isAiConfigured: false,
    aiSetupCompletedAt: null,
    companyName: orgName || "Our Company",
    businessDescription: `${orgName || "Our company"} provides premium quality products, consultations, and professional services tailored to our clients' needs.`,
    agentPersona: "friendly, professional sales representative",
    customInstructions: `1. HUMAN TONE: Communicate warmly, politely, and conversationally. Never say you are an AI or bot.
2. PACING: Ask at most 1-2 questions per message to gather customer requirements naturally.
3. PRICING: Do not quote definitive prices without full requirement assessment. Suggest scheduling a call with our team.
4. HUMAN HANDOFF: If the user requests human assistance, transfer them and set disableAI=true.
5. WHATSAPP FORMATTING: Keep messages short (maximum 50-60 words), clean bullet points, bold key terms (*term*), and emojis.`,
    qdrantCollection: "",
    services: [
      {
        name: "General Enquiry",
        description:
          "General inquiry or consultation regarding products, services, and customer requirements.",
        keywords: [
          "enquiry",
          "inquiry",
          "information",
          "help",
          "details",
          "consultation",
        ],
      },
    ],
    qualificationFields: [
      {
        key: "cityAndArea",
        label: "City & Area",
        type: "string",
        description: "Customer's city, area, or preferred project location.",
      },
      {
        key: "primaryIntent",
        label: "Primary Intent",
        type: "string",
        description:
          "Customer's primary objective, service requirement, or product needed.",
      },
      {
        key: "urgencyLevel",
        label: "Urgency Level",
        type: "select",
        options: ["Immediate", "Within 1 Month", "Planning / Just Exploring"],
        description: "Customer's purchasing urgency or required timeframe.",
      },
      {
        key: "interestScore",
        label: "Interest Score (1-10)",
        type: "number",
        description:
          "Assessed customer interest or buying readiness score from 1 to 10.",
      },
      {
        key: "callbackDateTime",
        label: "Callback Date/Time",
        type: "string",
        description:
          "Best callback date and time requested by customer for consultation.",
      },
    ],
    knowledgeDocs: [],
    welcomeMessageTemplate: "",
    welcomeMessageFallbackService: "",
    missedCallMessageEnabled: true,
    missedCallMessageTemplate: "",
    missedCallDifferentNumberTemplate: "",
    serviceImagesAutoSendEnabled: true,
    dailyAiUsage: {
      date: new Date().toISOString().slice(0, 10),
      chatApiCalls: 0,
      audioApiCalls: 0,
      whatsappAiCalls: 0,
      callsApiCalls: 0,
      biAnalystCalls: 0,
      totalApiCalls: 0,
      dailyQuotaLimit: 500,
      quotaSplit: {
        whatsappAi: 250,
        calls: 250,
        biAnalyst: 0,
      },
      lastResetAt: new Date(),
    },
  };
};

organizationSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: function (doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
  },
});

organizationSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: "string", $gt: "" } } }
);
organizationSchema.index(
  { mobile: 1 },
  { unique: true, partialFilterExpression: { mobile: { $type: "string", $gt: "" } } }
);

export { organizationSchema };
const Organization = mongoose.model("Organization", organizationSchema);
export default Organization;
