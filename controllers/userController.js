import bcrypt from "bcryptjs";
import User from "../models/User.js";
import Lead from "../models/Lead.js";
import Notification from "../models/Notification.js";
import { getMasterModels, generateSecurePassword } from "../services/tenantManager.js";
import { sendSalesPersonWelcomeEmail } from "../helpers/emailHelper.js";
import {
  validateAndNormalizePhone,
  buildPhoneDuplicateQuery,
} from "../helpers/phoneHelper.js";

// Helper to resolve models
const getModels = (req) => {
  return {
    UserModel: req.tenantModels?.User || User,
    LeadModel: req.tenantModels?.Lead || Lead,
    NotificationModel: req.tenantModels?.Notification || Notification,
  };
};

// @desc    Get all sales representatives in tenant organization
// @route   GET /api/users
// @access  Protected
export const getUsers = async (req, res) => {
  try {
    const { UserModel } = getModels(req);
    const users = await UserModel.find({ role: "sales person" }).select(
      "-password"
    );

    // If organization is known, return seat usage metadata
    let seatMeta = null;
    if (req.organization) {
      const usedSeats = users.length;
      const totalSeats = req.organization.seats || 1;
      seatMeta = {
        totalSeats,
        usedSeats,
        remainingSeats: Math.max(0, totalSeats - usedSeats),
        isLimitReached: usedSeats >= totalSeats,
      };
    }

    res.status(200).json({
      success: true,
      data: users,
      seats: seatMeta,
      organization: req.organization
        ? {
            id: req.organization._id,
            name: req.organization.name,
            seats: req.organization.seats,
            subscriptionPlan: req.organization.subscriptionPlan,
            subscriptionStartDate: req.organization.subscriptionStartDate,
            subscriptionEndDate: req.organization.subscriptionEndDate,
            status: req.organization.status,
          }
        : null,
    });
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching users",
    });
  }
};

// @desc    Add a new Sales Representative (Enforces Seat Limit, generates password, and sends credentials via email)
// @route   POST /api/users
// @access  Protected
export const addSalesPerson = async (req, res) => {
  const isAuthorized =
    req.user?.role === "sales manager" ||
    req.user?.role === "super_admin" ||
    req.user?.isOrgOwner;

  if (!isAuthorized) {
    return res.status(403).json({
      success: false,
      message:
        "Access forbidden: Only sales managers or organization owners can add sales representatives.",
    });
  }

  const { name, email, phone, mobile, password } = req.body;
  const rawMobile = phone || mobile || "";

  if (!name || !email || !rawMobile.trim()) {
    return res.status(400).json({
      success: false,
      message: "Please provide full name, email address, and mobile number.",
    });
  }

  const cleanEmail = email.toLowerCase().trim();
  const cleanMobile = rawMobile.trim();
  const cleanName = name.trim();

  // Validate and normalize mobile number
  const phoneValidation = validateAndNormalizePhone(rawMobile);
  if (!phoneValidation.isValid) {
    return res.status(400).json({
      success: false,
      field: "phone",
      message: phoneValidation.error,
    });
  }

  const normalizedPhone = phoneValidation.normalized;
  const cleanDigits = phoneValidation.cleanDigits;

  const { UserModel, NotificationModel } = getModels(req);

  try {
    // 1. Subscription validity check
    if (req.organization?.subscriptionEndDate) {
      const isExpired =
        new Date() > new Date(req.organization.subscriptionEndDate);
      if (isExpired) {
        return res.status(403).json({
          success: false,
          subscriptionExpired: true,
          message: `Your organization's subscription expired on ${new Date(
            req.organization.subscriptionEndDate
          ).toLocaleDateString("en-IN")}. Please renew to create new users.`,
        });
      }
    }

    // 2. Strict Seat Limit Check
    if (req.organization?.seats) {
      const currentRepsCount = await UserModel.countDocuments({
        role: "sales person",
      });
      const maxSeats = req.organization.seats;

      if (currentRepsCount >= maxSeats) {
        return res.status(403).json({
          success: false,
          seatLimitReached: true,
          message: `Seat limit reached (${currentRepsCount}/${maxSeats} seats allocated). Please contact your administrator to upgrade your plan.`,
          totalSeats: maxSeats,
          usedSeats: currentRepsCount,
        });
      }
    }

    // 3. Check if email already exists in this tenant
    const userExistsInTenant = await UserModel.findOne({ email: cleanEmail });
    if (userExistsInTenant) {
      return res.status(400).json({
        success: false,
        field: "email",
        message: "A representative with this email already exists in your team!",
      });
    }

    // 4. Check if mobile number already exists in this tenant
    const phoneDuplicateQuery = buildPhoneDuplicateQuery(normalizedPhone, cleanDigits);
    const phoneExistsInTenant = await UserModel.findOne(phoneDuplicateQuery);
    if (phoneExistsInTenant) {
      return res.status(400).json({
        success: false,
        field: "phone",
        message: `A representative with this mobile number (${normalizedPhone}) already exists in your team!`,
      });
    }

    // 5. Check if user or phone exists in master registry (AuthUser)
    const { AuthUser } = getMasterModels();
    const existingAuthUser = await AuthUser.findOne({ email: cleanEmail });
    if (existingAuthUser) {
      return res.status(400).json({
        success: false,
        field: "email",
        message:
          "This email address is already registered in the system. Please use a different email.",
      });
    }

    const existingAuthPhone = await AuthUser.findOne(phoneDuplicateQuery);
    if (existingAuthPhone) {
      return res.status(400).json({
        success: false,
        field: "phone",
        message: `This mobile number (${normalizedPhone}) is already registered with an account in the system. Each sales representative must have a unique mobile number.`,
      });
    }

    // 6. Generate secure random temporary password (or use provided fallback)
    const temporaryPassword = password && password.trim().length >= 6
      ? password.trim()
      : generateSecurePassword(cleanName);

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(temporaryPassword, salt);

    // 7. Create in Tenant Database
    const user = await UserModel.create({
      name: cleanName,
      email: cleanEmail,
      phone: normalizedPhone,
      password: hashedPassword,
      role: "sales person",
      organizationId: req.organization?._id || req.user?.organizationId,
      isOrgOwner: false,
      status: "active",
    });

    // 8. Register in Master AuthUser database
    await AuthUser.create({
      _id: user._id, // Keep IDs identical
      name: cleanName,
      email: cleanEmail,
      phone: normalizedPhone,
      password: hashedPassword,
      role: "sales person",
      organizationId: req.organization?._id || req.user?.organizationId,
      tenantDbName: req.tenantDbName || null,
      isOrgOwner: false,
      status: "active",
    });

    // 8. Create notification in tenant
    try {
      await NotificationModel.create({
        title: "New Team Member Added",
        message: `${user.name} was added as a Sales Representative.`,
        type: "system",
        targetRoles: ["sales manager"],
      });
    } catch (notifErr) {
      console.error("Error creating notification:", notifErr);
    }

    // 9. Send welcome credentials email directly to representative
    const orgName = req.organization?.name || "SalesBuster";
    const loginUrl = process.env.FRONTEND_URL || "https://holyminicow.com/kranthi-crm";
    let emailSent = false;
    try {
      emailSent = await sendSalesPersonWelcomeEmail({
        salesPersonName: cleanName,
        salesPersonEmail: cleanEmail,
        salesPersonMobile: normalizedPhone,
        temporaryPassword,
        organizationName: orgName,
        loginUrl,
      });
    } catch (emailErr) {
      console.error("Error sending welcome email to sales representative:", emailErr);
    }

    // 10. Calculate updated seat usage
    const totalRepsAfter = await UserModel.countDocuments({
      role: "sales person",
    });
    const totalCapacity = req.organization?.seats || totalRepsAfter;

    res.status(201).json({
      success: true,
      message: emailSent
        ? "Sales representative created successfully and login credentials sent via email."
        : "Sales representative created successfully.",
      emailSent,
      data: {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
      seats: {
        totalSeats: totalCapacity,
        usedSeats: totalRepsAfter,
        remainingSeats: Math.max(0, totalCapacity - totalRepsAfter),
      },
    });
  } catch (error) {
    console.error("Error creating user:", error);

    // Handle Mongo duplicate key constraint violations (E11000)
    if (error.code === 11000) {
      if (error.keyPattern?.phone || error.message?.includes("phone")) {
        return res.status(400).json({
          success: false,
          field: "phone",
          message: "This mobile number is already registered in the system. Each sales representative must have a unique mobile number.",
        });
      }
      if (error.keyPattern?.email || error.message?.includes("email")) {
        return res.status(400).json({
          success: false,
          field: "email",
          message: "This email address is already registered in the system.",
        });
      }
    }

    res.status(500).json({
      success: false,
      message: error.message || "Server error while creating sales representative",
    });
  }
};

// @desc    Delete a Sales Representative (Frees up a seat)
// @route   DELETE /api/users/:id
// @access  Protected
export const deleteSalesPerson = async (req, res) => {
  const isAuthorized =
    req.user?.role === "sales manager" ||
    req.user?.role === "super_admin" ||
    req.user?.isOrgOwner;

  if (!isAuthorized) {
    return res.status(403).json({
      success: false,
      message:
        "Access forbidden: Only sales managers or organization owners can delete sales representatives.",
    });
  }

  const { UserModel } = getModels(req);

  try {
    const user = await UserModel.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Representative not found",
      });
    }

    // Protect Organization Owner from being deleted
    if (user.isOrgOwner || user.role === "sales manager") {
      return res.status(403).json({
        success: false,
        message: "Cannot delete the Organization Owner account.",
      });
    }

    // Ensure the organization maintains at least 1 sales representative
    const currentSalesCount = await UserModel.countDocuments({
      role: "sales person",
    });
    if (user.role === "sales person" && currentSalesCount <= 1) {
      return res.status(400).json({
        success: false,
        message:
          "An organization must have at least 1 sales representative. You cannot delete the only representative.",
      });
    }

    // Delete from tenant DB
    await UserModel.findByIdAndDelete(req.params.id);

    // Unassign leads previously assigned to this user
    try {
      const { LeadModel } = getModels(req);
      await LeadModel.updateMany(
        { $or: [{ assignedTo: req.params.id }, { assignedTo: user.name }] },
        { $set: { assignedTo: "Unassigned" } }
      );
    } catch (leadErr) {
      console.error("Error unassigning leads on user delete:", leadErr);
    }

    // Delete from Master AuthUser registry
    try {
      const { AuthUser } = getMasterModels();
      await AuthUser.deleteOne({
        $or: [{ _id: req.params.id }, { email: user.email }],
      });
    } catch (authErr) {
      console.error("Error removing from AuthUser registry:", authErr);
    }

    // Calculate remaining seats
    const currentUsed = await UserModel.countDocuments({
      role: "sales person",
    });
    const totalCapacity = req.organization?.seats || currentUsed + 1;

    res.status(200).json({
      success: true,
      message: "Representative removed successfully. Seat freed up.",
      seats: {
        totalSeats: totalCapacity,
        usedSeats: currentUsed,
        remainingSeats: Math.max(0, totalCapacity - currentUsed),
      },
    });
  } catch (error) {
    console.error("Error deleting user:", error);
    res.status(500).json({
      success: false,
      message: "Server error while deleting representative",
    });
  }
};
