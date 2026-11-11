import mongoose from "mongoose";

export const showcaseServiceSchema = new mongoose.Schema(
  {
    serviceKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    tag: {
      type: String,
      default: "Analytics",
      trim: true,
    },
    imageUrl: {
      type: String,
      default: "",
      trim: true,
    },
    fallbackBg: {
      type: String,
      default: "#1A1838",
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    features: {
      type: [String],
      default: [],
    },
    order: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AuthUser",
      default: null,
    },
    createdByName: {
      type: String,
      default: "Super Admin",
    },
  },
  {
    timestamps: true,
  }
);

showcaseServiceSchema.index({ order: 1, createdAt: 1 });

const ShowcaseService = mongoose.model("ShowcaseService", showcaseServiceSchema);
export default ShowcaseService;

