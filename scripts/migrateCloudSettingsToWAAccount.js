/**
 * Data Migration Script: Organization.whatsappCloudSettings -> WAAccount
 * 
 * Supports:
 *   --dry-run       Preview migration without writing to database
 * 
 * Run:
 *   node scripts/migrateCloudSettingsToWAAccount.js [--dry-run]
 */

import dotenv from "dotenv";
import connectDB from "../configs/db.js";
import { getMasterModels } from "../services/tenantManager.js";

dotenv.config();

export const runMigration = async ({ dryRun = false } = {}) => {
  console.log(`[Migration] Starting Cloud Settings -> WAAccount migration (dryRun=${dryRun})...`);

  await connectDB();
  const { Organization, WAAccount } = getMasterModels();

  const orgs = await Organization.find({
    "whatsappCloudSettings.isConfigured": true,
    "whatsappCloudSettings.phoneNumberId": { $exists: true, $ne: "" },
  }).lean();

  console.log(`[Migration] Found ${orgs.length} organization(s) with configured WhatsApp Cloud settings.`);

  let migratedCount = 0;
  let skippedCount = 0;
  let conflictCount = 0;

  for (const org of orgs) {
    const cloud = org.whatsappCloudSettings;
    const phoneNumberId = cloud.phoneNumberId?.trim();
    const wabaId = cloud.wabaId?.trim();
    const displayPhone = cloud.displayPhoneNumber?.trim() || phoneNumberId;
    const accessTokenEncrypted = cloud.accessTokenEncrypted;

    if (!phoneNumberId || !accessTokenEncrypted) {
      console.warn(`[Migration] Org ${org._id} (${org.name}): missing phoneNumberId or accessTokenEncrypted. Skipping.`);
      skippedCount++;
      continue;
    }

    // Check for existing account by phoneNumberId
    const existing = await WAAccount.findOne({ phoneNumberId });
    if (existing && existing.organizationId.toString() !== org._id.toString()) {
      console.error(
        `[Migration CONFLICT] Phone number ${phoneNumberId} already bound to org ${existing.organizationId}. Cannot overwrite with org ${org._id}.`
      );
      conflictCount++;
      continue;
    }

    const payload = {
      organizationId: org._id,
      userId: null, // Org-level line
      wabaId,
      phoneNumberId,
      displayPhone,
      accessTokenEncrypted,
      status: "connected",
      isOnBizApp: null, // Unknown until verified via Embedded Signup / Meta API
      platformType: "CLOUD_API",
      lastActivityAt: cloud.lastSyncedAt || new Date(),
    };

    if (dryRun) {
      console.log(`[DRY RUN] Would upsert WAAccount for Org ${org._id} (${org.name}):`, {
        phoneNumberId,
        wabaId,
        displayPhone,
      });
      migratedCount++;
    } else {
      await WAAccount.findOneAndUpdate(
        { phoneNumberId },
        { $set: payload },
        { upsert: true, new: true }
      );
      console.log(`[MIGRATED] Upserted WAAccount for Org ${org._id} (${org.name}) -> ${phoneNumberId}`);
      migratedCount++;
    }
  }

  const report = {
    totalFound: orgs.length,
    migrated: migratedCount,
    skipped: skippedCount,
    conflicts: conflictCount,
    dryRun,
  };

  console.log("[Migration Report]:", JSON.stringify(report, null, 2));
  return report;
};

// If run directly from CLI
if (process.argv[1]?.endsWith("migrateCloudSettingsToWAAccount.js")) {
  const isDryRun = process.argv.includes("--dry-run");
  runMigration({ dryRun: isDryRun })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[Migration Error]:", err);
      process.exit(1);
    });
}
