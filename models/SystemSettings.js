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
    addonCatalogConfigured: {
      type: Boolean,
      default: false,
    },
    addonCatalog: [
      {
        id: { type: String, required: true, trim: true },
        title: { type: String, required: true, trim: true },
        price: { type: Number, min: 0 }, // Legacy catalog value, retained for older admin clients.
        quarterlyPrice: { type: Number, min: 0 },
        yearlyPrice: { type: Number, min: 0 },
        period: { type: String, default: "quarterly", trim: true },
        description: { type: String, default: "", trim: true },
        icon: { type: String, default: "Sparkles", trim: true },
        features: [{ type: String, trim: true }],
        isActive: { type: Boolean, default: true },
      },
    ],
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
