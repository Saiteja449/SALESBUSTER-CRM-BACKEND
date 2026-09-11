import mongoose from "mongoose";

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

const organizationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Organization name is required"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Billing/Admin email is required"],
      trim: true,
      lowercase: true,
      index: true,
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
      enum: ["monthly", "quarterly", "annually", "annual"],
      default: "monthly",
      lowercase: true,
      trim: true,
    },
    subscriptionStartDate: {
      type: Date,
      default: Date.now,
    },
    subscriptionEndDate: {
      type: Date,
      required: true,
      index: true,
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
        totalApiCalls: {
          type: Number,
          default: 0,
        },
        dailyQuotaLimit: {
          type: Number,
          default: 1500,
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
    dailyAiUsage: {
      date: new Date().toISOString().slice(0, 10),
      chatApiCalls: 0,
      audioApiCalls: 0,
      totalApiCalls: 0,
      dailyQuotaLimit: 1500,
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

export { organizationSchema };
const Organization = mongoose.model("Organization", organizationSchema);
export default Organization;
