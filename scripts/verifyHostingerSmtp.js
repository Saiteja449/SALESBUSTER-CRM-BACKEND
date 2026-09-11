import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Load environment variables from .env
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import {
  verifySmtpConnection,
  sendEmail,
  sendTenantWelcomeEmail,
  sendSalesPersonWelcomeEmail,
  sendLoginAlertEmail,
} from "../helpers/emailHelper.js";

async function main() {
  console.log("=================================================");
  console.log("   SalesBuster CRM: Hostinger SMTP Verification  ");
  console.log("=================================================");
  console.log(`SMTP Host:    ${process.env.SMTP_HOST}`);
  console.log(`SMTP Port:    ${process.env.SMTP_PORT}`);
  console.log(`SMTP User:    ${process.env.SMTP_USER}`);
  console.log(`SMTP From:    ${process.env.SMTP_FROM}`);
  console.log("-------------------------------------------------");

  console.log("\n[1/2] Verifying SMTP Connection Handshake...");
  const connResult = await verifySmtpConnection();
  if (!connResult.success) {
    console.error("❌ SMTP Verification Failed!");
    console.error(`Reason: ${connResult.message} (Code: ${connResult.code || "N/A"})`);
    process.exit(1);
  }
  console.log("✅ SMTP Connection & Authentication Successful!");

  // Check if a recipient email was passed as a CLI argument
  const targetEmail = process.argv[2];
  if (!targetEmail) {
    console.log("\n[2/2] No test recipient provided.");
    console.log("To send live test emails, run:");
    console.log("  node scripts/verifyHostingerSmtp.js your-email@example.com\n");
    console.log("=================================================");
    console.log("   Hostinger SMTP configuration is READY!       ");
    console.log("=================================================");
    return;
  }

  console.log(`\n[2/2] Sending Test Emails to: ${targetEmail}...`);

  // 1. Test Welcome & Credentials Email
  console.log("  -> Sending Tenant Welcome & Credentials Email...");
  const welcomeSent = await sendTenantWelcomeEmail({
    organization: {
      name: "Demo Enterprise",
      seats: 10,
      subscriptionPlan: "annual",
      subscriptionStartDate: new Date(),
      subscriptionEndDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      amountPaid: 49999,
    },
    ownerEmail: targetEmail,
    temporaryPassword: "DemoPassword#2026",
    loginUrl: process.env.FRONTEND_URL || "https://crm.salesbuster.ai/login",
  });

  if (welcomeSent) {
    console.log("  ✅ Welcome & Credentials Email dispatched successfully!");
  } else {
    console.error("  ❌ Failed to dispatch Welcome & Credentials Email.");
  }

  // 2. Test Security Login Alert Email
  console.log("  -> Sending Security Login Alert Email...");
  const alertSent = await sendLoginAlertEmail({
    email: targetEmail,
    name: "Admin User",
    ipAddress: "127.0.0.1",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0",
    loginTime: new Date(),
  });

  if (alertSent) {
    console.log("  ✅ Security Login Alert Email dispatched successfully!");
  } else {
    console.error("  ❌ Failed to dispatch Security Login Alert Email.");
  }

  console.log("\n=================================================");
  console.log("   Hostinger SMTP Verification Complete!         ");
  console.log("=================================================");
  process.exit(0);
}

main().catch((err) => {
  console.error("Unexpected error during verification:", err);
  process.exit(1);
});
