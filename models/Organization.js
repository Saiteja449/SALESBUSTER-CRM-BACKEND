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
  const isKranthi =
    /kranthi|elevator/i.test(orgName) ||
    orgName.toLowerCase().includes("kranthi");

  if (isKranthi) {
    return {
      companyName: "Kranthi Elevators",
      businessDescription:
        "Kranthi Elevators designs, manufactures, installs, and maintains advanced, precision-engineered elevator solutions in and around Hyderabad across residential, commercial, industrial, and healthcare segments.",
      agentPersona:
        "friendly, human sales representative working at Kranthi Elevators",
      customInstructions: `1. HUMAN TONE: Communicate EXACTLY like a real human. Be warm, polite, and conversational. NEVER mention that you are an AI or bot.
2. PACING: Ask at most 1-2 friendly questions per message to gather data naturally without overwhelming the user.
3. PRICING RULE: Do NOT provide, guess, estimate, negotiate, or invent pricing, since all lifts are customized to building specs. State that pricing depends on the lift model, capacity, floors, and site requirements, and schedule a callback with our engineering team.
4. LIFECYCLE & AMC: Kranthi Elevators supports planning, custom engineering, installation, preventative maintenance, and 24/7 breakdown support.
5. HUMAN HANDOFF: If the user asks for human support or says 'yes' to human assistance, politely transfer them and set disableAI=true.
6. WHATSAPP FORMATTING: Keep messages short (maximum 50-60 words), clean bullet points, bold key terms (*term*), and emojis.`,
      qdrantCollection: "kranthi_kb",
      services: [
        {
          name: "Passenger Lift",
          description:
            "Safe, smooth, and quiet vertical transportation for apartments, offices, shopping complexes, and hotels.",
          keywords: ["passenger", "apartment", "office", "residential", "complex"],
        },
        {
          name: "MRL Lift",
          description:
            "Machine Room Less modern, space-saving design with all components integrated in the shaft.",
          keywords: ["mrl", "machine room less", "no machine room", "space saving"],
        },
        {
          name: "Hydraulic Lift",
          description:
            "Smooth, powerful lifting with strong load capacity for villas, warehouses, and low-rise buildings.",
          keywords: ["hydraulic", "villa", "home lift", "warehouse", "industrial"],
        },
        {
          name: "Hospital Bed Lift",
          description:
            "Specially designed for hospitals to transport patients, stretchers, and medical equipment smoothly.",
          keywords: ["hospital", "bed lift", "stretcher", "medical", "clinic"],
        },
        {
          name: "Elevator Maintenance & AMC",
          description:
            "Lifecycle support, preventative maintenance, and 24/7 breakdown support handled by experienced technicians.",
          keywords: ["amc", "maintenance", "service", "repair", "breakdown"],
        },
        {
          name: "Elevator Modernization",
          description:
            "Upgrading or replacing old elevators with modern, energy-efficient solutions.",
          keywords: ["moderniz", "modernis", "upgrade", "replacement", "replace"],
        },
      ],
      qualificationFields: [
        {
          key: "liftType",
          label: "Lift / Product Type",
          type: "string",
          description:
            "Type of elevator product: 'Passenger Lift', 'MRL Lift', 'Hydraulic Lift', 'Hospital Bed Lift', 'Elevator Maintenance & AMC', 'Elevator Modernization', or empty string.",
        },
        {
          key: "clientType",
          label: "Client Role",
          type: "string",
          description:
            "Role/Segment of the lead: 'Building Owner / Villa Owner', 'Builder / Developer', 'Architect / Consultant', 'Hospital / Healthcare Admin', 'Facility / Society Manager (RWA)', or 'General'.",
        },
        {
          key: "propertyType",
          label: "Building Type",
          type: "string",
          description:
            "Type of building: 'Apartment', 'Villa / Independent House', 'Commercial Office', 'Shopping Mall / Complex', 'Hotel', 'Hospital / Healthcare Center', 'Warehouse / Industrial Unit'.",
        },
        {
          key: "numberOfFloors",
          label: "Number of Floors",
          type: "string",
          description:
            "Number of floors or stops (e.g., 'G+2', 'G+3', '4 Floors', '8 Stops').",
        },
        {
          key: "capacity",
          label: "Capacity / Load",
          type: "string",
          description:
            "Passenger capacity or weight load (e.g., '4-6 Persons', '8-10 Persons', '13 Persons', '1000 kg', '2-10 Tons').",
        },
        {
          key: "constructionStage",
          label: "Construction Stage",
          type: "string",
          description:
            "Project stage: 'Under Construction (Shaft Planned/Ready)', 'Existing Building (Retrofit/New Lift)', 'Modernization (Replacing Old Lift)', or 'Operational (AMC/Service)'.",
        },
        {
          key: "doorType",
          label: "Door Preference",
          type: "string",
          description:
            "Door preference: 'Automatic (Center Opening)', 'Automatic (Telescopic)', 'Manual', or empty string.",
        },
        {
          key: "machineRoomAvailable",
          label: "Machine Room Provision",
          type: "string",
          description:
            "Machine room availability: 'Yes', 'No' (MRL recommended), or 'Unknown'.",
        },
        {
          key: "preferredVisitDate",
          label: "Preferred Visit Date",
          type: "string",
          description: "Preferred date for site visit / shaft inspection.",
        },
      ],
      knowledgeDocs: [],
      isAiConfigured: true,
      aiSetupCompletedAt: new Date("2024-01-01"),
    };
  }

  return {
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
        name: "General Consultation",
        description: "Initial consultation and enquiry about products and services.",
        keywords: ["consultation", "enquiry", "information", "help"],
      },
    ],
    qualificationFields: [
      {
        key: "requirementDetails",
        label: "Requirement Details",
        type: "string",
        description: "Specific details about customer requirements and expectations.",
      },
      {
        key: "preferredTime",
        label: "Preferred Contact Time",
        type: "string",
        description: "Best callback time or date requested by customer.",
      },
    ],
    knowledgeDocs: [],
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
