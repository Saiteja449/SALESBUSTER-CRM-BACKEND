/**
 * ============================================================
 * SalesBuster CRM — WhatsApp Stray Sessions Cleanup Script
 * ============================================================
 * Purges legacy, orphan, and unmapped sessions (device_1, device_2,
 * awa_device_1, etc.) from tenant databases so that organizations
 * strictly maintain at most 2 valid connections (Primary & Secondary).
 *
 * Usage:
 *   cd /var/www/SALESBUSTER/SALESBUSTER-CRM-BACKEND
 *   node scripts/cleanupStraySessions.js
 * ============================================================
 */

import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI;
const MASTER_DB_NAME = process.env.MASTER_DB_NAME || "salesbuster_master";

async function cleanup() {
  console.log("\n╔════════════════════════════════════════════════════╗");
  console.log("║    SalesBuster CRM — WhatsApp Sessions Cleanup     ║");
  console.log("╚════════════════════════════════════════════════════╝\n");

  if (!MONGODB_URI) {
    console.error("❌ MONGODB_URI not found in environment.");
    process.exit(1);
  }

  console.log("🔌 Connecting to MongoDB...");
  await mongoose.connect(MONGODB_URI);
  console.log("✅ Connected successfully.\n");

  const masterDb = mongoose.connection.useDb(MASTER_DB_NAME);
  const organizations = await masterDb
    .collection("organizations")
    .find({ status: { $ne: "suspended" } })
    .toArray();

  console.log(`Checking ${organizations.length} active organization(s)...\n`);

  for (const org of organizations) {
    const orgId = org._id.toString();
    const tenantDbName = org.tenantDbName;
    if (!tenantDbName) continue;

    const primarySessionId = `org_${orgId}`;
    const secondarySessionId = `org_${orgId}_device_2`;
    const allowedSessionIds = [primarySessionId, secondarySessionId];

    const tenantDb = mongoose.connection.useDb(tenantDbName);

    // 1. Purge stray sessions from whatsappsessions
    const straySessions = await tenantDb
      .collection("whatsappsessions")
      .find({ sessionId: { $nin: allowedSessionIds } })
      .toArray();

    if (straySessions.length > 0) {
      const strayNames = straySessions.map((s) => s.sessionId);
      await tenantDb.collection("whatsappsessions").deleteMany({
        sessionId: { $in: strayNames },
      });
      console.log(
        `🧹 [${org.name}] Purged ${straySessions.length} stray session(s): ${strayNames.join(", ")}`
      );
    }

    // 2. Purge stray auth states
    const strayAuth = await tenantDb.collection("whatsappauthstates").deleteMany({
      sessionId: { $nin: allowedSessionIds },
    });

    if (strayAuth.deletedCount > 0) {
      console.log(
        `🧹 [${org.name}] Purged ${strayAuth.deletedCount} stray auth keys.`
      );
    }

    // Report remaining valid sessions
    const validSessions = await tenantDb
      .collection("whatsappsessions")
      .find({ sessionId: { $in: allowedSessionIds } })
      .toArray();

    console.log(
      `✅ [${org.name}] Active valid session(s): ${validSessions.map((s) => `${s.sessionId} (${s.connectedPhone || s.status})`).join(" | ") || "None"}\n`
    );
  }

  await mongoose.disconnect();
  console.log("🔌 Disconnected from MongoDB. Done!\n");
  console.log("💡 Run 'pm2 restart all' to restart background WhatsApp workers cleanly.");
}

cleanup().catch((err) => {
  console.error("❌ Cleanup failed:", err);
  mongoose.disconnect().finally(() => process.exit(1));
});
