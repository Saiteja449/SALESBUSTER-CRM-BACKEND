import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import { getMasterModels, getTenantModels } from "../services/tenantManager.js";
import { getISTDateBoundaries, resolveDateRange } from "../ai/assistant/dateUtils.js";
import { runSalesManagerAssistant } from "../ai/assistant/aiAssistantService.js";

async function runEval() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB");

  const { Organization } = getMasterModels();
  const org = await Organization.findOne({ tenantDbName: "sb_tenant_infasta_demo_d0234c" });
  if (!org) {
    console.error("Test organization not found!");
    process.exit(1);
  }

  const tenantModels = getTenantModels(org.tenantDbName);
  const user = await tenantModels.User.findOne({ role: { $in: ["sales manager", "admin"] } });

  console.log(`Evaluating with Org: ${org.name}, Manager: ${user?.name || "Admin"}`);

  // Test date boundaries & resolveDateRange
  console.log("\n--- Checking Date Ranges ---");
  const testKeys = ["today", "yesterday", "this_week", "this_month", "last_month", "last_week", "last_7_days", "last_30_days"];
  for (const k of testKeys) {
    const r = resolveDateRange(k);
    console.log(`Key: ${k.padEnd(15)} => Label: ${r.label}, Start: ${r.start.toISOString()}, End: ${r.end.toISOString()}`);
  }

  // Check Leads by Rep
  console.log("\n--- Direct Mongo Lead Counts by Rep ---");
  const repLeads = await tenantModels.Lead.aggregate([
    {
      $group: {
        _id: "$assignedTo",
        count: { $sum: 1 },
      },
    },
  ]);
  console.log("Raw lead counts grouped by assignedTo:", repLeads);

  // Run test questions
  const questions = [
    {
      q: "How many total leads do we have?",
      expectedTool: "get_dashboard_kpis",
      verify: async () => await tenantModels.Lead.countDocuments(),
    },
    {
      q: "Which salesperson has how many leads?",
      expectedTool: "get_salesperson_performance",
      verify: async () => {
        const abhi = await tenantModels.User.findOne({ name: /abhi/i });
        const abhiLeads = await tenantModels.Lead.countDocuments({ assignedTo: abhi?._id.toString() });
        return { abhiLeads };
      },
    },
    {
      q: "Check ABHI's performance",
      expectedTool: "get_salesperson_performance",
      verify: async () => {
        const abhi = await tenantModels.User.findOne({ name: /abhi/i });
        return { abhiId: abhi?._id.toString() };
      },
    },
  ];

  for (const item of questions) {
    console.log(`\n======================================================`);
    console.log(`Question: "${item.q}"`);
    const groundTruth = await item.verify();
    console.log(`Ground truth:`, groundTruth);

    try {
      const result = await runSalesManagerAssistant({
        userMessage: item.q,
        history: [],
        tenantModels,
        organization: org,
        user,
      });
      console.log(`Model Used: ${result.modelUsed}`);
      console.log(`Tools Used: ${JSON.stringify(result.toolsUsed)}`);
      console.log(`Assistant Reply:\n${result.reply}`);
    } catch (err) {
      console.error(`Assistant Error:`, err.message);
    }
  }

  await mongoose.disconnect();
}

runEval().catch(console.error);
