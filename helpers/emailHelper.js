import nodemailer from "nodemailer";

let transporter = null;

/**
 * Returns a cached, pooled nodemailer transporter configured for Hostinger SMTP
 */
export const getTransporter = () => {
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT) || 465;
    const isSecure =
      process.env.SMTP_SECURE !== undefined
        ? process.env.SMTP_SECURE === "true"
        : port === 465;

    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.hostinger.com",
      port,
      secure: isSecure,
      family: 4, // Enforce IPv4 to avoid cloud container IPv6 network timeouts
      auth: {
        user: process.env.SMTP_USER || "info@salesbuster.ai",
        pass: process.env.SMTP_PASS,
      },
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
    });
  }
  return transporter;
};

/**
 * Verifies the SMTP connection and authentication credentials
 */
export const verifySmtpConnection = async () => {
  try {
    const transport = getTransporter();
    await transport.verify();
    return { success: true, message: "SMTP connection verified successfully" };
  } catch (error) {
    console.error("SMTP verification failed:", error);
    return { success: false, message: error.message, code: error.code };
  }
};

export const sendEmail = async (options) => {
  try {
    const transport = getTransporter();

    const mailOptions = {
      from:
        process.env.SMTP_FROM ||
        `"SalesBuster CRM" <${process.env.SMTP_USER || "info@salesbuster.ai"}>`,
      to: options.email,
      subject: options.subject,
      text: options.message,
      html: options.htmlMessage,
    };

    const info = await transport.sendMail(mailOptions);
    console.log(`[Email] Successfully sent to ${options.email} (MessageId: ${info?.messageId || "N/A"})`);
    return true;
  } catch (error) {
    console.error(`[Email] Failed to send email to ${options.email}:`, error.message);
    return false;
  }
};

/**
 * Sends a welcome email with credentials, subscription details, and login URL
 */
export const sendTenantWelcomeEmail = async ({
  organization,
  ownerEmail,
  temporaryPassword,
  loginUrl,
}) => {
  const formatDate = (date) => {
    if (!date) return "N/A";
    return new Date(date).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  };

  const formattedStartDate = formatDate(organization.subscriptionStartDate);
  const formattedEndDate = formatDate(organization.subscriptionEndDate);
  const formattedAmount =
    organization.amountPaid != null
      ? `₹${Number(organization.amountPaid).toLocaleString("en-IN")}`
      : "Paid";
  const rawPlan = organization.subscriptionPlan || "monthly";
  const formattedPlan = rawPlan.charAt(0).toUpperCase() + rawPlan.slice(1);

  const appLoginUrl =
    loginUrl || process.env.FRONTEND_URL || "http://localhost:5173/login";

  const htmlMessage = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to SalesBuster CRM</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b;">
  <div style="max-width: 620px; margin: 30px auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.06); border: 1px solid #e2e8f0;">
    
    <!-- Top Gradient Header -->
    <div style="background: linear-gradient(135deg, #0ea5e9 0%, #3b82f6 50%, #6366f1 100%); padding: 36px 30px; text-align: center;">
      <h1 style="margin: 0 0 8px 0; color: #ffffff; font-size: 26px; font-weight: 800; letter-spacing: -0.5px;">SalesBuster CRM</h1>
      <p style="margin: 0; color: #e0f2fe; font-size: 15px; font-weight: 500;">Your AI-Powered Sales Acceleration Workspace</p>
    </div>

    <!-- Main Content -->
    <div style="padding: 32px 30px;">
      <h2 style="margin: 0 0 12px 0; color: #0f172a; font-size: 20px; font-weight: 700;">Welcome to SalesBuster, ${organization.name}! 🎉</h2>
      <p style="margin: 0 0 24px 0; color: #475569; font-size: 14px; line-height: 1.6;">
        Your organization workspace has been successfully provisioned. You can now manage leads, track team activities, and accelerate your sales pipeline.
      </p>

      <!-- Plan Details Box -->
      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
        <h3 style="margin: 0 0 14px 0; color: #0ea5e9; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">Workspace & Subscription Details</h3>
        
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr>
            <td style="padding: 6px 0; color: #64748b; font-weight: 500;">Organization Name:</td>
            <td style="padding: 6px 0; color: #0f172a; font-weight: 700; text-align: right;">${organization.name}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #64748b; font-weight: 500;">Licensed Sales Rep Seats:</td>
            <td style="padding: 6px 0; color: #0f172a; font-weight: 700; text-align: right;">${organization.seats} Representatives</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #64748b; font-weight: 500;">Subscription Period:</td>
            <td style="padding: 6px 0; color: #0f172a; font-weight: 700; text-align: right;">${formattedStartDate} – ${formattedEndDate} (${formattedPlan})</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #64748b; font-weight: 500;">Amount Paid:</td>
            <td style="padding: 6px 0; color: #16a34a; font-weight: 700; text-align: right;">${formattedAmount} (Paid)</td>
          </tr>
        </table>
      </div>

      <!-- Credentials Box -->
      <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 20px; margin-bottom: 28px;">
        <h3 style="margin: 0 0 12px 0; color: #15803d; font-size: 14px; font-weight: 700;">🔐 Your Administrator Login Credentials</h3>
        <p style="margin: 0 0 12px 0; color: #166534; font-size: 13px;">Use the credentials below to log in as Organization Owner:</p>
        
        <div style="background: #ffffff; border: 1px dashed #86efac; border-radius: 8px; padding: 14px 18px; margin-bottom: 12px;">
          <div style="margin-bottom: 8px;">
            <span style="font-size: 12px; color: #64748b; font-weight: 600; text-transform: uppercase;">Login Email:</span>
            <div style="font-size: 15px; font-weight: 700; color: #0f172a; font-family: monospace;">${ownerEmail}</div>
          </div>
          <div>
            <span style="font-size: 12px; color: #64748b; font-weight: 600; text-transform: uppercase;">Password:</span>
            <div style="font-size: 16px; font-weight: 800; color: #0284c7; font-family: monospace; letter-spacing: 0.5px;">${temporaryPassword}</div>
          </div>
        </div>

       
      </div>

      <!-- Action Button -->
      <div style="text-align: center; margin-bottom: 28px;">
        <a href="${appLoginUrl}" style="display: inline-block; background: linear-gradient(135deg, #0284c7 0%, #2563eb 100%); color: #ffffff; font-size: 15px; font-weight: 700; text-decoration: none; padding: 14px 32px; border-radius: 10px; box-shadow: 0 4px 12px rgba(37, 99, 235, 0.25);">
          Log In to SalesBuster Workspace →
        </a>
      </div>

      <p style="margin: 0 0 12px 0; color: #64748b; font-size: 13px; line-height: 1.5;">
        Need to add more user seats or have questions about your subscription? Contact our support team anytime at <a href="mailto:info@salesbuster.ai" style="color: #0284c7; font-weight: 600;">info@salesbuster.ai</a>.
      </p>
    </div>

    <!-- Footer -->
    <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 20px 30px; text-align: center;">
      <p style="margin: 0 0 4px 0; color: #94a3b8; font-size: 12px;">© ${new Date().getFullYear()} SalesBuster AI CRM. All rights reserved.</p>
      <p style="margin: 0; color: #cbd5e1; font-size: 11px;">Sent from info@salesbuster.ai | Automated Onboarding Notification</p>
    </div>

  </div>
</body>
</html>
  `;

  return await sendEmail({
    email: ownerEmail,
    subject: `Welcome to SalesBuster! Your ${organization.name} Workspace is Ready`,
    message: `Welcome to SalesBuster!\n\nYour organization ${organization.name} has been provisioned.\nSeats: ${organization.seats}\nValidity: ${formattedStartDate} to ${formattedEndDate}\nAmount Paid: ${formattedAmount}\n\nLogin URL: ${appLoginUrl}\nEmail: ${ownerEmail}\n Password: ${temporaryPassword}\n\nPlease change your password upon first login.`,
    htmlMessage,
  });
};

/**
 * Sends a welcome email with credentials to a newly added Sales Representative
 */
export const sendSalesPersonWelcomeEmail = async ({
  salesPersonName,
  salesPersonEmail,
  salesPersonMobile,
  temporaryPassword,
  organizationName,
  loginUrl,
}) => {
  const appLoginUrl =
    loginUrl ||
    process.env.FRONTEND_URL ||
    "https://holyminicow.com/kranthi-crm";
  const orgDisplayName = organizationName || "Your Organization";

  const htmlMessage = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to SalesBuster CRM</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b;">
  <div style="max-width: 600px; margin: 30px auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.06); border: 1px solid #e2e8f0;">
    
    <!-- Top Gradient Header -->
    <div style="background: linear-gradient(135deg, #0ea5e9 0%, #3b82f6 50%, #6366f1 100%); padding: 32px 28px; text-align: center;">
      <h1 style="margin: 0 0 6px 0; color: #ffffff; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">SalesBuster CRM</h1>
      <p style="margin: 0; color: #e0f2fe; font-size: 14px; font-weight: 500;">Sales Acceleration & Lead Management Workspace</p>
    </div>

    <!-- Main Content -->
    <div style="padding: 30px 28px;">
      <h2 style="margin: 0 0 12px 0; color: #0f172a; font-size: 20px; font-weight: 700;">Welcome to the Team, ${salesPersonName}! 👋</h2>
      <p style="margin: 0 0 20px 0; color: #475569; font-size: 14px; line-height: 1.6;">
        You have been added as a <strong>Sales Representative</strong> for <strong>${orgDisplayName}</strong> on SalesBuster CRM.
        Below are your system-generated login credentials to access your sales workspace:
      </p>

      <!-- Credentials Box -->
      <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
        <h3 style="margin: 0 0 14px 0; color: #15803d; font-size: 14px; font-weight: 700;">🔐 Your Login Credentials</h3>
        
        <div style="background: #ffffff; border: 1px dashed #86efac; border-radius: 8px; padding: 14px 18px; margin-bottom: 12px;">
          <div style="margin-bottom: 10px;">
            <span style="font-size: 11px; color: #64748b; font-weight: 600; text-transform: uppercase;">Login Email:</span>
            <div style="font-size: 15px; font-weight: 700; color: #0f172a; font-family: monospace;">${salesPersonEmail}</div>
          </div>
          ${
            salesPersonMobile
              ? `
          <div style="margin-bottom: 10px;">
            <span style="font-size: 11px; color: #64748b; font-weight: 600; text-transform: uppercase;">Registered Mobile:</span>
            <div style="font-size: 14px; font-weight: 600; color: #334155;">${salesPersonMobile}</div>
          </div>
          `
              : ""
          }
          <div>
            <span style="font-size: 11px; color: #64748b; font-weight: 600; text-transform: uppercase;">Password:</span>
            <div style="font-size: 16px; font-weight: 800; color: #0284c7; font-family: monospace; letter-spacing: 0.5px;">${temporaryPassword}</div>
          </div>
        </div>
      </div>

      <!-- Action Button -->
      <div style="text-align: center; margin-bottom: 24px;">
        <a href="${appLoginUrl}" style="display: inline-block; background: linear-gradient(135deg, #0284c7 0%, #2563eb 100%); color: #ffffff; font-size: 15px; font-weight: 700; text-decoration: none; padding: 13px 30px; border-radius: 10px; box-shadow: 0 4px 12px rgba(37, 99, 235, 0.25);">
          Log In to Workspace →
        </a>
      </div>

      <p style="margin: 0; color: #64748b; font-size: 13px; line-height: 1.5;">
        If you have any questions or did not expect this invitation, please contact your team manager or email us at <a href="mailto:info@salesbuster.ai" style="color: #0284c7; font-weight: 600;">info@salesbuster.ai</a>.
      </p>
    </div>

    <!-- Footer -->
    <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 18px 28px; text-align: center;">
      <p style="margin: 0 0 4px 0; color: #94a3b8; font-size: 12px;">© ${new Date().getFullYear()} SalesBuster AI CRM. All rights reserved.</p>
      <p style="margin: 0; color: #cbd5e1; font-size: 11px;">Sent from info@salesbuster.ai | Automated Team Invitation</p>
    </div>

  </div>
</body>
</html>
  `;

  return await sendEmail({
    email: salesPersonEmail,
    subject: `Welcome to ${orgDisplayName}! Your SalesBuster Login Credentials`,
    message: `Hello ${salesPersonName},\n\nYou have been added as a Sales Representative for ${orgDisplayName} on SalesBuster CRM.\n\nYour Login Credentials:\nLogin URL: ${appLoginUrl}\nEmail: ${salesPersonEmail}\n Password: ${temporaryPassword}${salesPersonMobile ? `\nMobile: ${salesPersonMobile}` : ""}\n\nPlease change your password after logging in.\n\nSalesBuster CRM`,
    htmlMessage,
  });
};

/**
 * Sends a security login alert email when a user successfully logs in
 */
export const sendLoginAlertEmail = async ({
  email,
  name,
  ipAddress,
  userAgent,
  loginTime,
}) => {
  const formattedTime = loginTime
    ? new Date(loginTime).toLocaleString("en-IN", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Kolkata",
      }) + " IST"
    : new Date().toLocaleString("en-IN", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Kolkata",
      }) + " IST";

  const clientIp = ipAddress || "Unknown IP";
  const clientDevice = userAgent || "Unknown Device / Browser";
  const recipientName = name || email.split("@")[0];

  const htmlMessage = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SalesBuster Security Alert: New Login</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b;">
  <div style="max-width: 600px; margin: 30px auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.06); border: 1px solid #e2e8f0;">
    
    <!-- Top Header -->
    <div style="background: linear-gradient(135deg, #0ea5e9 0%, #3b82f6 50%, #6366f1 100%); padding: 30px 28px; text-align: center;">
      <h1 style="margin: 0 0 6px 0; color: #ffffff; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">SalesBuster CRM</h1>
      <p style="margin: 0; color: #e0f2fe; font-size: 14px; font-weight: 500;">Security Notification & Account Activity</p>
    </div>

    <!-- Main Content -->
    <div style="padding: 30px 28px;">
      <h2 style="margin: 0 0 12px 0; color: #0f172a; font-size: 20px; font-weight: 700;">🛡️ New Sign-In to Your Account</h2>
      
      <p style="margin: 0 0 20px 0; color: #475569; font-size: 14px; line-height: 1.6;">
        Hello <strong>${recipientName}</strong>, we noticed a successful sign-in to your SalesBuster CRM workspace.
      </p>

      <!-- Details Box -->
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px 20px; margin-bottom: 24px;">
        <h3 style="margin: 0 0 12px 0; color: #0284c7; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">Sign-In Details</h3>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr>
            <td style="padding: 6px 0; color: #64748b; font-weight: 500;">Account:</td>
            <td style="padding: 6px 0; color: #0f172a; font-weight: 700; text-align: right;">${email}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #64748b; font-weight: 500;">Time:</td>
            <td style="padding: 6px 0; color: #0f172a; font-weight: 600; text-align: right;">${formattedTime}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #64748b; font-weight: 500;">IP Address:</td>
            <td style="padding: 6px 0; color: #0f172a; font-weight: 600; text-align: right; font-family: monospace;">${clientIp}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #64748b; font-weight: 500; vertical-align: top;">Device / Client:</td>
            <td style="padding: 6px 0; color: #334155; font-size: 12px; text-align: right; max-width: 300px; word-break: break-word;">${clientDevice}</td>
          </tr>
        </table>
      </div>

      <div style="background: #fffbeb; border: 1px solid #fef3c7; border-radius: 10px; padding: 14px 18px; margin-bottom: 20px;">
        <p style="margin: 0; color: #92400e; font-size: 13px; line-height: 1.5;">
          <strong>Didn't sign in?</strong> If you did not initiate this login, someone else may have accessed your account. Please reset your password immediately or contact our security team at <a href="mailto:info@salesbuster.ai" style="color: #b45309; font-weight: 600;">info@salesbuster.ai</a>.
        </p>
      </div>

      <p style="margin: 0; color: #94a3b8; font-size: 12px; line-height: 1.5;">
        If this was you, you can safely disregard this message.
      </p>
    </div>

    <!-- Footer -->
    <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 18px 28px; text-align: center;">
      <p style="margin: 0 0 4px 0; color: #94a3b8; font-size: 12px;">© ${new Date().getFullYear()} SalesBuster AI CRM. All rights reserved.</p>
      <p style="margin: 0; color: #cbd5e1; font-size: 11px;">Sent from info@salesbuster.ai | Automated Security Alert</p>
    </div>

  </div>
</body>
</html>
  `;

  return await sendEmail({
    email,
    subject: `Security Alert: New Sign-in to your SalesBuster CRM Account`,
    message: `Hello ${recipientName},\n\nWe detected a successful sign-in to your SalesBuster CRM account.\n\nAccount: ${email}\nTime: ${formattedTime}\nIP Address: ${clientIp}\nDevice: ${clientDevice}\n\nIf you did not perform this login, please contact support immediately at info@salesbuster.ai.\n\nSalesBuster AI CRM`,
    htmlMessage,
  });
};

/**
 * Sends a password reset or updated credentials alert email
 */
export const sendPasswordResetEmail = async ({
  email,
  name,
  temporaryPassword,
  loginUrl,
}) => {
  const appLoginUrl =
    loginUrl ||
    process.env.FRONTEND_URL ||
    "https://holyminicow.com/kranthi-crm";
  const recipientName = name || email.split("@")[0];

  const htmlMessage = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SalesBuster CRM: Credentials Update</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b;">
  <div style="max-width: 600px; margin: 30px auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.06); border: 1px solid #e2e8f0;">
    
    <!-- Top Header -->
    <div style="background: linear-gradient(135deg, #0ea5e9 0%, #3b82f6 50%, #6366f1 100%); padding: 30px 28px; text-align: center;">
      <h1 style="margin: 0 0 6px 0; color: #ffffff; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">SalesBuster CRM</h1>
      <p style="margin: 0; color: #e0f2fe; font-size: 14px; font-weight: 500;">Account Credentials Notification</p>
    </div>

    <!-- Main Content -->
    <div style="padding: 30px 28px;">
      <h2 style="margin: 0 0 12px 0; color: #0f172a; font-size: 20px; font-weight: 700;">🔐 Your Updated Login Credentials</h2>
      <p style="margin: 0 0 20px 0; color: #475569; font-size: 14px; line-height: 1.6;">
        Hello <strong>${recipientName}</strong>, your login password for SalesBuster CRM has been updated. You can access your workspace using the credentials below:
      </p>

      <!-- Credentials Box -->
      <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
        <h3 style="margin: 0 0 12px 0; color: #15803d; font-size: 14px; font-weight: 700;">Login Credentials</h3>
        
        <div style="background: #ffffff; border: 1px dashed #86efac; border-radius: 8px; padding: 14px 18px; margin-bottom: 12px;">
          <div style="margin-bottom: 8px;">
            <span style="font-size: 11px; color: #64748b; font-weight: 600; text-transform: uppercase;">Login Email:</span>
            <div style="font-size: 15px; font-weight: 700; color: #0f172a; font-family: monospace;">${email}</div>
          </div>
          <div>
            <span style="font-size: 11px; color: #64748b; font-weight: 600; text-transform: uppercase;">Password:</span>
            <div style="font-size: 16px; font-weight: 800; color: #0284c7; font-family: monospace; letter-spacing: 0.5px;">${temporaryPassword}</div>
          </div>
        </div>
      </div>

      <!-- Action Button -->
      <div style="text-align: center; margin-bottom: 24px;">
        <a href="${appLoginUrl}" style="display: inline-block; background: linear-gradient(135deg, #0284c7 0%, #2563eb 100%); color: #ffffff; font-size: 15px; font-weight: 700; text-decoration: none; padding: 13px 30px; border-radius: 10px; box-shadow: 0 4px 12px rgba(37, 99, 235, 0.25);">
          Log In to Workspace →
        </a>
      </div>

      <p style="margin: 0; color: #64748b; font-size: 13px; line-height: 1.5;">
        Please change your password after logging in. If you did not request this update, contact support immediately at <a href="mailto:info@salesbuster.ai" style="color: #0284c7;">info@salesbuster.ai</a>.
      </p>
    </div>

    <!-- Footer -->
    <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 18px 28px; text-align: center;">
      <p style="margin: 0 0 4px 0; color: #94a3b8; font-size: 12px;">© ${new Date().getFullYear()} SalesBuster AI CRM. All rights reserved.</p>
      <p style="margin: 0; color: #cbd5e1; font-size: 11px;">Sent from info@salesbuster.ai | Automated Security Notification</p>
    </div>

  </div>
</body>
</html>
  `;

  return await sendEmail({
    email,
    subject: `SalesBuster CRM: Your Login Credentials Have Been Updated`,
    message: `Hello ${recipientName},\n\nYour SalesBuster CRM credentials have been updated.\n\nLogin URL: ${appLoginUrl}\nEmail: ${email}\nPassword: ${temporaryPassword}\n\nPlease change your password after logging in.\n\nSalesBuster CRM Support: info@salesbuster.ai`,
    htmlMessage,
  });
};
