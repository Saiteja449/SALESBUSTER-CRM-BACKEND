import mongoose from "mongoose";

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
      enum: ["monthly"],
      default: "monthly",
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
    notes: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  },
);

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
