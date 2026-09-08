import mongoose from 'mongoose';

const telecallerAnalyticsSchema = new mongoose.Schema(
  {
    salesperson: {
      type: String,
      required: false,
      index: true,
    },
    salespersonId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
      index: true,
    },
    date: {
      type: String, // Format: YYYY-MM-DD
      required: true,
      index: true,
    },
    totalCalls: { type: Number, default: 0 },
    talkTime: { type: Number, default: 0 }, // in seconds
    incoming: { type: Number, default: 0 },
    outgoing: { type: Number, default: 0 },
    missed: { type: Number, default: 0 },
    connected: { type: Number, default: 0 },
    rejected: { type: Number, default: 0 },
    notConnected: { type: Number, default: 0 },
    longestCall: { type: Number, default: 0 }, // max talkTime in a single call for this day
  },
  { timestamps: true }
);

// Create compound index for querying salesperson by date efficiently
telecallerAnalyticsSchema.index({ salespersonId: 1, date: 1 });
telecallerAnalyticsSchema.index({ salesperson: 1, date: 1 });

const TelecallerAnalytics = mongoose.model('TelecallerAnalytics', telecallerAnalyticsSchema);
export default TelecallerAnalytics;
