import { toInternationalPhone } from "../utils/phoneUtils.js";
import mongoose from "mongoose";

const leadSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      default: "",
    },
    phone: {
      type: String,
      required: function () {
        return this.source !== "Instagram";
      },
      default: "",
      index: true,
      set: function (val) {
        if (val) {
          this.phoneNormalized = toInternationalPhone(val);
        }
        return val;
      },
    },
    phoneNormalized: {
      type: String,
      index: true,
      default: "",
    },
    instagramIgsid: {
      type: String,
      index: true,
      default: "",
    },
    instagramUsername: {
      type: String,
      default: "",
    },
    email: {
      type: String,
    },
    company: {
      type: String,
      trim: true,
      default: "",
    },
    source: {
      type: String,
      enum: [
        "Email",
        "WhatsApp",
        "Instagram",
        "Meta Ads",
        "Google Ads",
        "YouTube",
        "Justdial",
        "LinkedIn Ads",
        "Website Form",
        "Website Chat",
        "Call",
        "Manual Entry",
        "Mobile App",
        "Excel Import",
        // "Target Intelligence",
      ],
      default: "Manual Entry",
    },
    campaignName: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    utmSource: {
      type: String,
      trim: true,
      default: "",
    },
    utmMedium: {
      type: String,
      trim: true,
      default: "",
    },
    utmCampaign: {
      type: String,
      trim: true,
      default: "",
    },
    service: {
      type: String,
      required: true,
      default: "General Enquiry",
      trim: true,
    },
    services: {
      type: [String],
      default: [],
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
    folder: {
      type: String,
      enum: [
        "New Leads",
        "Not Attended",
        "Priority",
        "Upcoming Followup",
        "Jobs",
        "Collab Opportunity",
        "Not Interested",
        "Irrelevant",
        "Not Responding",
        "Future Leads",
        "Price Issue",
        "Installed App",
        "Job Posted",
        "DND",
        "Converted",
        "Others",
      ],
      default: "New Leads",
      index: true,
    },
    status: {
      type: String,
      enum: [
        "New",
        "Missed Call",
        "Follow Up",
        "Not Attended",
        "Not Responding",
        "Priority",
        "Future Leads",
        "Price Issue",
        "Not Interested",
        "Job Seeker",
        "Jobs",
        "Collab Opportunity",
        "Irrelevant",
        "Installed App",
        "Job Posted",
        "DND",
        "Converted",
      ],
      default: "New",
      index: true,
    },
    priorityLevel: {
      type: String,
      enum: ["High", "Regular", "Low"],
      default: "Regular",
    },
    sla: {
      enteredNewAt: { type: Date, default: Date.now },
      firstActionAt: { type: Date, default: null },
      slaBreached: { type: Boolean, default: false, index: true },
      breachedAt: { type: Date, default: null },
    },
    callerReminded: {
      type: Boolean,
      default: false,
    },
    cadence: {
      type: {
        type: String,
        enum: ["None", "Active_NotResponding", "Drip_FutureLeads"],
        default: "None",
      },
      followupCount: { type: Number, default: 0 },
      maxFollowups: { type: Number, default: 5 },
      cadenceStartDate: { type: Date, default: null },
      lastCadenceSentAt: { type: Date, default: null },
      nextCadenceScheduledAt: { type: Date, default: null, index: true },
    },
    collabDetails: {
      notifiedPhone: { type: String, default: "" },
      notifiedAt: { type: Date, default: null },
      notificationStatus: {
        type: String,
        enum: ["pending", "sent", "failed"],
        default: "pending",
      },
    },
    convertedAt: {
      type: Date,
      default: null,
      index: true,
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
      enum: ["Email", "SMS", "WhatsApp", "Phone", "Call",""],
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
    callCount: {
      type: Number,
      default: 0,
      index: true,
    },
    repCallCounts: [
      {
        salespersonId: {
          type: mongoose.Schema.Types.Mixed,
          ref: "User",
        },
        salespersonName: {
          type: String,
          default: "",
        },
        count: {
          type: Number,
          default: 0,
        },
        lastCalledAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    lastCallAt: {
      type: Date,
      default: null,
    },
    callHistory: [
      {
        callEventId: {
          type: String,
          default: null,
          index: true,
        },
        salespersonId: {
          type: mongoose.Schema.Types.Mixed,
          ref: "User",
          default: null,
        },
        salespersonName: {
          type: String,
          default: "",
        },
        callType: {
          type: String,
          default: "outgoing",
        },
        status: {
          type: String,
          default: "connected",
        },
        duration: {
          type: Number,
          default: 0,
        },
        calledAt: {
          type: Date,
          default: Date.now,
        },
        recordingUrl: {
          type: String,
          default: null,
        },
        recordingName: {
          type: String,
          default: null,
        },
        recordingId: {
          type: mongoose.Schema.Types.ObjectId,
          default: null,
        },
      },
    ],
    recordings: [
      {
        callEventId: {
          type: String,
          default: null,
        },
        name: String,
        url: String,
        transcription: String,
        analysis: String,
        analysisStatus: { type: String, default: "pending" }, // pending, completed, failed
        analysisError: String,
        duration: Number,
        salespersonId: {
          type: mongoose.Schema.Types.Mixed,
          ref: "User",
          default: null,
        },
        salespersonName: {
          type: String,
          default: "",
        },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true },
);

// Supports the common lead-list filter and newest-first ordering.
leadSchema.index({ assignedTo: 1, createdAt: -1, _id: -1 });
leadSchema.index({ createdAt: -1, _id: -1 });
leadSchema.index({ service: 1 });
leadSchema.index({ source: 1 });
leadSchema.index({ phoneNormalized: 1, source: 1 });
leadSchema.index({ assignedTo: 1, status: 1 });
leadSchema.index({ status: 1, createdAt: -1 });

const normalizeLeadPhone = function () {
  if (this.phone) {
    this.phoneNormalized = toInternationalPhone(this.phone);
  }
};

leadSchema.pre("save", function setConversionTimestamp() {
  if (this.isModified("status")) {
    this.convertedAt = String(this.status || "").toLowerCase() === "converted" ? new Date() : null;
  }
});

const syncConversionTimestampOnQueryUpdate = function () {
  const update = this.getUpdate();
  if (!update || Array.isArray(update)) return;
  const nextStatus = update.$set?.status ?? update.status;
  if (nextStatus === undefined) return;
  update.$set = update.$set || {};
  update.$set.convertedAt = String(nextStatus).toLowerCase() === "converted" ? new Date() : null;
  this.setUpdate(update);
};
leadSchema.pre("findOneAndUpdate", syncConversionTimestampOnQueryUpdate);
leadSchema.pre("updateOne", syncConversionTimestampOnQueryUpdate);
leadSchema.pre("updateMany", syncConversionTimestampOnQueryUpdate);
leadSchema.pre("validate", normalizeLeadPhone);
leadSchema.pre("save", normalizeLeadPhone);

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
