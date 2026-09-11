import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import User from "../models/User.js";
import { getMasterModels, getTenantModels } from "../services/tenantManager.js";
import { sendLoginAlertEmail } from "../helpers/emailHelper.js";

const generateToken = (payload) => {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: "30d",
  });
};

export const login = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res
      .status(400)
      .json({ success: false, message: "Please provide email and password" });
  }

  const cleanEmail = email.toLowerCase().trim();

  try {
    const { AuthUser, Organization } = getMasterModels();

    // 1. Search in Master AuthUser registry first
    let user = await AuthUser.findOne({ email: cleanEmail });

    // 2. Fallback to default User model for legacy/existing accounts
    let isLegacy = false;
    if (!user) {
      user = await User.findOne({ email: cleanEmail });
      isLegacy = !!user;
    }

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    if (!user.password) {
      return res.status(400).json({
        success: false,
        message:
          "User does not have a password set. Please reset your account or contact an administrator.",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid credentials" });
    }

    // 3. Organization and Subscription status check
    let organizationData = null;
    if (user.organizationId) {
      const org = await Organization.findById(user.organizationId);
      if (org) {
        if (org.status === "inactive" || org.status === "suspended") {
          return res.status(403).json({
            success: false,
            message: `Your organization workspace (${org.name}) is ${org.status}. Please contact administrator.`,
          });
        }

        const now = new Date();
        const isExpired =
          org.subscriptionEndDate && new Date(org.subscriptionEndDate) < now;

        if (isExpired) {
          return res.status(403).json({
            success: false,
            subscriptionExpired: true,
            message: `Your organization's subscription (${org.name}) expired on ${new Date(
              org.subscriptionEndDate
            ).toLocaleDateString("en-IN", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}. Please contact administrator to renew.`,
          });
        }

        // Fetch current live seats used in tenant
        let usedSeats = 0;
        try {
          if (user.tenantDbName) {
            const tenantModels = getTenantModels(user.tenantDbName);
            usedSeats = await tenantModels.User.countDocuments({
              role: "sales person",
            });
          }
        } catch (seatErr) {
          console.error("Error checking tenant seats during login:", seatErr);
        }

        organizationData = {
          id: org._id,
          name: org.name,
          email: org.email,
          mobile: org.mobile,
          website: org.website,
          seats: org.seats,
          usedSeats,
          remainingSeats: Math.max(0, org.seats - usedSeats),
          amountPaid: org.amountPaid,
          subscriptionPlan: org.subscriptionPlan,
          subscriptionStartDate: org.subscriptionStartDate,
          subscriptionEndDate: org.subscriptionEndDate,
          status: org.status,
          isExpired,
          isOrgOwner: !!user.isOrgOwner,
        };
      }
    }

    // 4. Generate JWT with tenant database & organization metadata
    const token = generateToken({
      id: user._id,
      email: user.email,
      role: user.role,
      tenantDbName: user.tenantDbName || null,
      organizationId: user.organizationId || null,
      isOrgOwner: !!user.isOrgOwner,
    });

    // 5. Optional Login Security Alert notification email
    if (process.env.ENABLE_LOGIN_ALERTS === "true") {
      const clientIp =
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        req.socket?.remoteAddress ||
        req.ip ||
        "Unknown IP";
      const userAgent = req.headers["user-agent"] || "Unknown Device";

      sendLoginAlertEmail({
        email: user.email,
        name: user.name,
        ipAddress: clientIp,
        userAgent,
        loginTime: new Date(),
      }).catch((err) => {
        console.error("Failed to dispatch login alert email:", err.message);
      });
    }

    res.status(200).json({
      success: true,
      _id: user._id,
      name: user.name || cleanEmail.split("@")[0],
      email: user.email,
      phone: user.phone || "",
      role: user.role,
      token,
      tenantDbName: user.tenantDbName || null,
      organization: organizationData,
    });
  } catch (error) {
    console.error("Login error:", error);
    res
      .status(500)
      .json({ success: false, message: "Server error while logging in" });
  }
};
