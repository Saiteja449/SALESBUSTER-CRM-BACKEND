import mongoose from "mongoose";

const userSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: false,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: ["sales manager", "sales person", "super_admin"],
      default: "sales person",
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
    },
    isOrgOwner: {
      type: Boolean,
      default: false,
    },
    phone: {
      type: String,
      default: "",
    },
    whatsappLine1Phone: { type: String, default: "", trim: true },
    whatsappLine2Phone: { type: String, default: "", trim: true },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    telephony: {
      telecmiUserId: {
        type: String,
        default: "",
        trim: true,
      },
      telecmiPassword: {
        type: String,
        default: "",
      },
      telecmiExtension: {
        type: String,
        default: "",
        trim: true,
      },
      isActive: {
        type: Boolean,
        default: true,
      },
      isCloudEnabled: {
        type: Boolean,
        default: false,
      },
    },
  },
  {
    timestamps: true,
  },
);

const User = mongoose.model("User", userSchema);

export default User;
