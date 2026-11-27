import bcrypt from "bcryptjs";
import Otp from "../models/Otp.js";
import { getMasterModels, getTenantModels, generateTenantDbName } from "../services/tenantManager.js";
import { TRIAL_LIMITS } from "../middleware/trialLimitMiddleware.js";

/** Creates a CRM trial workspace after a phone OTP has been verified. */
export const registerTrialWorkspace = async (req, res) => {
  try {
    const { phone, otp, name, email, password, companyName } = req.body || {};
    const cleanPhone = String(phone || "").replace(/\D/g, "").slice(-10);
    const cleanEmail = String(email || "").trim().toLowerCase();
    const cleanName = String(name || "").trim();
    const cleanCompany = String(companyName || cleanName).trim();
    if (cleanPhone.length !== 10 || String(otp || "").trim().length !== 4) {
      return res.status(400).json({ success: false, message: "Enter a valid mobile number and 4-digit verification code." });
    }
    if (cleanName.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || String(password || "").length < 8) {
      return res.status(400).json({ success: false, message: "Enter your name, a valid email address, and a password with at least 8 characters." });
    }

    const otpRecord = await Otp.findOne({ phone: cleanPhone, expiresAt: { $gt: new Date() }, verified: false }).sort({ createdAt: -1 });
    if (!otpRecord || otpRecord.attempts >= 5 || !(await bcrypt.compare(String(otp).trim(), otpRecord.otpHash))) {
      if (otpRecord) {
        otpRecord.attempts = Number(otpRecord.attempts || 0) + 1;
        await otpRecord.save();
      }
      return res.status(400).json({ success: false, message: "The verification code is invalid or expired. Request a new code and try again." });
    }

    const { AuthUser, Organization } = getMasterModels();
    const duplicate = await AuthUser.findOne({ $or: [{ email: cleanEmail }, { phone: cleanPhone }] }).lean();
    const phoneOrg = await Organization.findOne({ mobile: new RegExp(`${cleanPhone}$`) }).lean();
    if (duplicate || phoneOrg) {
      return res.status(409).json({ success: false, message: "An account already uses this email or phone number. Please sign in instead." });
    }

    otpRecord.verified = true;
    await otpRecord.save();

    let tenantDbName = generateTenantDbName(cleanCompany);
    let attempt = 0;
    while (await Organization.findOne({ tenantDbName })) {
      tenantDbName = generateTenantDbName(`${cleanCompany}_${attempt++}`);
      if (attempt > 5) throw new Error("Could not allocate a workspace. Please contact support.");
    }
    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + TRIAL_LIMITS.durationDays * 86400000);
    const hashedPassword = await bcrypt.hash(password, await bcrypt.genSalt(10));
    let org;
    let user;
    try {
      org = await Organization.create({
        name: cleanCompany,
        email: cleanEmail,
        mobile: cleanPhone,
        accountType: "crm",
        seats: TRIAL_LIMITS.maxSeats,
        amountPaid: 0,
        pricingPerSeat: 0,
        subscriptionPlan: "quarterly",
        subscriptionStartDate: now,
        subscriptionEndDate: trialEndsAt,
        isTrial: true,
        trialStartDate: now,
        trialEndsAt,
        trialConverted: false,
        status: "active",
        tenantDbName,
        notes: "Self-serve 3-day free CRM trial started from the website.",
      });
      user = await AuthUser.create({
        email: cleanEmail,
        phone: cleanPhone,
        password: hashedPassword,
        name: cleanName,
        role: "sales manager",
        organizationId: org._id,
        tenantDbName,
        isOrgOwner: true,
        status: "active",
        accountType: "crm",
      });
      org.ownerId = user._id;
      await org.save();
      const tenantModels = getTenantModels(tenantDbName);
      await tenantModels.User.create({
        _id: user._id,
        name: cleanName,
        email: cleanEmail,
        phone: cleanPhone,
        password: hashedPassword,
        role: "sales manager",
        organizationId: org._id,
        isOrgOwner: true,
        status: "active",
        accountType: "crm",
      });
    } catch (provisionError) {
      if (org?._id) await Organization.findByIdAndDelete(org._id).catch(() => {});
      if (user?._id) await AuthUser.findByIdAndDelete(user._id).catch(() => {});
      throw provisionError;
    }

    return res.status(201).json({
      success: true,
      message: "Your 3-day free trial is ready. Sign in to open your workspace.",
      trialEndsAt,
      account: { email: cleanEmail },
    });
  } catch (error) {
    console.error("[TrialSignup] Workspace creation failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Could not create the trial workspace." });
  }
};
