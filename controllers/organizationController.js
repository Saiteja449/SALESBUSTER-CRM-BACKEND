import bcrypt from "bcryptjs";
import {
  getMasterModels,
  getTenantModels,
  generateTenantDbName,
  generateSecurePassword,
} from "../services/tenantManager.js";
import { sendTenantWelcomeEmail } from "../helpers/emailHelper.js";

/**
 * Calculates exactly 1 calendar month later, ending at 23:59:59.999
 * Handles month rollovers correctly (e.g. Sep 8 -> Oct 8, Jan 31 -> Feb 28/29)
 */
const calculateOneMonthLater = (startDate, months = 1) => {
  const start = new Date(startDate);
  const end = new Date(start);
  const targetMonth = end.getMonth() + months;
  end.setMonth(targetMonth);

  // Handle month rollover (e.g., August 31 + 1 month = Oct 1 -> roll back to Sep 30)
  if (end.getMonth() !== ((targetMonth % 12) + 12) % 12) {
    end.setDate(0);
  }

  end.setHours(23, 59, 59, 999);
  return end;
};

// @desc    Provision a new client organization tenant
// @route   POST /api/organizations/provision
// @access  Protected (Super Admin)
export const provisionOrganization = async (req, res) => {
  try {
    const {
      name,
      email,
      mobile,
      website,
      seats,
      amountPaid,
      pricingPerSeat,
      paymentMethod,
      subscriptionStartDate,
      notes,
    } = req.body;

    // 1. Validate required fields
    if (!name || !email || !mobile || seats == null || amountPaid == null) {
      return res.status(400).json({
        success: false,
        message:
          "Missing required fields: name, email, mobile, seats, and amountPaid are required.",
      });
    }

    const cleanEmail = email.toLowerCase().trim();
    const seatCount = parseInt(seats, 10);
    const paidAmount = Number(amountPaid);

    if (isNaN(seatCount) || seatCount < 1) {
      return res.status(400).json({
        success: false,
        message: "Seats must be a positive integer of at least 1.",
      });
    }

    if (isNaN(paidAmount) || paidAmount < 0) {
      return res.status(400).json({
        success: false,
        message: "Amount paid cannot be negative.",
      });
    }

    const { Organization, AuthUser } = getMasterModels();

    // 2. Check if email is already in use
    const existingAuthUser = await AuthUser.findOne({ email: cleanEmail });
    if (existingAuthUser) {
      return res.status(400).json({
        success: false,
        message: `An account with email '${cleanEmail}' already exists.`,
      });
    }

    const existingOrg = await Organization.findOne({ email: cleanEmail });
    if (existingOrg) {
      return res.status(400).json({
        success: false,
        message: `An organization with billing email '${cleanEmail}' is already registered.`,
      });
    }

    // 3. Compute Monthly Subscription Dates
    const startDate = subscriptionStartDate
      ? new Date(subscriptionStartDate)
      : new Date();
    const endDate = calculateOneMonthLater(startDate, 1);

    // 4. Generate unique tenant database name
    let tenantDbName = generateTenantDbName(name);
    let attempts = 0;
    while (await Organization.findOne({ tenantDbName })) {
      tenantDbName = generateTenantDbName(name);
      attempts++;
      if (attempts > 5) break;
    }

    // 5. Auto-generate secure password for the Organization Owner
    const temporaryPassword = generateSecurePassword(name);
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(temporaryPassword, salt);

    // 6. Create Organization in Master DB
    const organization = await Organization.create({
      name: name.trim(),
      email: cleanEmail,
      mobile: mobile.trim(),
      website: (website || "").trim(),
      seats: seatCount,
      amountPaid: paidAmount,
      pricingPerSeat: pricingPerSeat != null ? Number(pricingPerSeat) : Math.round(paidAmount / seatCount),
      paymentMethod: paymentMethod || "Manual",
      subscriptionPlan: "monthly",
      subscriptionStartDate: startDate,
      subscriptionEndDate: endDate,
      status: "active",
      tenantDbName,
      notes: notes || "",
    });

    // 7. Register Owner in Master AuthUser registry
    const masterAuthUser = await AuthUser.create({
      email: cleanEmail,
      password: hashedPassword,
      name: `${name.trim()} Admin`,
      role: "sales manager",
      organizationId: organization._id,
      tenantDbName,
      isOrgOwner: true,
      status: "active",
    });

    // 8. Initialize tenant database and create Owner inside tenant DB
    const tenantModels = getTenantModels(tenantDbName);
    const tenantOwner = await tenantModels.User.create({
      _id: masterAuthUser._id, // Match AuthUser ID for consistent references
      name: `${name.trim()} Admin`,
      email: cleanEmail,
      password: hashedPassword,
      role: "sales manager",
      organizationId: organization._id,
      isOrgOwner: true,
      phone: mobile.trim(),
      status: "active",
    });

    // Link owner to Organization
    organization.ownerId = masterAuthUser._id;
    await organization.save();

    // 9. Dispatch Welcome Email to Organization Owner
    let emailSent = false;
    try {
      emailSent = await sendTenantWelcomeEmail({
        organization,
        ownerEmail: cleanEmail,
        temporaryPassword,
        loginUrl: process.env.FRONTEND_URL || "https://crm.salesbuster.com/login",
      });
    } catch (emailErr) {
      console.error("Failed to send welcome email:", emailErr);
    }

    // 10. Return success response with provisioned data and credentials
    res.status(201).json({
      success: true,
      message:
        "Tenant organization provisioned successfully. Welcome email with credentials dispatched.",
      data: {
        organization: {
          id: organization._id,
          name: organization.name,
          email: organization.email,
          mobile: organization.mobile,
          website: organization.website,
          seats: organization.seats,
          amountPaid: organization.amountPaid,
          pricingPerSeat: organization.pricingPerSeat,
          subscriptionPlan: organization.subscriptionPlan,
          subscriptionStartDate: organization.subscriptionStartDate,
          subscriptionEndDate: organization.subscriptionEndDate,
          status: organization.status,
          tenantDbName: organization.tenantDbName,
        },
        emailSent,
        credentials: {
          email: cleanEmail,
          temporaryPassword,
          loginUrl: process.env.FRONTEND_URL || "https://crm.salesbuster.com/login",
        },
      },
    });
  } catch (error) {
    console.error("Error provisioning organization:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Server error while provisioning organization",
    });
  }
};

// @desc    Get all organizations with current seat metrics
// @route   GET /api/organizations
// @access  Protected (Super Admin)
export const getOrganizations = async (req, res) => {
  try {
    const { Organization } = getMasterModels();
    const organizations = await Organization.find().sort({ createdAt: -1 });

    // Populate live seat usage for each organization
    const orgsWithMetrics = await Promise.all(
      organizations.map(async (org) => {
        let usedSeats = 0;
        try {
          const tenantModels = getTenantModels(org.tenantDbName);
          usedSeats = await tenantModels.User.countDocuments({
            role: "sales person",
          });
        } catch (e) {
          console.error(`Error fetching user count for ${org.tenantDbName}:`, e);
        }

        const isExpired =
          org.subscriptionEndDate &&
          new Date() > new Date(org.subscriptionEndDate);

        return {
          ...org.toJSON(),
          usedSeats,
          remainingSeats: Math.max(0, org.seats - usedSeats),
          isExpired: !!isExpired,
        };
      })
    );

    res.status(200).json({
      success: true,
      count: orgsWithMetrics.length,
      data: orgsWithMetrics,
    });
  } catch (error) {
    console.error("Error fetching organizations:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching organizations",
    });
  }
};

// @desc    Get single organization by ID
// @route   GET /api/organizations/:id
// @access  Protected (Super Admin)
export const getOrganizationById = async (req, res) => {
  try {
    const { Organization } = getMasterModels();
    const org = await Organization.findById(req.params.id);

    if (!org) {
      return res.status(404).json({
        success: false,
        message: "Organization not found",
      });
    }

    let usedSeats = 0;
    try {
      const tenantModels = getTenantModels(org.tenantDbName);
      usedSeats = await tenantModels.User.countDocuments({
        role: "sales person",
      });
    } catch (e) {
      console.error(`Error counting users for ${org.tenantDbName}:`, e);
    }

    const isExpired =
      org.subscriptionEndDate &&
      new Date() > new Date(org.subscriptionEndDate);

    res.status(200).json({
      success: true,
      data: {
        ...org.toJSON(),
        usedSeats,
        remainingSeats: Math.max(0, org.seats - usedSeats),
        isExpired: !!isExpired,
      },
    });
  } catch (error) {
    console.error("Error fetching organization:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching organization",
    });
  }
};

// @desc    Update organization licensed seats
// @route   PUT /api/organizations/:id/seats
// @access  Protected (Super Admin)
export const updateOrganizationSeats = async (req, res) => {
  try {
    const { seats } = req.body;
    const newSeats = parseInt(seats, 10);

    if (isNaN(newSeats) || newSeats < 1) {
      return res.status(400).json({
        success: false,
        message: "Seats must be a positive number of at least 1.",
      });
    }

    const { Organization } = getMasterModels();
    const org = await Organization.findById(req.params.id);

    if (!org) {
      return res.status(404).json({
        success: false,
        message: "Organization not found",
      });
    }

    // Check current used seats
    const tenantModels = getTenantModels(org.tenantDbName);
    const currentUsed = await tenantModels.User.countDocuments({
      role: "sales person",
    });

    org.seats = newSeats;
    await org.save();

    res.status(200).json({
      success: true,
      message: `Licensed seats updated to ${newSeats}`,
      data: {
        ...org.toJSON(),
        usedSeats: currentUsed,
        remainingSeats: Math.max(0, newSeats - currentUsed),
        seatWarning:
          currentUsed > newSeats
            ? `Warning: Current sales persons (${currentUsed}) exceeds new seat capacity (${newSeats}).`
            : null,
      },
    });
  } catch (error) {
    console.error("Error updating organization seats:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating seats",
    });
  }
};

// @desc    Renew organization subscription (+1 or more months)
// @route   PUT /api/organizations/:id/renew
// @access  Protected (Super Admin)
export const renewSubscription = async (req, res) => {
  try {
    const { amountPaid, months = 1, paymentMethod } = req.body;
    const renewalMonths = Math.max(1, parseInt(months, 10) || 1);

    const { Organization } = getMasterModels();
    const org = await Organization.findById(req.params.id);

    if (!org) {
      return res.status(404).json({
        success: false,
        message: "Organization not found",
      });
    }

    // If existing subscription is already expired, start from today
    // Otherwise extend from current subscriptionEndDate
    const now = new Date();
    const baseDate =
      org.subscriptionEndDate && new Date(org.subscriptionEndDate) > now
        ? new Date(org.subscriptionEndDate)
        : now;

    const newEndDate = calculateOneMonthLater(baseDate, renewalMonths);

    org.subscriptionEndDate = newEndDate;
    org.status = "active";
    if (amountPaid != null) {
      org.amountPaid = (org.amountPaid || 0) + Number(amountPaid);
    }
    if (paymentMethod) {
      org.paymentMethod = paymentMethod;
    }

    await org.save();

    res.status(200).json({
      success: true,
      message: `Subscription successfully renewed until ${newEndDate.toLocaleDateString("en-IN")}`,
      data: org,
    });
  } catch (error) {
    console.error("Error renewing subscription:", error);
    res.status(500).json({
      success: false,
      message: "Server error while renewing subscription",
    });
  }
};

// @desc    Toggle organization status (active / inactive / suspended)
// @route   PATCH /api/organizations/:id/status
// @access  Protected (Super Admin)
export const toggleStatus = async (req, res) => {
  try {
    const { status } = req.body;

    if (!["active", "inactive", "suspended"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Status must be 'active', 'inactive', or 'suspended'",
      });
    }

    const { Organization, AuthUser } = getMasterModels();
    const org = await Organization.findById(req.params.id);

    if (!org) {
      return res.status(404).json({
        success: false,
        message: "Organization not found",
      });
    }

    org.status = status;
    await org.save();

    // Sync status to all AuthUsers belonging to this org
    await AuthUser.updateMany(
      { organizationId: org._id },
      { status: status === "active" ? "active" : "inactive" }
    );

    res.status(200).json({
      success: true,
      message: `Organization status set to '${status}'`,
      data: org,
    });
  } catch (error) {
    console.error("Error toggling organization status:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating organization status",
    });
  }
};

// @desc    Resend Welcome Email / regenerate credentials
// @route   POST /api/organizations/:id/resend-welcome
// @access  Protected (Super Admin)
export const resendWelcomeEmail = async (req, res) => {
  try {
    const { Organization, AuthUser } = getMasterModels();
    const org = await Organization.findById(req.params.id);

    if (!org) {
      return res.status(404).json({
        success: false,
        message: "Organization not found",
      });
    }

    const temporaryPassword = generateSecurePassword(org.name);
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(temporaryPassword, salt);

    // Update in Master AuthUser
    await AuthUser.updateOne(
      { _id: org.ownerId },
      { password: hashedPassword }
    );

    // Update in Tenant DB
    const tenantModels = getTenantModels(org.tenantDbName);
    await tenantModels.User.updateOne(
      { _id: org.ownerId },
      { password: hashedPassword }
    );

    const emailSent = await sendTenantWelcomeEmail({
      organization: org,
      ownerEmail: org.email,
      temporaryPassword,
      loginUrl: process.env.FRONTEND_URL || "https://crm.salesbuster.com/login",
    });

    res.status(200).json({
      success: true,
      message: "Welcome email resent with new temporary credentials.",
      emailSent,
      credentials: {
        email: org.email,
        temporaryPassword,
        loginUrl: process.env.FRONTEND_URL || "https://crm.salesbuster.com/login",
      },
    });
  } catch (error) {
    console.error("Error resending welcome email:", error);
    res.status(500).json({
      success: false,
      message: "Server error while resending welcome email",
    });
  }
};

// @desc    Get current organization profile (For Organization Owner)
// @route   GET /api/organizations/my-org
// @access  Protected (Org Owner / Manager)
export const getMyOrganization = async (req, res) => {
  try {
    const orgId = req.user?.organizationId || req.organization?._id;

    if (!orgId) {
      return res.status(404).json({
        success: false,
        message: "No organization profile associated with this account.",
      });
    }

    const { Organization } = getMasterModels();
    const org = await Organization.findById(orgId);

    if (!org) {
      return res.status(404).json({
        success: false,
        message: "Organization not found.",
      });
    }

    let usedSeats = 0;
    let totalLeads = 0;
    let totalFollowups = 0;

    try {
      const tenantModels = getTenantModels(org.tenantDbName);
      usedSeats = await tenantModels.User.countDocuments({
        role: "sales person",
      });
      totalLeads = await tenantModels.Lead.countDocuments();
      totalFollowups = await tenantModels.Followup.countDocuments();
    } catch (metricErr) {
      console.error("Error fetching live tenant metrics for org profile:", metricErr);
    }

    const now = new Date();
    const isExpired =
      org.subscriptionEndDate && new Date(org.subscriptionEndDate) < now;
    const remainingDays = org.subscriptionEndDate
      ? Math.ceil(
          (new Date(org.subscriptionEndDate) - now) / (1000 * 60 * 60 * 24)
        )
      : null;

    res.status(200).json({
      success: true,
      data: {
        ...org.toJSON(),
        usedSeats,
        remainingSeats: Math.max(0, org.seats - usedSeats),
        totalLeads,
        totalFollowups,
        isExpired: !!isExpired,
        remainingDays,
      },
    });
  } catch (error) {
    console.error("Error in getMyOrganization:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Server error while fetching organization profile",
    });
  }
};
