import mongoose from "mongoose";

const authUserSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    password: {
      type: String,
      required: [true, "Password is required"],
    },
    name: {
      type: String,
      trim: true,
      default: "",
    },
    role: {
      type: String,
      enum: ["super_admin", "sales manager", "sales person"],
      default: "sales person",
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

export { authUserSchema };
const AuthUser = mongoose.model("AuthUser", authUserSchema);
export default AuthUser;
