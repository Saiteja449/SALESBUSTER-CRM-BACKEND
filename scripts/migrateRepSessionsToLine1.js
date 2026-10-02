import dotenv from "dotenv";
import { getMasterModels, getTenantModels } from "../services/tenantManager.js";
import connectDB from "../config/db.js";

dotenv.config();

const runMigration = async () => {
  await connectDB();
  const { Organization } = getMasterModels();
  const organizations = await Organization.find({ status: { $ne: "suspended" } });

  for (const organization of organizations) {
    if (!organization.tenantDbName) continue;
    const models = getTenantModels(organization.tenantDbName);
    const legacyPattern = new RegExp(`^org_${organization._id}_user_[a-fA-F0-9]{24}$`);
    const sessions = await models.WhatsAppSession.find({ sessionId: { $regex: legacyPattern } });

    for (const session of sessions) {
      const newSessionId = `${session.sessionId}_line_1`;
      const exists = await models.WhatsAppSession.exists({ sessionId: newSessionId });
      if (!exists) {
        await models.WhatsAppSession.updateOne(
          { _id: session._id },
          { $set: { sessionId: newSessionId, lineNumber: 1, organizationId: organization._id } },
        );
      }
    }

    const authRecords = await models.WhatsAppAuthState.find({ sessionId: { $regex: legacyPattern } });
    for (const auth of authRecords) {
      const newSessionId = `${auth.sessionId}_line_1`;
      const exists = await models.WhatsAppAuthState.exists({ sessionId: newSessionId, type: auth.type, keyId: auth.keyId });
      if (!exists) await models.WhatsAppAuthState.updateOne({ _id: auth._id }, { $set: { sessionId: newSessionId } });
    }
    console.log(`[WhatsApp migration] Completed ${organization.tenantDbName}`);
  }
  process.exit(0);
};

runMigration().catch((error) => {
  console.error("[WhatsApp migration] Failed:", error);
  process.exit(1);
});
