import mongoose from "mongoose";

const followupSchema = new mongoose.Schema(
  {
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      required: true,
    },
    leadName: {
      type: String,
    },
    type: {
      type: String,
      default: "Call",
    },
    date: {
      type: String, // String to easily match the 'YYYY-MM-DD' HTML format
      required: true,
    },
    time: {
      type: String,
    },
    priority: {
      type: String,
      enum: ["Low", "Medium", "High"],
      default: "Medium",
    },
    notes: {
      type: String,
    },
    author: {
      type: String,
    },
    done: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

// Indexes for fast dashboard aggregations, date-based queries, and lead association
followupSchema.index({ date: 1, done: 1 });
followupSchema.index({ leadId: 1 });
followupSchema.index({ author: 1 });
followupSchema.index({ done: 1, updatedAt: -1 });

followupSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: function (doc, ret) {
    ret.id = ret._id.toString();
    // Also convert leadId to string to match frontend expectations
    ret.leadId = ret.leadId.toString();
    delete ret._id;
  },
});

const Followup = mongoose.model("Followup", followupSchema);
export default Followup;
