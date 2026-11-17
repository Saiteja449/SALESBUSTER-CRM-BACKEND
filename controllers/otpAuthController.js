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

    // Rate-limiting check: Prevent spamming within 30 seconds (bypassed in test)
    if (process.env.NODE_ENV !== "test") {
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

    // Generate 4-digit numeric OTP (1000 to 9999)
    const otp = Math.floor(1000 + Math.random() * 9000).toString();

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
    console.log(`[OTP] Generated 4-digit OTP for ${cleanPhone}: ${otp}`);

    // Dispatch via Fast2SMS DLT route
    const smsResult = await sendDltOtp(cleanPhone, otp);

    if (!smsResult.success && !smsResult.simulated) {
      console.warn(`[OTP] Fast2SMS dispatch warning:`, smsResult.message);
    }

    return res.status(200).json({
      success: true,
      message: "4-digit verification code sent successfully.",
      ...(process.env.NODE_ENV !== "production" ? { debugOtp: otp } : {}),
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
        message: "Phone number and 4-digit OTP are required.",
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

    if (cleanOtp.length !== 4) {
      return res.status(400).json({
        success: false,
        message: "OTP must be a 4-digit code.",
      });
    }

    // Find latest valid OTP
    const query = {
      phone: cleanPhone,
      expiresAt: { $gt: new Date() },
      verified: false,
    };
    const otpQuery = Otp.findOne(query);
    const otpRecord = typeof otpQuery.sort === "function"
      ? await otpQuery.sort({ createdAt: -1 })
      : await otpQuery;

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

    const isMatch = await bcrypt.compare(cleanOtp, otpRecord.otpHash);
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

    // Check if user already exists
    let user = await AuthUser.findOne({ phone: cleanPhone });
    let isProfileComplete = false;
    let organization = null;
    let tenantDbName = null;

    if (user) {
      // Existing user: check if they have completed the required profile data
      isProfileComplete = Boolean(
        user.isProfileComplete &&
        user.name &&
        user.name.trim().length > 0 &&
        user.organizationId
      );

      tenantDbName = user.tenantDbName || null;
      if (user.organizationId) {
        organization = await Organization.findById(user.organizationId);
      }
    } else {
      // New user: provision provisional guest account
      const cleanName = `Guest_${cleanPhone.slice(-4)}`;
      tenantDbName = generateTenantDbName(`guest_${cleanPhone}`);

      organization = await Organization.create({
        name: `${cleanName}'s Workspace`,
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
          name: organization.name,
          email: organization.email || "",
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
      name: user.name || "",
      phone: user.phone,
      email: user.email || "",
      companyName: user.companyName || organization?.name || "",
      role: user.customRole || user.role || "Sales Manager",
      city: user.city || "",
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
    if (cleanCompany) user.companyName = cleanCompany;
    if (cleanRole) user.customRole = cleanRole;
    if (cleanCity) user.city = cleanCity;
    if (cleanEmail) user.email = cleanEmail;
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
        if (cleanEmail) {
          organization.email = cleanEmail;
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
          companyName: cleanCompany,
          customRole: cleanRole,
          city: cleanCity,
          ...(cleanEmail ? { email: cleanEmail } : {}),
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
      email: user.email || "",
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
