import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import User from "../models/User.js";
import { getMasterModels, getTenantModels, generateTenantDbName } from "../services/tenantManager.js";
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
          org.accountType !== "guest" &&
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
          accountType: org.accountType || "crm",
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
      accountType: organizationData?.accountType || "crm",
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
      accountType: organizationData?.accountType || "crm",
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


/**
 * Guest Registration Controller
 * Provisions a self-registered guest account with 1 master org, 1 master auth user, and tenant DB.
 * Access restricted strictly to Conversational Event & Contact Capture (CRM APIs gated).
 * @route POST /api/auth/guest-register
 */
export const guestRegister = async (req, res) => {
  try {
    const { name, email, phone, password } = req.body || {};

    // 1. Disallow forbidden / untrusted privilege fields in body
    const forbiddenFields = [
      "role",
      "accountType",
      "organizationId",
      "tenantDbName",
      "seats",
      "amountPaid",
      "subscriptionPlan",
      "isOrgOwner",
      "status",
      "pricingPerSeat",
    ];
    for (const field of forbiddenFields) {
      if (req.body && req.body[field] !== undefined) {
        return res.status(400).json({
          success: false,
          code: "VALIDATION_ERROR",
          message: `Field '${field}' is not allowed during guest registration.`,
        });
      }
    }

    // 2. Validate input fields
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({
        success: false,
        code: "VALIDATION_ERROR",
        message: "Full name is required.",
      });
    }

    const cleanName = name.trim();
    if (cleanName.length < 2 || cleanName.length > 100) {
      return res.status(400).json({
        success: false,
        code: "VALIDATION_ERROR",
        message: "Name must be between 2 and 100 characters.",
      });
    }

    if (!email || typeof email !== "string" || !email.trim()) {
      return res.status(400).json({
        success: false,
        code: "VALIDATION_ERROR",
        message: "Email address is required.",
      });
    }

    const cleanEmail = email.toLowerCase().trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail) || cleanEmail.length > 150) {
      return res.status(400).json({
        success: false,
        code: "VALIDATION_ERROR",
        message: "Please provide a valid email address.",
      });
    }

    if (!phone || typeof phone !== "string" || !phone.trim()) {
      return res.status(400).json({
        success: false,
        code: "VALIDATION_ERROR",
        message: "Phone number is required.",
      });
    }

    const rawPhoneDigits = phone.replace(/\D/g, "");
    if (rawPhoneDigits.length < 10) {
      return res.status(400).json({
        success: false,
        code: "VALIDATION_ERROR",
        message: "Phone number must have at least 10 digits.",
      });
    }
    const cleanPhone = rawPhoneDigits.slice(-10);

    if (!password || typeof password !== "string") {
      return res.status(400).json({
        success: false,
        code: "VALIDATION_ERROR",
        message: "Password is required.",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        code: "PASSWORD_POLICY",
        message: "Password must be at least 6 characters.",
      });
    }

    const { AuthUser, Organization } = getMasterModels();

    // 3. Pre-check uniqueness for clean email & phone
    const existingEmail = await AuthUser.findOne({ email: cleanEmail });
    if (existingEmail) {
      return res.status(409).json({
        success: false,
        code: "ACCOUNT_ALREADY_EXISTS",
        message: "An account with this email address already exists.",
      });
    }

    const existingPhone = await AuthUser.findOne({ phone: cleanPhone });
    if (existingPhone) {
      return res.status(409).json({
        success: false,
        code: "ACCOUNT_ALREADY_EXISTS",
        message: "An account with this phone number already exists.",
      });
    }

    // 4. Generate unique tenant database name
    let tenantDbName = generateTenantDbName(`guest_${cleanName}`);
    let attempts = 0;
    while (await Organization.findOne({ tenantDbName })) {
      tenantDbName = generateTenantDbName(`guest_${cleanName}`);
      attempts++;
      if (attempts > 5) break;
    }

    // 5. Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // 6. Provision Organization in Master DB
    let organization;
    let masterAuthUser;
    let tenantUser;

    try {
      organization = await Organization.create({
        name: cleanName,
        email: cleanEmail,
        mobile: cleanPhone,
        accountType: "guest",
        seats: 1,
        amountPaid: 0,
        pricingPerSeat: 0,
        subscriptionPlan: "monthly",
        status: "active",
        tenantDbName,
        notes: "Guest self-registered from mobile app",
      });

      // 7. Register Owner in Master AuthUser registry
      masterAuthUser = await AuthUser.create({
        email: cleanEmail,
        password: hashedPassword,
        name: cleanName,
        phone: cleanPhone,
        role: "sales manager",
        organizationId: organization._id,
        tenantDbName,
        isOrgOwner: true,
        status: "active",
      });

      // 8. Initialize tenant database models and create Owner in tenant DB
      const tenantModels = getTenantModels(tenantDbName);
      tenantUser = await tenantModels.User.create({
        _id: masterAuthUser._id,
        name: cleanName,
        email: cleanEmail,
        phone: cleanPhone,
        password: hashedPassword,
        role: "sales manager",
        organizationId: organization._id,
        isOrgOwner: true,
        status: "active",
      });

      // 9. Update organization with owner reference
      organization.ownerId = masterAuthUser._id;
      await organization.save();
    } catch (provisionErr) {
      // Compensating rollback if partial records created
      if (organization?._id) {
        await Organization.findByIdAndDelete(organization._id).catch(() => {});
      }
      if (masterAuthUser?._id) {
        await AuthUser.findByIdAndDelete(masterAuthUser._id).catch(() => {});
      }
      if (tenantDbName && tenantUser?._id) {
        try {
          const tenantModels = getTenantModels(tenantDbName);
          await tenantModels.User.findByIdAndDelete(tenantUser._id).catch(() => {});
        } catch (_) {}
      }

      if (provisionErr.code === 11000) {
        return res.status(409).json({
          success: false,
          code: "ACCOUNT_ALREADY_EXISTS",
          message: "An account with this email or phone number already exists.",
        });
      }

      console.error("[guestRegister] Provisioning error:", provisionErr);
      return res.status(500).json({
        success: false,
        code: "SERVICE_UNAVAILABLE",
        message: "Failed to initialize guest account workspace. Please try again.",
      });
    }

    // 10. Generate token
    const token = generateToken({
      id: masterAuthUser._id,
      email: masterAuthUser.email,
      role: masterAuthUser.role,
      tenantDbName,
      organizationId: organization._id,
      isOrgOwner: true,
      accountType: "guest",
    });

    const organizationData = {
      id: organization._id,
      name: organization.name,
      email: organization.email,
      mobile: organization.mobile,
      accountType: "guest",
      seats: 1,
      status: "active",
      isOrgOwner: true,
    };

    return res.status(201).json({
      success: true,
      message: "Guest account registered successfully.",
      _id: masterAuthUser._id,
      name: masterAuthUser.name,
      email: masterAuthUser.email,
      phone: masterAuthUser.phone,
      role: masterAuthUser.role,
      accountType: "guest",
      token,
      tenantDbName,
      organization: organizationData,
    });
  } catch (error) {
    console.error("[guestRegister] Server error:", error);
    return res.status(500).json({
      success: false,
      code: "SERVER_ERROR",
      message: "Server error while creating guest account.",
    });
  }
};
