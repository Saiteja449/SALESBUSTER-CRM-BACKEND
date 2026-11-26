import dotenv from "dotenv";
dotenv.config();

import connectDB from "./configs/db.js";
import { getTenantModels, getMasterModels } from "./services/tenantManager.js";

async function main() {
  await connectDB();

  const { Organization } = getMasterModels();
  const org = await Organization.findOne({ status: "active" });
  if (!org) {
    console.log("No active organization found.");
    process.exit(0);
  }

  const { Lead } = getTenantModels(org.tenantDbName);
  const lead = await Lead.findOne({ name: "Test SLA Lead" });

  if (lead) {
    lead.sla = {
      ...lead.sla,
      enteredNewAt: new Date(Date.now() - 25 * 3600 * 1000),
    };
    await lead.save();
    console.log("Lead backdated by 25h:", lead._id);
  } else {
    console.log("Lead 'Test SLA Lead' not found in tenant:", org.tenantDbName);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});