import mongoose from "mongoose";

export const cashfreeSubscriptionSchema = new mongoose.Schema(
  {
    subscriptionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    cfSubscriptionId: {
      type: String,
      default: null,
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
      index: true,
    },
    planId: {
      type: String,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    gstAmount: {
      type: Number,
      default: 0,
    },
    totalAmount: {
      type: Number,
      required: true,
    },
    intervalType: {
      type: String,
      enum: ["MONTH", "QUARTER", "YEAR"],
      default: "MONTH",
    },
    withTrial: {
      type: Boolean,
      default: false,
    },
    trialEndsAt: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ["INITIALIZED", "BANK_APPROVAL_PENDING", "ACTIVE", "PAUSED", "CANCELLED", "COMPLETED", "EXPIRED"],
      default: "INITIALIZED",
      index: true,
    },
    subscriptionSessionId: {
      type: String,
      default: null,
    },
    authLink: {
      type: String,
      default: null,
    },
    nextChargeAt: {
      type: Date,
      default: null,
    },
    customerEmail: {
      type: String,
      required: true,
    },
    customerPhone: {
      type: String,
      required: true,
    },
    customerName: {
      type: String,
      default: "",
    },
    lastPaymentStatus: {
      type: String,
      default: null,
    },
    lastPaymentAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

const CashfreeSubscription =
  mongoose.models.CashfreeSubscription ||
  mongoose.model("CashfreeSubscription", cashfreeSubscriptionSchema);

export default CashfreeSubscription;
