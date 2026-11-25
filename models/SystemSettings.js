import mongoose from "mongoose";

const systemSettingsSchema = new mongoose.Schema(
  {
    globalAIEnabled: {
      type: Boolean,
      default: true,
    },
    welcomeMessageEnabled: {
      type: Boolean,
      default: true,
    },
    welcomeMessageTemplate: {
      type: String,
      default: "",
    },
    welcomeMessageFallbackService: {
      type: String,
      default: "",
    },
    missedCallMessageEnabled: {
      type: Boolean,
      default: true,
    },
    missedCallMessageTemplate: {
      type: String,
      default: "",
    },
    missedCallDifferentNumberTemplate: {
      type: String,
      default: "",
    },
    gstRate: {
      type: Number,
      default: 18, // Configurable GST percentage (e.g. 18 for 18%)
      min: 0,
      max: 100,
    },
    extraRepMonthlyPriceYearly: {
      type: Number,
      default: 899, // ₹899/month for yearly plan (₹10,788/yr)
      min: 0,
    },
    extraRepMonthlyPriceQuarterly: {
      type: Number,
      default: 1199, // ₹1,199/month for quarterly plan (₹3,597/quarter)
      min: 0,
    },
    updatedBy: {
      type: String,
      default: "System",
    },
  },
  { timestamps: true }
);

systemSettingsSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: function (doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
  },
});

const SystemSettings = mongoose.model("SystemSettings", systemSettingsSchema);
export default SystemSettings;
