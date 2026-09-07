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
