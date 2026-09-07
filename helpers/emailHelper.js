import nodemailer from "nodemailer";

export const sendEmail = async (options) => {
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: process.env.SMTP_PORT == 465,
      family: 4, // true for 465, false for other ports
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const mailOptions = {
      from:
        process.env.SMTP_FROM ||
        `SalesBuster CRM <${process.env.SMTP_USER || "noreply@salesbuster.com"}>`,
      to: options.email,
      subject: options.subject,
      text: options.message,
      html: options.htmlMessage,
    };

    await transporter.sendMail(mailOptions);
    console.log(`Email sent to ${options.email}`);
    return true;
  } catch (error) {
    console.error("Error sending email:", error);
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
  const formattedAmount = organization.amountPaid != null ? `₹${Number(organization.amountPaid).toLocaleString("en-IN")}` : "Paid";
  const rawPlan = organization.subscriptionPlan || "monthly";
  const formattedPlan = rawPlan.charAt(0).toUpperCase() + rawPlan.slice(1);

  const appLoginUrl = loginUrl || process.env.FRONTEND_URL || "http://localhost:5173/login";

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
            <span style="font-size: 12px; color: #64748b; font-weight: 600; text-transform: uppercase;">Temporary Password:</span>
            <div style="font-size: 16px; font-weight: 800; color: #0284c7; font-family: monospace; letter-spacing: 0.5px;">${temporaryPassword}</div>
          </div>
        </div>

        <p style="margin: 0; font-size: 12px; color: #b45309;">
          ⚠️ <strong>Security Notice:</strong> For security reasons, please change your password immediately after logging into your dashboard.
        </p>
      </div>

      <!-- Action Button -->
      <div style="text-align: center; margin-bottom: 28px;">
        <a href="${appLoginUrl}" style="display: inline-block; background: linear-gradient(135deg, #0284c7 0%, #2563eb 100%); color: #ffffff; font-size: 15px; font-weight: 700; text-decoration: none; padding: 14px 32px; border-radius: 10px; box-shadow: 0 4px 12px rgba(37, 99, 235, 0.25);">
          Log In to SalesBuster Workspace →
        </a>
      </div>

      <p style="margin: 0 0 12px 0; color: #64748b; font-size: 13px; line-height: 1.5;">
        Need to add more user seats or have questions about your subscription? Contact your SalesBuster Account Representative anytime.
      </p>
    </div>

    <!-- Footer -->
    <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 20px 30px; text-align: center;">
      <p style="margin: 0 0 4px 0; color: #94a3b8; font-size: 12px;">© ${new Date().getFullYear()} SalesBuster AI CRM. All rights reserved.</p>
      <p style="margin: 0; color: #cbd5e1; font-size: 11px;">This is an automated onboarding notification.</p>
    </div>

  </div>
</body>
</html>
  `;

  return await sendEmail({
    email: ownerEmail,
    subject: `Welcome to SalesBuster! Your ${organization.name} Workspace is Ready`,
    message: `Welcome to SalesBuster!\n\nYour organization ${organization.name} has been provisioned.\nSeats: ${organization.seats}\nValidity: ${formattedStartDate} to ${formattedEndDate}\nAmount Paid: ${formattedAmount}\n\nLogin URL: ${appLoginUrl}\nEmail: ${ownerEmail}\nTemporary Password: ${temporaryPassword}\n\nPlease change your password upon first login.`,
    htmlMessage,
  });
};
