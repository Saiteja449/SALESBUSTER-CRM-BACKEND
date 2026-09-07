import mongoose from "mongoose";

const aiLogSchema = new mongoose.Schema(
  {
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      index: true,
    },
    prompt: {
      type: String,
      required: true,
    },
    response: {
      type: String,
      required: true,
    },
    model: {
      type: String,
      required: true,
    },
    tokensUsed: {
      type: Number,
      default: 0,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

aiLogSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: function (doc, ret) {
    ret.id = ret._id.toString();
    if (ret.leadId) ret.leadId = ret.leadId.toString();
    delete ret._id;
  },
});

const AILog = mongoose.model("AILog", aiLogSchema);
export default AILog;
