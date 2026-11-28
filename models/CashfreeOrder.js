import mongoose from "mongoose";

export const cashfreeOrderSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    orderId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    cfOrderId: {
      type: String,
      default: "",
    },
    paymentSessionId: {
      type: String,
      required: true,
    },
    orderAmount: {
      type: Number,
      required: true,
      min: 1,
    },
    baseAmount: {
      type: Number,
      default: null,
    },
    gstAmount: {
      type: Number,
      default: 0,
    },
    gstRate: {
      type: Number,
      default: 0.18,
    },
    orderCurrency: {
      type: String,
      default: "INR",
    },
    orderStatus: {
      type: String,
      enum: ["ACTIVE", "PAID", "EXPIRED", "TERMINATED", "FAILED", "USER_DROPPED"],
      default: "ACTIVE",
      index: true,
    },
    purpose: {
      type: String,
      enum: ["subscription", "addon", "extra_reps", "wallet_credits", "service"],
      default: "addon",
    },
    planId: {
      type: String,
      default: "",
    },
    addonType: {
      type: String,
      default: "",
    },
    addonTerm: {
      type: String,
      enum: ["quarterly", "yearly", ""],
      default: "",
    },
    addonItems: [
      {
        addonId: { type: String, required: true },
        title: { type: String, default: "" },
        term: { type: String, enum: ["quarterly", "yearly"] },
        baseAmount: { type: Number, min: 0 },
        daysCovered: { type: Number, min: 0 },
        totalTermDays: { type: Number, min: 0 },
        startsAt: { type: Date },
        expiresAt: { type: Date },
      },
    ],
    additionalReps: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalSeats: {
      type: Number,
      default: 5,
    },
    customerDetails: {
      customerId: {
        type: String,
        required: true,
      },
      customerName: {
        type: String,
        default: "",
      },
      companyName: {
        type: String,
        default: "",
      },
      customerEmail: {
        type: String,
        default: "",
      },
      customerPhone: {
        type: String,
        required: true,
      },
    },
    paymentDetails: {
      cfPaymentId: {
        type: String,
        default: "",
      },
      paymentMethod: {
        type: String,
        default: "", // "upi", "card", "netbanking", "wallet"
      },
      bankReference: {
        type: String,
        default: "",
      },
      paymentTime: {
        type: Date,
        default: null,
      },
      paymentCompletionTime: {
        type: Date,
        default: null,
      },
    },
    notes: {
      type: String,
      default: "",
    },
    isFulfilled: {
      type: Boolean,
      default: false,
      index: true,
    },
    receiptEmailSent: {
      type: Boolean,
      default: false,
    },
    rawResponse: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for rapid organization order history and lookup
cashfreeOrderSchema.index({ organizationId: 1, createdAt: -1 });

const CashfreeOrder =
  mongoose.models.CashfreeOrder ||
  mongoose.model("CashfreeOrder", cashfreeOrderSchema);

export default CashfreeOrder;
