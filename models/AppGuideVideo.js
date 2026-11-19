import mongoose from "mongoose";

export const appGuideVideoSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: "default_tour",
      unique: true,
      trim: true,
    },
    title: {
      type: String,
      default: "Create Your Event First",
      trim: true,
    },
    subtitle: {
      type: String,
      default: "Group your leads by expo, conference, or roadshow. Pre-load your marketing collateral and welcome messages.",
      trim: true,
    },
    videoUrl: {
      type: String,
      default: "",
      trim: true,
    },
    bannerImageUrl: {
      type: String,
      default: "",
      trim: true,
    },
    fallbackBg: {
      type: String,
      default: "#0B0A1F",
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    stepIndex: {
      type: Number,
      default: 0,
    },
    steps: {
      type: [
        {
          stepIndex: Number,
          badgeText: String,
          title: String,
          subtitle: String,
          videoUrl: String,
          bannerImageUrl: String,
        },
      ],
      default: [],
    },
    updatedBy: {
      type: String,
      default: "Super Admin",
    },
  },
  {
    timestamps: true,
  }
);

appGuideVideoSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: function (doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
  },
});

const AppGuideVideo = mongoose.model("AppGuideVideo", appGuideVideoSchema);
export default AppGuideVideo;
