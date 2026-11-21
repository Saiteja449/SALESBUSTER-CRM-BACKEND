import { MongoClient } from "mongodb";

const targetUri =
  "mongodb://salesbuster_beta_user:salesbusterBeta%402026@127.0.0.1:27017/salesbuster_master_beta?authSource=admin";

async function main() {
  const client = new MongoClient(targetUri);
  await client.connect();
  const dbs = await client.db().admin().listDatabases();
  console.log("==========================================");
  console.log("Local MongoDB Transfer Verification Report");
  console.log("==========================================");

  for (const dbInfo of dbs.databases) {
    if (["admin", "config", "local"].includes(dbInfo.name)) continue;
    const db = client.db(dbInfo.name);
    const cols = await db.listCollections().toArray();
    let totalDocs = 0;
    for (const c of cols) {
      totalDocs += await db.collection(c.name).countDocuments();
    }
    console.log(`- ${dbInfo.name.padEnd(35)}: ${String(cols.length).padStart(2)} collections | ${String(totalDocs).padStart(6)} documents`);
  }
  console.log("==========================================");
  await client.close();
}

main().catch(console.error);
