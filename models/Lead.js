import mongoose from "mongoose";

const leadSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    phone: {
      type: String,
      required: true,
    },
    email: {
      type: String,
    },
    source: {
      type: String,
      enum: [
        "Email",
        "WhatsApp",
        "Meta Ads",
        "Website Form",
        "Call",
        "Manual Entry",
        "Mobile App",
      ],
      default: "Manual Entry",
    },
    service: {
      type: String,
      required: true,
      default: "General Enquiry",
      trim: true,
    },

    assignedTo: {
      type: mongoose.Schema.Types.Mixed,
      ref: "User",
      default: "Unassigned",
      index: true,
    },
    joinedAt: {
      type: Date,
    },
    status: {
      type: String,
      enum: [
        "New",
        "Follow Up",
        "Not Interested",
        "Not Attended",
        "Price Issue",
        "Converted",
      ],
      default: "New",
    },
    leadType: {
      type: String,
      default: "Client",
    },
    providerService: {
      type: String,
    },
    nextFollowUp: {
      type: String, // Kept as string to easily map to HTML date input format "YYYY-MM-DD"
    },
    followupTime: {
      type: String,
    },
    notes: {
      type: String,
    },
    city: {
      type: String,
    },
    preferredContactMethod: {
      type: String,
      enum: ["Email", "SMS", "WhatsApp", "Phone", ""],
      default: "",
    },
    priority: {
      type: String,
      enum: ["High", "Medium", "Low"],
      default: "Medium",
    },
    dealValue: {
      type: Number,
    },
    expectedCloseDate: {
      type: Date,
    },
    tags: {
      type: [String],
      default: [],
    },
    unreadCount: {
      type: Number,
      default: 0,
    },
    hasUnread: {
      type: Boolean,
      default: false,
    },
    importantLead: {
      type: Boolean,
      default: false,
    },
    appointmentDate: {
      type: String,
    },
    appointmentTime: {
      type: String,
    },
    lastMessage: {
      type: String,
    },
    lastActivity: {
      type: Date,
    },
    aiEnabled: {
      type: Boolean,
      default: true,
    },
    aiPausedUntil: {
      type: Date,
      default: null,
    },
    aiQualification: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    aiTags: {
      type: [String],
      default: [],
    },
    isOptedOut: {
      type: Boolean,
      default: false,
      index: true,
    },
    optedOutAt: {
      type: Date,
      default: null,
    },
    lastCloudInboundAt: {
      type: Date,
      default: null,
    },
    serviceWindowExpiresAt: {
      type: Date,
      default: null,
      index: true,
    },
    hasWhatsAppConsent: {
      type: Boolean,
      default: true,
      index: true,
    },
    consentSource: {
      type: String,
      default: "Inquiry Form",
    },
    isOldLead: {
      type: Boolean,
      default: false,
    },
    conversationSummary: {
      type: String,
    },
    sentiment: {
      type: String,
    },
    probabilityOfConversion: {
      type: Number,
    },
    nextAction: {
      type: String,
    },
    followUpCount: {
      type: Number,
      default: 0,
    },
    lastFollowUpSentAt: {
      type: Date,
    },
    automatedFollowUpsActive: {
      type: Boolean,
      default: true,
    },
    recordings: [
      {
        name: String,
        url: String,
        analysis: String,
        analysisStatus: { type: String, default: "pending" }, // pending, completed, failed
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true },
);

// Cascade delete associated records when a lead is deleted
leadSchema.pre("findOneAndDelete", async function () {
  const doc = await this.model.findOne(this.getQuery());
  if (doc) {
    const id = doc._id;
    const db = this.model?.db || mongoose.connection;
    const getModel = (name) => db.models[name] || mongoose.model(name);
    await getModel("Followup").deleteMany({ leadId: id });
    await getModel("Conversation").deleteMany({ leadId: id });
    await getModel("Message").deleteMany({ leadId: id });
    await getModel("AILog").deleteMany({ leadId: id });
  }
});

leadSchema.pre("deleteOne", { document: true, query: true }, async function () {
  const id =
    this._id ||
    (this.getQuery && (await this.model.findOne(this.getQuery()))?._id);
  if (id) {
    const db = this.model?.db || this.db || mongoose.connection;
    const getModel = (name) => db.models[name] || mongoose.model(name);
    await getModel("Followup").deleteMany({ leadId: id });
    await getModel("Conversation").deleteMany({ leadId: id });
    await getModel("Message").deleteMany({ leadId: id });
    await getModel("AILog").deleteMany({ leadId: id });
  }
});

// Convert _id to id for frontend compatibility
leadSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: function (doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
  },
});

const Lead = mongoose.model("Lead", leadSchema);
export default Lead;
