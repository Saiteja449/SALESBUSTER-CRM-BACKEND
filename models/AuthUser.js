import mongoose from "mongoose";

const authUserSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: false,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: false,
    },
    name: {
      type: String,
      trim: true,
      default: "",
    },
    role: {
      type: String,
      enum: ["super_admin", "developer", "sales manager", "sales person"],
      default: "sales person",
      index: true,
    },
    customRole: {
      type: String,
      trim: true,
      default: "",
    },
    companyName: {
      type: String,
      trim: true,
      default: "",
    },
    city: {
      type: String,
      trim: true,
      default: "",
    },
    isProfileComplete: {
      type: Boolean,
      default: false,
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      index: true,
    },
    tenantDbName: {
      type: String,
      trim: true,
      lowercase: true,
    },
    isOrgOwner: {
      type: Boolean,
      default: false,
    },
    phone: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    aiAutoReplyEnabled: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  },
);

authUserSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: function (doc, ret) {
    ret.id = ret._id.toString();
    delete ret.password;
    delete ret._id;
  },
});

authUserSchema.index(
  { email: 1 },
  {
    unique: true,
    partialFilterExpression: {
      email: { $exists: true, $type: "string", $gt: "" },
    },
  }
);

authUserSchema.index(
  { phone: 1 },
  {
    unique: true,
    partialFilterExpression: {
      phone: { $exists: true, $type: "string", $gt: "" },
    },
  }
);

export { authUserSchema };
const AuthUser = mongoose.model("AuthUser", authUserSchema);
export default AuthUser;
