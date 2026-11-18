import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import Otp from "../models/Otp.js";
import { getMasterModels, getTenantModels, generateTenantDbName } from "../services/tenantManager.js";
import { sendDltOtp } from "../services/fast2SmsService.js";

const generateToken = (payload) => {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: "60d",
  });
};

// Default OTP overrides for testing/demo accounts (no SMS is dispatched)
const DEFAULT_OTP_CONFIGS = {
  "8179550538": "1234",
};

const findUserByPhone = async (AuthUser, cleanPhone) => {
  if (!AuthUser) return null;
  const phoneCandidates = [
    cleanPhone,
    `+91${cleanPhone}`,
    `+91 ${cleanPhone}`,
    `91${cleanPhone}`,
    `0${cleanPhone}`,
  ];
  let user = await AuthUser.findOne({ phone: { $in: phoneCandidates } });
  if (!user) {
    try {
      user = await AuthUser.findOne({ phone: new RegExp(cleanPhone + "$") });
    } catch (_) {}
  }
  if (!user && (await import("mongoose")).default.connection?.readyState === 1) {
    try {
      const User = (await import("../models/User.js")).default;
      user = await User.findOne({ phone: { $in: phoneCandidates } });
      if (!user) {
        user = await User.findOne({ phone: new RegExp(cleanPhone + "$") });
      }
    } catch (_) {}
  }
  return user;
};

const findOrgByPhone = async (Organization, cleanPhone) => {
  if (!Organization) return null;
  const phoneCandidates = [
    cleanPhone,
    `+91${cleanPhone}`,
    `+91 ${cleanPhone}`,
    `91${cleanPhone}`,
    `0${cleanPhone}`,
  ];
  let org = await Organization.findOne({ mobile: { $in: phoneCandidates } });
  if (!org) {
    try {
      org = await Organization.findOne({ mobile: new RegExp(cleanPhone + "$") });
    } catch (_) {}
  }
  return org;
};

/**
 * Send 4-digit OTP via Fast2SMS DLT route
 * @route POST /api/auth/send-otp
 */
export const sendOtp = async (req, res) => {
  try {
    const { phone } = req.body || {};

    if (!phone || typeof phone !== "string") {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid 10-digit mobile number.",
      });
    }

    const cleanPhone = phone.replace(/\D/g, "").slice(-10);
    if (cleanPhone.length !== 10) {
      return res.status(400).json({
        success: false,
        message: "Mobile number must be exactly 10 digits.",
      });
    }

    // Strict Gate: Check if phone belongs to an existing CRM / non-guest account
    const { AuthUser, Organization } = getMasterModels();
    const existingUser = await findUserByPhone(AuthUser, cleanPhone);
    const existingOrg = await findOrgByPhone(Organization, cleanPhone);

    let isNonGuest = false;

    // Check Organization level first
    if (existingOrg && existingOrg.accountType && existingOrg.accountType !== "guest") {
      isNonGuest = true;
    }

    // Check User level
    if (existingUser) {
      if (
        existingUser.role === "super_admin" ||
        (existingUser.accountType && existingUser.accountType !== "guest")
      ) {
        isNonGuest = true;
      } else if (existingUser.organizationId) {
        const org = await Organization.findById(existingUser.organizationId);
        if (org && org.accountType && org.accountType !== "guest") {
          isNonGuest = true;
        }
      }
    }

    if (isNonGuest) {
      return res.status(403).json({
        success: false,
        code: "CRM_ACCOUNT_BLOCKED",
        message:
          "This mobile application is strictly for Guest accounts. This account has been upgraded to SalesBuster CRM. Please log in at https://app.salesbuster.ai or use the SalesBuster CRM app.",
      });
    }

    const defaultOtp = DEFAULT_OTP_CONFIGS[cleanPhone];
    const isDefaultPhone = Boolean(defaultOtp);

    // Rate-limiting check: Prevent spamming within 30 seconds (bypassed in test or for default test accounts)
    if (process.env.NODE_ENV !== "test" && !isDefaultPhone) {
      const existingRecentOtp = await Otp.findOne({
        phone: cleanPhone,
        createdAt: { $gt: new Date(Date.now() - 30 * 1000) },
      });

      if (existingRecentOtp) {
        return res.status(429).json({
          success: false,
          message: "Please wait 30 seconds before requesting a new OTP.",
        });
      }
    }

    // Generate numeric OTP (use default OTP for test accounts, otherwise random 4-digit 1000 to 9999)
    const otp = defaultOtp || Math.floor(1000 + Math.random() * 9000).toString();

    // Hash OTP with bcrypt
    const salt = await bcrypt.genSalt(10);
    const otpHash = await bcrypt.hash(otp, salt);

    // Invalidate previous unverified OTPs for this phone
    await Otp.deleteMany({ phone: cleanPhone, verified: false });

    // Store in DB with 10-minute expiry
    await Otp.create({
      phone: cleanPhone,
      otpHash,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    // Console logging in dev / test mode for effortless testing
    if (isDefaultPhone) {
      console.log(`[OTP] Default OTP set for ${cleanPhone}: ${otp}. SMS dispatch suppressed.`);
    } else {
      console.log(`[OTP] Generated 4-digit OTP for ${cleanPhone}: ${otp}`);
    }

    // Dispatch via Fast2SMS DLT route (skip SMS for default test accounts)
    if (!isDefaultPhone) {
      const smsResult = await sendDltOtp(cleanPhone, otp);

      if (!smsResult.success && !smsResult.simulated) {
        console.warn(`[OTP] Fast2SMS dispatch warning:`, smsResult.message);
      }
    }

    return res.status(200).json({
      success: true,
      message: isDefaultPhone
        ? "Verification code sent successfully."
        : "4-digit verification code sent successfully.",
      ...(process.env.NODE_ENV !== "production" || isDefaultPhone ? { debugOtp: otp } : {}),
    });
  } catch (error) {
    console.error("Error in sendOtp:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to send OTP. Please try again.",
    });
  }
};

/**
 * Verify 4-digit OTP and check user registration completion
 * @route POST /api/auth/verify-otp
 */
export const verifyOtp = async (req, res) => {
  try {
    const { phone, otp } = req.body || {};

    if (!phone || !otp) {
      return res.status(400).json({
        success: false,
        message: "Phone number and OTP code are required.",
      });
    }

    const cleanPhone = String(phone).replace(/\D/g, "").slice(-10);
    const cleanOtp = String(otp).trim();

    if (cleanPhone.length !== 10) {
      return res.status(400).json({
        success: false,
        message: "Invalid phone number format.",
      });
    }

    const defaultOtp = DEFAULT_OTP_CONFIGS[cleanPhone];
    const isDefaultPhone = Boolean(defaultOtp);

    // Validate OTP length (standard: 4 digits; default test account: defaultOtp length or 4 digits)
    const isValidLength =
      cleanOtp.length === 4 ||
      (isDefaultPhone && cleanOtp.length === defaultOtp.length);

    if (!isValidLength) {
      return res.status(400).json({
        success: false,
        message: isDefaultPhone
          ? `OTP must be a 4-digit or ${defaultOtp.length}-digit code.`
          : "OTP must be a 4-digit code.",
      });
    }

    // Find latest valid OTP
    const query = {
      phone: cleanPhone,
      expiresAt: { $gt: new Date() },
      verified: false,
    };
    const otpQuery = Otp.findOne(query);
    let otpRecord = typeof otpQuery.sort === "function"
      ? await otpQuery.sort({ createdAt: -1 })
      : await otpQuery;

    // For default test phone, if no active OTP record exists, auto-provision one
    if (!otpRecord && isDefaultPhone && (cleanOtp === defaultOtp || cleanOtp === defaultOtp.slice(0, 4))) {
      const salt = await bcrypt.genSalt(10);
      const otpHash = await bcrypt.hash(defaultOtp, salt);
      otpRecord = await Otp.create({
        phone: cleanPhone,
        otpHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });
    }

    if (!otpRecord) {
      return res.status(400).json({
        success: false,
        message: "OTP has expired or is invalid. Please request a new one.",
      });
    }

    if (otpRecord.attempts >= 5) {
      await Otp.deleteOne({ _id: otpRecord._id });
      return res.status(429).json({
        success: false,
        message: "Too many incorrect attempts. Please request a new OTP.",
      });
    }

    let isMatch = false;
    if (isDefaultPhone && (cleanOtp === defaultOtp || cleanOtp === defaultOtp.slice(0, 4))) {
      isMatch = true;
    } else {
      isMatch = await bcrypt.compare(cleanOtp, otpRecord.otpHash);
    }

    if (!isMatch) {
      otpRecord.attempts += 1;
      await otpRecord.save();
      return res.status(400).json({
        success: false,
        message: "Incorrect OTP code. Please check and try again.",
      });
    }

    // Mark OTP as verified
    otpRecord.verified = true;
    await otpRecord.save();

    const { AuthUser, Organization } = getMasterModels();

    let user = await findUserByPhone(AuthUser, cleanPhone);
    let organization = await findOrgByPhone(Organization, cleanPhone);

    // Strict Guest-only gate: reject CRM accounts
    let isNonGuest = false;

    if (organization && organization.accountType && organization.accountType !== "guest") {
      isNonGuest = true;
    }

    if (user) {
      if (
        user.role === "super_admin" ||
        (user.accountType && user.accountType !== "guest")
      ) {
        isNonGuest = true;
      } else if (user.organizationId) {
        const userOrg = await Organization.findById(user.organizationId);
        if (userOrg && userOrg.accountType && userOrg.accountType !== "guest") {
          isNonGuest = true;
        }
        if (!organization) organization = userOrg;
      }
    }

    if (isNonGuest) {
      return res.status(403).json({
        success: false,
        code: "CRM_ACCOUNT_BLOCKED",
        message:
          "This mobile application is strictly for Guest accounts. This account has been upgraded to SalesBuster CRM. Please log in at https://crm.salesbuster.ai or use the SalesBuster CRM app.",
      });
    }

    // If user wasn't directly found by phone, but guest organization exists, link through ownerId
    if (!user && organization && organization.ownerId) {
      user = await AuthUser.findById(organization.ownerId);
      if (user && !user.phone) {
        user.phone = cleanPhone;
        await user.save().catch(() => {});
      }
    }

    let isProfileComplete = false;
    let tenantDbName = null;

    if (user) {
      // Existing guest user: check if they have completed registration details
      isProfileComplete = Boolean(
        user.isProfileComplete ||
        (user.name &&
          user.name.trim().length > 0 &&
          !user.name.startsWith("Guest_") &&
          user.companyName &&
          !user.companyName.includes("'s Workspace") &&
          user.city)
      );

      // Ensure isProfileComplete is persisted
      if (isProfileComplete && !user.isProfileComplete) {
        user.isProfileComplete = true;
        await user.save().catch(() => {});
      }

      tenantDbName = user.tenantDbName || null;
      if (!organization && user.organizationId) {
        organization = await Organization.findById(user.organizationId);
      }
    } else {
      // New user: provision provisional guest account
      const cleanName = `Guest_${cleanPhone.slice(-4)}`;
      const placeholderEmail = `${cleanPhone}@guest.salesbuster.ai`;
      tenantDbName = generateTenantDbName(`guest_${cleanPhone}`);

      organization = await Organization.create({
        name: `${cleanName}'s Workspace`,
        email: placeholderEmail,
        mobile: cleanPhone,
        accountType: "guest",
        seats: 1,
        amountPaid: 0,
        pricingPerSeat: 0,
        subscriptionPlan: "monthly",
        status: "active",
        tenantDbName,
        notes: "Self-registered guest via 4-digit OTP",
      });

      user = await AuthUser.create({
        phone: cleanPhone,
        email: placeholderEmail,
        name: "",
        role: "sales manager",
        organizationId: organization._id,
        tenantDbName,
        isOrgOwner: true,
        status: "active",
        isProfileComplete: false,
      });

      organization.ownerId = user._id;
      await organization.save();

      // Provision tenant DB user
      try {
        const tenantModels = getTenantModels(tenantDbName);
        await tenantModels.User.create({
          _id: user._id,
          phone: cleanPhone,
          name: "",
          role: "sales manager",
          organizationId: organization._id,
          isOrgOwner: true,
          status: "active",
          isProfileComplete: false,
        });
      } catch (tenantErr) {
        console.error("Failed to seed initial tenant user for OTP signup:", tenantErr);
      }

      isProfileComplete = false;
    }

    // Organization data formatting
    const orgData = organization
      ? {
          id: organization._id,
          _id: organization._id,
          name: isProfileComplete ? organization.name : "",
          email: organization.email?.includes("@guest.salesbuster.ai") ? "" : organization.email || "",
          mobile: organization.mobile || cleanPhone,
          accountType: organization.accountType || "guest",
          status: organization.status,
          isOrgOwner: true,
        }
      : null;

    const token = generateToken({
      id: user._id,
      phone: user.phone,
      role: user.role || "sales manager",
      tenantDbName: user.tenantDbName,
      organizationId: user.organizationId,
      isOrgOwner: true,
      accountType: "guest",
    });

    return res.status(200).json({
      success: true,
      token,
      _id: user._id,
      id: user._id,
      name: isProfileComplete ? (user.name || "") : "",
      phone: user.phone || cleanPhone,
      email: user.email?.includes("@guest.salesbuster.ai") ? "" : user.email || "",
      companyName: isProfileComplete ? (user.companyName || "") : "",
      role: isProfileComplete ? (user.customRole || user.role || "") : "",
      city: isProfileComplete ? (user.city || "") : "",
      accountType: "guest",
      isOrgOwner: true,
      isProfileComplete,
      tenantDbName: user.tenantDbName,
      organization: orgData,
    });
  } catch (error) {
    console.error("Error in verifyOtp:", error);
    return res.status(500).json({
      success: false,
      message: "Server error during OTP verification.",
    });
  }
};

/**
 * Complete user profile data collected by Speech Model
 * Captures Name, Company Name, Role, City, and optional Email
 * @route POST /api/auth/complete-profile
 */
export const completeProfile = async (req, res) => {
  try {
    const { name, companyName, role, city, email } = req.body || {};

    const userId = req.user?._id || req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized. Please authenticate with OTP first.",
      });
    }

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Full name is required.",
      });
    }

    const cleanName = name.trim();
    const cleanCompany = (companyName || "").trim();
    const cleanRole = (role || "").trim();
    const cleanCity = (city || "").trim();
    let cleanEmail = (email || "").trim().toLowerCase();

    // Validate email format if provided
    if (cleanEmail) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(cleanEmail)) {
        return res.status(400).json({
          success: false,
          message: "Please provide a valid email address.",
        });
      }

      const { AuthUser } = getMasterModels();
      const existingUserWithEmail = await AuthUser.findOne({
        email: cleanEmail,
        _id: { $ne: userId },
      });

      if (existingUserWithEmail) {
        return res.status(409).json({
          success: false,
          message: "This email address is already associated with another account.",
        });
      }
    } else {
      cleanEmail = undefined;
    }

    const { AuthUser, Organization } = getMasterModels();
    const user = await AuthUser.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User profile not found.",
      });
    }

    // Update Master AuthUser
    user.name = cleanName;
    if (companyName !== undefined) user.companyName = cleanCompany;
    if (role !== undefined) user.customRole = cleanRole;
    if (city !== undefined) user.city = cleanCity;
    if (email !== undefined) user.email = cleanEmail || "";
    user.isProfileComplete = true;
    await user.save();

    // Update Organization Workspace
    let organization = null;
    if (user.organizationId) {
      organization = await Organization.findById(user.organizationId);
      if (organization) {
        if (cleanCompany) {
          organization.name = cleanCompany;
        } else if (cleanName) {
          organization.name = `${cleanName}'s Workspace`;
        }
        if (email !== undefined) {
          organization.email = cleanEmail || "";
        }
        await organization.save();
      }
    }

    // Update Tenant DB User if tenant is initialized
    if (user.tenantDbName) {
      try {
        const tenantModels = getTenantModels(user.tenantDbName);
        await tenantModels.User.findByIdAndUpdate(user._id, {
          name: cleanName,
          ...(companyName !== undefined ? { companyName: cleanCompany } : {}),
          ...(role !== undefined ? { customRole: cleanRole } : {}),
          ...(city !== undefined ? { city: cleanCity } : {}),
          ...(email !== undefined ? { email: cleanEmail || "" } : {}),
          isProfileComplete: true,
        });
      } catch (tErr) {
        console.error("Failed to sync tenant user on profile complete:", tErr);
      }
    }

    // Generate updated JWT token
    const token = generateToken({
      id: user._id,
      phone: user.phone,
      email: user.email,
      role: user.role || "sales manager",
      tenantDbName: user.tenantDbName,
      organizationId: user.organizationId,
      isOrgOwner: true,
      accountType: "guest",
    });

    const orgData = organization
      ? {
          id: organization._id,
          _id: organization._id,
          name: organization.name,
          email: organization.email || "",
          mobile: organization.mobile || user.phone,
          accountType: organization.accountType || "guest",
          status: organization.status,
          isOrgOwner: true,
        }
      : null;

    return res.status(200).json({
      success: true,
      message: "Profile registration completed successfully.",
      token,
      _id: user._id,
      id: user._id,
      name: user.name,
      phone: user.phone,
      email: user.email?.includes("@guest.salesbuster.ai") ? "" : user.email || "",
      companyName: user.companyName || organization?.name || "",
      role: user.customRole || user.role || "Sales Manager",
      city: user.city || "",
      accountType: "guest",
      isOrgOwner: true,
      isProfileComplete: true,
      tenantDbName: user.tenantDbName,
      organization: orgData,
    });
  } catch (error) {
    console.error("Error in completeProfile:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while saving profile details.",
    });
  }
};
